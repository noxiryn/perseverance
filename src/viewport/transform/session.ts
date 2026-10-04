/**
 * Transform session: bounding box with 8 handles, rotation zones, pivot, move/scale/rotate/skew
 * gestures. Used by the move tool's "Show Transform Controls" (immediate mode — one history step
 * per gesture), Edit ▸ Free Transform (session mode — Enter commits / Esc cancels) and
 * Select ▸ Transform Selection (transforms the selection mask).
 *
 * All gestures produce a document-space affine delta D relative to the session start; every
 * target's matrix is D · start, decomposed back into a layer Transform.
 */
import type { Document, ID, Point, Selection, Transform } from '../../core/types';
import type { ToolPointerEvent } from '../../registry';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctx2d } from '../../core/canvas';
import { isTransformable } from '../../core/document';
import { pointInPolygon } from '../../core/geometry';
import { viewport } from '../../editor/viewport';
import { selectionFromCanvas, setSelection } from '../../editor/selection';
import { activeSession, useEditor } from '../../state/editor';
import {
  about,
  apply,
  axisAngle,
  decompose,
  fromTransform,
  identity,
  invert,
  isAxisAligned,
  isIdentity,
  mul,
  normAngle,
  rotate,
  scale,
  translate,
  type Affine,
} from '../math/affine';
import { layerFrame, transformableLeaves } from '../layers';
import { MaskFollower } from '../maskFollow';
import { collectSnapTargets, clearSmartGuides, snapPoint, snapRect, type SnapTargets } from '../snap';
import { selectionOutline, drawAnts } from '../outline';
import { drawHandle, drawLabel, drawPivot, resizeCursorForAngle, rotateCursor } from '../draw';
import { ACCENT, docToScreenMatrix, fmtPx } from '../state';

export type HandleId = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l';

export type Hit =
  | { kind: 'handle'; handle: HandleId }
  | { kind: 'pivot' }
  | { kind: 'inside' }
  | { kind: 'rotate'; handle: HandleId }
  | { kind: 'none' };

const HANDLE_UV: Record<HandleId, [number, number]> = {
  tl: [0, 0],
  t: [0.5, 0],
  tr: [1, 0],
  r: [1, 0.5],
  br: [1, 1],
  b: [0.5, 1],
  bl: [0, 1],
  l: [0, 0.5],
};
const OPPOSITE: Record<HandleId, HandleId> = { tl: 'br', t: 'b', tr: 'bl', r: 'l', br: 'tl', b: 't', bl: 'tr', l: 'r' };
const CORNERS: HandleId[] = ['tl', 'tr', 'br', 'bl'];
const SIDES: HandleId[] = ['t', 'r', 'b', 'l'];

export interface TransformTarget {
  id: ID;
  w: number;
  h: number;
  start: Affine;
  startTransform: Transform;
}

interface Gesture {
  kind: 'scale' | 'rotate' | 'move' | 'skew' | 'pivot';
  handle?: HandleId;
  D0: Affine;
  pivot0: Point;
  q0: Point;
  F: Affine;
  rot0: number;
  targets?: SnapTargets;
  moved: boolean;
  last: Point;
}

/** Last committed transform in frame-local terms (for Edit ▸ Transform ▸ Again). */
let lastLocalDelta: Affine | null = null;
export function lastTransformDelta(): Affine | null {
  return lastLocalDelta;
}

export class TransformSession {
  readonly kind: 'layers' | 'selection';
  readonly mode: 'immediate' | 'session';
  readonly docId: ID;
  readonly baseEntryId: ID;
  targets: TransformTarget[] = [];
  fw = 1;
  fh = 1;
  frameStart: Affine = identity();
  D: Affine = identity();
  pivot: Point = { x: 0, y: 0 };
  proportionalDefault = true;
  /** Side handles skew instead of scale (Edit ▸ Transform ▸ Skew). */
  skewMode = false;
  selection: Selection | null = null;
  gesture: Gesture | null = null;
  previewed = false;
  label: string;
  /** Listeners notified on every change (options bar). */
  onChange: (() => void) | null = null;
  /** Ids the session was created for (groups included) — their masks follow the transform. */
  rootIds: ID[] = [];
  /** In-session undo (Ctrl+Z while transforming). */
  private undoStack: { D: Affine; pivot: Point }[] = [];
  private follower: MaskFollower | null | undefined = undefined;

  private constructor(kind: 'layers' | 'selection', mode: 'immediate' | 'session', docId: ID, baseEntryId: ID, label: string) {
    this.kind = kind;
    this.mode = mode;
    this.docId = docId;
    this.baseEntryId = baseEntryId;
    this.label = label;
  }

  /* ---------------- construction ---------------- */

  /**
   * Session over layers (groups expand to their transformable children). Returns a string reason
   * when nothing can be transformed.
   */
  static forLayers(doc: Document, ids: ID[], mode: 'immediate' | 'session', label?: string): TransformSession | string {
    const s = activeSession();
    if (!s) return 'Open a document first.';
    const { movable, locked, other } = transformableLeaves(doc, ids);
    if (!movable.length) {
      if (locked.length) return 'The layer is locked. Unlock its position to transform it.';
      if (other.length) return 'Fill and adjustment layers cover the whole canvas and cannot be transformed.';
      return 'Select a pixel, text, shape layer or group to transform.';
    }
    const ses = new TransformSession('layers', mode, doc.id, s.history.entries[s.history.index].id, label ?? (mode === 'session' ? 'Free Transform' : 'Transform'));
    ses.rootIds = [...ids];
    let allRasterText = true;
    for (const id of movable) {
      const l = doc.layers[id];
      if (!isTransformable(l)) continue;
      const f = layerFrame(l);
      ses.targets.push({ id, w: f.w, h: f.h, start: f.m, startTransform: { ...l.transform } });
      if (l.type === 'shape') allRasterText = false;
    }
    ses.proportionalDefault = allRasterText;
    const single = ses.targets.length === 1 && ids.length === 1 && ids[0] === ses.targets[0].id;
    if (single) {
      const t = ses.targets[0];
      ses.fw = t.w;
      ses.fh = t.h;
      ses.frameStart = t.start;
    } else {
      // Axis-aligned union of the targets' transformed boxes.
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const t of ses.targets) {
        for (const [u, v] of [
          [0, 0],
          [t.w, 0],
          [t.w, t.h],
          [0, t.h],
        ]) {
          const p = apply(t.start, { x: u, y: v });
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      }
      ses.fw = Math.max(1, maxX - minX);
      ses.fh = Math.max(1, maxY - minY);
      ses.frameStart = translate(minX, minY);
    }
    ses.pivot = apply(ses.frameStart, { x: ses.fw / 2, y: ses.fh / 2 });
    return ses;
  }

  /** Session transforming the selection outline (Select ▸ Transform Selection). */
  static forSelection(doc: Document): TransformSession | string {
    const s = activeSession();
    if (!s) return 'Open a document first.';
    if (!doc.selection) return 'There is no selection to transform.';
    const ses = new TransformSession('selection', 'session', doc.id, s.history.entries[s.history.index].id, 'Transform Selection');
    const b = doc.selection.bounds;
    ses.selection = doc.selection;
    ses.fw = Math.max(1, b.width);
    ses.fh = Math.max(1, b.height);
    ses.frameStart = translate(b.x, b.y);
    ses.pivot = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    ses.proportionalDefault = false;
    return ses;
  }

  /* ---------------- geometry ---------------- */

  frameMatrix(): Affine {
    return mul(this.D, this.frameStart);
  }

  handleDoc(h: HandleId, F = this.frameMatrix()): Point {
    const [u, v] = HANDLE_UV[h];
    return apply(F, { x: u * this.fw, y: v * this.fh });
  }

  cornersDoc(F = this.frameMatrix()): Point[] {
    return CORNERS.map((c) => this.handleDoc(c, F));
  }

  private toScreen(p: Point): Point {
    return viewport.docToScreen(p);
  }

  /** Decomposed frame transform (for the options bar). */
  frameTransform(): Transform {
    return decompose(this.frameMatrix(), this.fw, this.fh, this.kind === 'layers' && this.targets.length === 1 ? this.targets[0].startTransform : undefined);
  }

  /* ---------------- hit testing ---------------- */

  hitTest(screen: Point): Hit {
    const F = this.frameMatrix();
    const sc = this.cornersDoc(F).map((p) => this.toScreen(p));
    const near = (p: Point, r: number) => Math.hypot(p.x - screen.x, p.y - screen.y) <= r;
    if (this.mode === 'session' && near(this.toScreen(this.pivot), 7)) return { kind: 'pivot' };
    for (const c of CORNERS) if (near(this.toScreen(this.handleDoc(c, F)), 7)) return { kind: 'handle', handle: c };
    const sideLenOk = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) > 26;
    const edges: [HandleId, Point, Point][] = [
      ['t', sc[0], sc[1]],
      ['r', sc[1], sc[2]],
      ['b', sc[2], sc[3]],
      ['l', sc[3], sc[0]],
    ];
    for (const [h, a, b] of edges) {
      if (sideLenOk(a, b) && near(this.toScreen(this.handleDoc(h, F)), 7)) return { kind: 'handle', handle: h };
    }
    if (pointInPolygon(screen, sc)) {
      // Edges are grabbable from just inside too.
      for (const [h, a, b] of edges) if (sideLenOk(a, b) && distToSegment(screen, a, b) <= 3) return { kind: 'handle', handle: h };
      return { kind: 'inside' };
    }
    for (const [h, a, b] of edges) if (distToSegment(screen, a, b) <= 4) return { kind: 'handle', handle: h };
    // Rotation zone outside the box.
    let best: HandleId = 'tl';
    let bestD = Infinity;
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(sc[i].x - screen.x, sc[i].y - screen.y);
      if (d < bestD) {
        bestD = d;
        best = CORNERS[i];
      }
    }
    const distBox = Math.min(...edges.map(([, a, b]) => distToSegment(screen, a, b)));
    if (this.mode === 'session' || distBox <= 26) return { kind: 'rotate', handle: best };
    return { kind: 'none' };
  }

  cursorFor(hit: Hit, mods: { ctrlKey?: boolean } = {}): string | null {
    const F = this.frameMatrix();
    const c = apply(F, { x: this.fw / 2, y: this.fh / 2 });
    const sc = this.toScreen(c);
    switch (hit.kind) {
      case 'pivot':
        return 'move';
      case 'inside':
        return 'move';
      case 'handle': {
        const p = this.toScreen(this.handleDoc(hit.handle, F));
        if ((mods.ctrlKey || this.skewMode) && SIDES.includes(hit.handle)) {
          // skew along the edge direction
          const [a, b] = sideEnds(hit.handle);
          const pa = this.toScreen(this.handleDoc(a, F));
          const pb = this.toScreen(this.handleDoc(b, F));
          return resizeCursorForAngle((Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI);
        }
        return resizeCursorForAngle((Math.atan2(p.y - sc.y, p.x - sc.x) * 180) / Math.PI);
      }
      case 'rotate': {
        const p = this.toScreen(this.handleDoc(hit.handle, F));
        const ang = (Math.atan2(p.y - sc.y, p.x - sc.x) * 180) / Math.PI;
        return rotateCursor(ang + 135);
      }
      default:
        return null;
    }
  }

  /* ---------------- gestures ---------------- */

  begin(hit: Hit, e: ToolPointerEvent): boolean {
    if (hit.kind === 'none') return false;
    const q = { x: e.docX, y: e.docY };
    const F = this.frameMatrix();
    const g: Gesture = {
      kind: 'move',
      D0: { ...this.D },
      pivot0: { ...this.pivot },
      q0: q,
      F,
      rot0: decompose(F, this.fw, this.fh).rotation,
      moved: false,
      last: q,
    };
    if (hit.kind === 'pivot') g.kind = 'pivot';
    else if (hit.kind === 'rotate') g.kind = 'rotate';
    else if (hit.kind === 'handle') {
      g.handle = hit.handle;
      g.kind = (e.ctrlKey || this.skewMode) && SIDES.includes(hit.handle) ? 'skew' : 'scale';
    }
    const doc = activeSession()?.doc;
    if (doc && (g.kind === 'move' || g.kind === 'scale' || g.kind === 'pivot')) {
      g.targets = collectSnapTargets(doc, { exclude: new Set(this.targets.map((t) => t.id)) });
    }
    this.gesture = g;
    return true;
  }

  move(e: ToolPointerEvent) {
    const g = this.gesture;
    if (!g) return;
    let q = { x: e.docX, y: e.docY };
    if (!g.moved) {
      const s0 = this.toScreen(g.q0);
      if (Math.hypot(e.screenX - s0.x, e.screenY - s0.y) < 2) return;
      g.moved = true;
      this.pushUndo(g.D0, g.pivot0);
    }
    g.last = q;
    const F = g.F;
    const Finv = invert(F);
    let G: Affine = identity();
    switch (g.kind) {
      case 'pivot': {
        let p = q;
        if (g.targets) {
          // snap pivot to handles/center as well as the usual targets
          const extra: SnapTargets = { x: [...g.targets.x], y: [...g.targets.y] };
          for (const h of [...CORNERS, ...SIDES]) {
            const hp = this.handleDoc(h, F);
            extra.x.push({ v: hp.x, lo: hp.y, hi: hp.y, kind: 'layer' });
            extra.y.push({ v: hp.y, lo: hp.x, hi: hp.x, kind: 'layer' });
          }
          const c = apply(F, { x: this.fw / 2, y: this.fh / 2 });
          extra.x.push({ v: c.x, lo: c.y, hi: c.y, kind: 'layer' });
          extra.y.push({ v: c.y, lo: c.x, hi: c.x, kind: 'layer' });
          const s = snapPoint(p, { targets: extra });
          p = { x: s.x, y: s.y };
        }
        this.pivot = p;
        this.changed(false);
        return;
      }
      case 'move': {
        let dx = q.x - g.q0.x;
        let dy = q.y - g.q0.y;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (g.targets) {
          const pts = this.cornersDoc(F);
          const xs = pts.map((p) => p.x);
          const ys = pts.map((p) => p.y);
          const r = { x: Math.min(...xs) + dx, y: Math.min(...ys) + dy, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
          const s = snapRect(r, { targets: g.targets, axes: { x: !e.shiftKey || dx !== 0, y: !e.shiftKey || dy !== 0 } });
          dx += s.dx;
          dy += s.dy;
        }
        G = translate(dx, dy);
        break;
      }
      case 'rotate': {
        const p = g.pivot0;
        const a0 = Math.atan2(g.q0.y - p.y, g.q0.x - p.x);
        const a1 = Math.atan2(q.y - p.y, q.x - p.x);
        let deg = ((a1 - a0) * 180) / Math.PI;
        if (e.shiftKey) {
          const target = Math.round((g.rot0 + deg) / 15) * 15;
          deg = target - g.rot0;
        }
        G = about(p, rotate(deg));
        break;
      }
      case 'scale': {
        const h = g.handle!;
        const axisAligned = isAxisAligned(F, 1e-4);
        if (axisAligned && g.targets) {
          const [u, v] = HANDLE_UV[h];
          const s = snapPoint(q, { targets: g.targets, axes: { x: u !== 0.5, y: v !== 0.5 } });
          q = { x: s.x, y: s.y };
        } else clearSmartGuides();
        const uq = apply(Finv, q);
        const [hu, hv] = HANDLE_UV[h];
        const h0 = { x: hu * this.fw, y: hv * this.fh };
        let a: Point;
        if (e.altKey) a = apply(Finv, g.pivot0);
        else {
          const [ou, ov] = HANDLE_UV[OPPOSITE[h]];
          a = { x: ou * this.fw, y: ov * this.fh };
        }
        const isCorner = CORNERS.includes(h);
        const affectsX = hu !== 0.5;
        const affectsY = hv !== 0.5;
        const dxh = h0.x - a.x;
        const dyh = h0.y - a.y;
        let kx = affectsX && Math.abs(dxh) > 1e-9 ? (uq.x - a.x) / dxh : 1;
        let ky = affectsY && Math.abs(dyh) > 1e-9 ? (uq.y - a.y) / dyh : 1;
        const proportional = this.proportionalDefault !== e.shiftKey;
        if (proportional) {
          if (isCorner) {
            // project onto the diagonal from the anchor to the handle
            const len2 = dxh * dxh + dyh * dyh || 1;
            const k = ((uq.x - a.x) * dxh + (uq.y - a.y) * dyh) / len2;
            kx = ky = k;
          } else if (affectsX) ky = Math.abs(kx) * Math.sign(ky || 1);
          else kx = Math.abs(ky) * Math.sign(kx || 1);
        }
        kx = clampScale(kx);
        ky = clampScale(ky);
        const local = about(a, scale(kx, ky));
        G = mul(mul(F, local), Finv);
        break;
      }
      case 'skew': {
        const h = g.handle!;
        const uq = apply(Finv, q);
        const [hu, hv] = HANDLE_UV[h];
        const h0 = { x: hu * this.fw, y: hv * this.fh };
        let a: Point;
        if (e.altKey) a = apply(Finv, g.pivot0);
        else {
          const [ou, ov] = HANDLE_UV[OPPOSITE[h]];
          a = { x: ou * this.fw, y: ov * this.fh };
        }
        let K: Affine;
        if (h === 't' || h === 'b') {
          const dy = h0.y - a.y || 1;
          const s = (uq.x - h0.x) / dy;
          K = { a: 1, b: 0, c: s, d: 1, e: 0, f: 0 };
        } else {
          const dx = h0.x - a.x || 1;
          const s = (uq.y - h0.y) / dx;
          K = { a: 1, b: s, c: 0, d: 1, e: 0, f: 0 };
        }
        G = mul(mul(F, about(a, K)), Finv);
        break;
      }
    }
    this.D = mul(G, g.D0);
    this.pivot = apply(G, g.pivot0);
    this.changed(true);
  }

  end(): boolean {
    const g = this.gesture;
    this.gesture = null;
    clearSmartGuides();
    this.changed(false);
    return !!g?.moved;
  }

  /** Nudge the whole box (arrow keys during a session). */
  nudge(dx: number, dy: number) {
    this.pushUndo();
    const G = translate(dx, dy);
    this.D = mul(G, this.D);
    this.pivot = apply(G, this.pivot);
    this.changed(true);
  }

  /** Apply values typed in the options bar (any subset). */
  setFields(v: { x?: number; y?: number; sx?: number; sy?: number; rotation?: number; skew?: number }) {
    this.pushUndo();
    const F = this.frameMatrix();
    const pl = apply(invert(F), this.pivot);
    const cur = this.frameTransform();
    const next: Transform = {
      ...cur,
      scaleX: v.sx !== undefined ? clampScale(v.sx) : cur.scaleX,
      scaleY: v.sy !== undefined ? clampScale(v.sy) : cur.scaleY,
      rotation: v.rotation !== undefined ? normAngle(v.rotation) : cur.rotation,
      skewX: v.skew !== undefined ? Math.max(-85, Math.min(85, v.skew)) : (cur.skewX ?? 0),
    };
    let F2 = fromTransform(next, this.fw, this.fh);
    // keep the pivot where it is
    const p2 = apply(F2, pl);
    F2 = mul(translate(this.pivot.x - p2.x, this.pivot.y - p2.y), F2);
    // move pivot to typed X/Y
    if (v.x !== undefined || v.y !== undefined) {
      const tx = (v.x ?? this.pivot.x) - this.pivot.x;
      const ty = (v.y ?? this.pivot.y) - this.pivot.y;
      F2 = mul(translate(tx, ty), F2);
      this.pivot = { x: this.pivot.x + tx, y: this.pivot.y + ty };
    }
    const G = mul(F2, invert(F));
    this.D = mul(G, this.D);
    this.changed(true);
  }

  /** Flip the frame around the pivot (handy in a session). */
  flip(horizontal: boolean) {
    this.pushUndo();
    const F = this.frameMatrix();
    const pl = apply(invert(F), this.pivot);
    const local = about(pl, horizontal ? scale(-1, 1) : scale(1, -1));
    const G = mul(mul(F, local), invert(F));
    this.D = mul(G, this.D);
    this.changed(true);
  }

  /** Apply an arbitrary frame-local delta (used by Transform Again). */
  applyLocal(L: Affine) {
    const F = this.frameMatrix();
    const G = mul(mul(F, L), invert(F));
    this.D = mul(G, this.D);
    this.pivot = apply(G, this.pivot);
    this.changed(true);
  }

  isIdentity(): boolean {
    return isIdentity(this.D, 1e-7);
  }

  private pushUndo(D: Affine = this.D, pivot: Point = this.pivot) {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && isIdentity(mul(invert(last.D), D), 1e-9) && last.pivot.x === pivot.x && last.pivot.y === pivot.y) return;
    this.undoStack.push({ D: { ...D }, pivot: { ...pivot } });
    if (this.undoStack.length > 100) this.undoStack.shift();
  }

  /** Step back one gesture inside the session. Returns false when there is nothing to undo. */
  undoStep(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.gesture = null;
    this.D = prev.D;
    this.pivot = prev.pivot;
    this.changed(true);
    return true;
  }

  private changed(geometry: boolean) {
    if (geometry && this.kind === 'layers') this.applyPreview();
    viewport.requestOverlay();
    this.onChange?.();
  }

  /** Push the current delta into the document as a live preview (layers only). */
  applyPreview() {
    if (this.kind !== 'layers') return;
    const s = activeSession();
    if (!s || s.doc.id !== this.docId) return;
    const D = this.D;
    const targets = this.targets;
    if (this.follower === undefined) this.follower = MaskFollower.forLayers(s.doc, this.rootIds.length ? this.rootIds : targets.map((t) => t.id));
    const masks = this.follower ? this.follower.update(D) : null;
    const reshape = !isTranslation(D);
    useEditor.getState().preview((d) => {
      for (const t of targets) {
        const l = d.layers[t.id];
        if (!l || !isTransformable(l)) continue;
        const tr = decompose(mul(D, t.start), t.w, t.h, t.startTransform);
        if (l.type === 'shape' && reshape && Math.abs(tr.skewX ?? 0) < 1e-6) {
          // Vector shapes keep crisp geometry and constant stroke width: bake the scale into the box.
          const w = Math.max(0.5, Math.abs(tr.scaleX) * t.w);
          const h = Math.max(0.5, Math.abs(tr.scaleY) * t.h);
          const cx = tr.x + t.w / 2;
          const cy = tr.y + t.h / 2;
          l.shape.width = w;
          l.shape.height = h;
          l.transform = { ...tr, x: cx - w / 2, y: cy - h / 2, scaleX: Math.sign(tr.scaleX) || 1, scaleY: Math.sign(tr.scaleY) || 1, skewX: 0 };
        } else l.transform = tr;
      }
      masks?.(d);
    });
    this.previewed = true;
  }

  /** Commit to history. Returns false when nothing changed. */
  commit(): boolean {
    this.gesture = null;
    clearSmartGuides();
    const s = activeSession();
    if (!s || s.doc.id !== this.docId) return false;
    if (this.isIdentity()) {
      if (this.previewed) useEditor.getState().cancelPreview();
      return false;
    }
    lastLocalDelta = mul(mul(invert(this.frameStart), this.D), this.frameStart);
    if (this.kind === 'layers') {
      this.applyPreview();
      useEditor.getState().commit(this.label);
      return true;
    }
    // selection: re-render the mask under D
    const sel = this.selection;
    if (!sel) return false;
    const src = bitmaps.tryGet(sel.bitmapId);
    if (!src) return false;
    const doc = s.doc;
    const c = createCanvas(doc.width, doc.height);
    const ctx = ctx2d(c);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const D = this.D;
    ctx.setTransform(D.a, D.b, D.c, D.d, D.e, D.f);
    ctx.drawImage(src, 0, 0);
    let shape: Selection['shape'] = null;
    if (sel.shape && isAxisAligned(D, 1e-6)) {
      const r = sel.shape.rect;
      const p0 = apply(D, { x: r.x, y: r.y });
      const p1 = apply(D, { x: r.x + r.width, y: r.y + r.height });
      shape = {
        type: sel.shape.type,
        rect: { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), width: Math.abs(p1.x - p0.x), height: Math.abs(p1.y - p0.y) },
      };
    }
    const next = selectionFromCanvas(c, shape);
    setSelection(next, this.label);
    return true;
  }

  cancel() {
    this.gesture = null;
    clearSmartGuides();
    const s = activeSession();
    if (this.previewed && s && s.doc.id === this.docId) useEditor.getState().cancelPreview();
    this.previewed = false;
    viewport.requestOverlay();
  }

  /* ---------------- drawing ---------------- */

  render(ctx: CanvasRenderingContext2D, opts: { handles?: boolean } = {}) {
    const F = this.frameMatrix();
    if (this.kind === 'selection' && this.selection) {
      const path = selectionOutline(this.selection);
      if (path) drawAnts(ctx, path, mul(docToScreenMatrix(), this.D));
    }
    const sc = this.cornersDoc(F).map((p) => this.toScreen(p));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sc[0].x, sc[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(sc[i].x, sc[i].y);
    ctx.closePath();
    const aligned = Math.abs(sc[0].y - sc[1].y) < 0.01 && Math.abs(sc[0].x - sc[3].x) < 0.01;
    if (aligned) {
      ctx.beginPath();
      const x0 = Math.round(Math.min(sc[0].x, sc[2].x)) + 0.5;
      const y0 = Math.round(Math.min(sc[0].y, sc[2].y)) + 0.5;
      const x1 = Math.round(Math.max(sc[0].x, sc[2].x)) - 0.5;
      const y1 = Math.round(Math.max(sc[0].y, sc[2].y)) - 0.5;
      ctx.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
    ctx.restore();
    if (opts.handles !== false) {
      const sideLen = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
      ctx.save();
      for (const c of CORNERS) drawHandle(ctx, this.toScreen(this.handleDoc(c, F)));
      const pairs: [HandleId, Point, Point][] = [
        ['t', sc[0], sc[1]],
        ['r', sc[1], sc[2]],
        ['b', sc[2], sc[3]],
        ['l', sc[3], sc[0]],
      ];
      for (const [h, a, b] of pairs) if (sideLen(a, b) > 26) drawHandle(ctx, this.toScreen(this.handleDoc(h, F)));
      ctx.restore();
      if (this.mode === 'session') drawPivot(ctx, this.toScreen(this.pivot));
    }
    // live readout
    const g = this.gesture;
    if (g?.moved) {
      const at = this.toScreen(g.last);
      const t = this.frameTransform();
      if (g.kind === 'rotate') drawLabel(ctx, `${fmtPx(normAngle(t.rotation))}°`, at);
      else if (g.kind === 'move') {
        const c0 = apply(g.F, { x: 0, y: 0 });
        const c1 = apply(F, { x: 0, y: 0 });
        drawLabel(ctx, [`ΔX: ${fmtPx(c1.x - c0.x)} px`, `ΔY: ${fmtPx(c1.y - c0.y)} px`], at);
      } else if (g.kind === 'scale') {
        const w = Math.hypot(F.a, F.b) * this.fw;
        const h = Math.hypot(F.c, F.d) * this.fh;
        drawLabel(ctx, [`W: ${fmtPx(w)} px`, `H: ${fmtPx(h)} px`], at);
      } else if (g.kind === 'skew') {
        drawLabel(ctx, `Skew: ${fmtPx(t.skewX ?? 0)}°`, at);
      }
    }
  }
}

function sideEnds(h: HandleId): [HandleId, HandleId] {
  switch (h) {
    case 't':
      return ['tl', 'tr'];
    case 'b':
      return ['bl', 'br'];
    case 'l':
      return ['tl', 'bl'];
    default:
      return ['tr', 'br'];
  }
}

function isTranslation(m: Affine): boolean {
  return Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.d - 1) < 1e-9;
}

function clampScale(k: number): number {
  if (!isFinite(k)) return 1;
  if (Math.abs(k) < 0.001) return k < 0 ? -0.001 : 0.001;
  return Math.max(-1000, Math.min(1000, k));
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export { axisAngle };
