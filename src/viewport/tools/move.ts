/**
 * Move tool (V): drag layers (groups move children; locks respected; Shift constrains; Alt-drag
 * duplicates; Ctrl toggles auto-select), rubber-band layer selection on empty canvas with
 * auto-select, smart-guide snapping, linked masks follow, arrow-key nudge, transform controls
 * (scale/rotate handles), and routing for an active Free Transform session (Enter / Esc /
 * Ctrl+Z / arrows). Guide dragging is routed by the viewport before the tool sees the event.
 */
import { Move } from 'lucide-react';
import type { Document, ID, Layer, Point, Rect, Transform } from '../../core/types';
import type { ToolDef, ToolPointerEvent } from '../../registry';
import { insertLayerDraft, isEffectivelyVisible, isTransformable } from '../../core/document';
import { pointInPolygon } from '../../core/geometry';
import { viewport } from '../../editor/viewport';
import { activeSession, toolOptions, useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { matchShortcut } from '../../ui/shortcuts';
import { TransformSession, type Hit } from '../transform/session';
import { activeTransform, cancelTransform, commitTransform } from '../transform/controller';
import { cloneLayerTree, layerCorners, layerFrame, layersTopDown, pickLayer, safeBounds, topGroupOf, topLevelIds, transformableLeaves } from '../layers';
import { clearSmartGuides, collectSnapTargets, snapRect, type SnapTargets } from '../snap';
import { MaskFollower } from '../maskFollow';
import { translate } from '../math/affine';
import { drawLabel, strokePoly } from '../draw';
import { ACCENT, fmtPx, isTemporarilySuspended, toastOnce, vpState } from '../state';
import { nudgeLayers } from './moveOps';
import { MoveOptionsBar } from '../options/MoveOptions';

export const MOVE_DEFAULTS = { autoSelect: false, autoSelectTarget: 'layer' as 'layer' | 'group' };

interface MoveDrag {
  kind: 'move';
  q0: Point;
  screen0: Point;
  moved: boolean;
  selection: ID[];
  leaves: ID[];
  starts: Map<ID, Transform>;
  bounds: Rect | null;
  targets: SnapTargets | null;
  duplicate: boolean;
  duplicated: boolean;
  cloneRoots: ID[];
  follower: MaskFollower | null;
  dx: number;
  dy: number;
  last: Point;
}

interface TransformDrag {
  kind: 'transform';
  session: TransformSession;
  persistent: boolean;
}

interface BandDrag {
  kind: 'band';
  a: Point;
  b: Point;
  screen0: Point;
  moved: boolean;
  additive: boolean;
  hits: ID[];
}

/** A press that cannot move anything: the explanation is shown only once the user drags. */
interface BlockedDrag {
  kind: 'blocked';
  screen0: Point;
  message: string;
}

let drag: MoveDrag | TransformDrag | BandDrag | BlockedDrag | null = null;

/* ---------------- transform controls cache ---------------- */

let controls: { key: string; doc: Document; session: TransformSession | null } | null = null;

function selectedIds(): ID[] {
  const s = activeSession();
  if (!s) return [];
  return s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
}

/** Selected layers that are visible (transform controls ignore hidden layers). */
function controlIds(doc: Document): ID[] {
  return selectedIds().filter((id) => isEffectivelyVisible(doc, id));
}

/** Transform-controls session for the current layer selection (cached per doc state). */
function controlsSession(): TransformSession | null {
  const s = activeSession();
  if (!s || !useUI.getState().view.transformControls) return null;
  const ids = controlIds(s.doc);
  // Sizes are part of the key: text re-measures when its web font finishes loading.
  const sizes = transformableLeaves(s.doc, ids)
    .movable.map((id) => {
      const l = s.doc.layers[id];
      if (!isTransformable(l)) return '';
      const f = layerFrame(l);
      return `${f.w.toFixed(2)}x${f.h.toFixed(2)}`;
    })
    .join(';');
  const key = `${ids.join(',')}|${sizes}`;
  if (controls && controls.doc === s.doc && controls.key === key) return controls.session;
  const res = ids.length ? TransformSession.forLayers(s.doc, ids, 'immediate') : null;
  controls = { key, doc: s.doc, session: res && typeof res !== 'string' ? res : null };
  return controls.session;
}

/* ---------------- helpers ---------------- */

function unionOfCorners(doc: Document, ids: ID[]): Rect | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const id of ids) {
    const l = doc.layers[id];
    if (!isTransformable(l)) continue;
    for (const p of layerCorners(l)) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function explain(doc: Document, ids: ID[]): string {
  const { locked, other } = transformableLeaves(doc, ids);
  if (locked.length) return 'The layer is locked. Unlock its position to move it.';
  if (other.length) return 'Fill and adjustment layers cover the whole canvas and cannot be moved.';
  return 'Select a layer to move (or turn on Auto-Select).';
}

/** Auto-select the layer under the pointer. Returns false when nothing is there. */
function autoSelectAt(e: ToolPointerEvent): boolean {
  const s = activeSession();
  if (!s) return false;
  const id = pickLayer(s.doc, e.docX, e.docY);
  if (!id) return false;
  const opts = toolOptions('move', MOVE_DEFAULTS);
  const target = opts.autoSelectTarget === 'group' ? topGroupOf(s.doc, id) : id;
  const st = useEditor.getState();
  if (e.shiftKey) {
    if (!s.selectedLayerIds.includes(target)) st.setActiveLayer(target, 'toggle');
  } else if (!s.selectedLayerIds.includes(target) || s.activeLayerId !== target) st.setActiveLayer(target, 'replace');
  return true;
}

/** Layers whose bounds intersect a doc rect (rubber-band selection), topmost first. */
function layersInRect(doc: Document, r: Rect): ID[] {
  const target = toolOptions('move', MOVE_DEFAULTS).autoSelectTarget;
  const out: ID[] = [];
  for (const id of layersTopDown(doc)) {
    const l = doc.layers[id];
    if (!l || !isTransformable(l) || !isEffectivelyVisible(doc, id) || l.locks.all) continue;
    const b = safeBounds(doc, id);
    if (!b) continue;
    if (b.x > r.x + r.width || b.y > r.y + r.height || b.x + b.width < r.x || b.y + b.height < r.y) continue;
    const pick = target === 'group' ? topGroupOf(doc, id) : id;
    if (!out.includes(pick)) out.push(pick);
  }
  return out;
}

function bandRect(d: BandDrag): Rect {
  return { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), width: Math.abs(d.b.x - d.a.x), height: Math.abs(d.b.y - d.a.y) };
}

/* ---------------- pointer handlers ---------------- */

function onPointerDown(e: ToolPointerEvent) {
  const s = activeSession();
  if (!s || e.button !== 0) return;
  const screen = { x: e.screenX, y: e.screenY };

  // Active Free Transform / Transform Selection session owns the input.
  const ses = activeTransform();
  if (ses) {
    const hit = ses.hitTest(screen);
    if (ses.begin(hit, e)) drag = { kind: 'transform', session: ses, persistent: true };
    return;
  }

  const opts = toolOptions('move', MOVE_DEFAULTS);
  const auto = opts.autoSelect !== e.ctrlKey;

  // Transform controls (handles / rotation zone) on the current selection.
  const ctl = controlsSession();
  let insideControls = false;
  if (ctl && !e.altKey) {
    const hit: Hit = ctl.hitTest(screen);
    if (hit.kind === 'handle' || hit.kind === 'rotate') {
      // A fresh session so the snapshot matches the current document.
      const fresh = TransformSession.forLayers(s.doc, controlIds(s.doc), 'immediate');
      if (typeof fresh !== 'string' && fresh.begin(hit, e)) {
        drag = { kind: 'transform', session: fresh, persistent: false };
        return;
      }
    }
    insideControls = hit.kind === 'inside';
  }

  if (auto && !autoSelectAt(e) && !insideControls) {
    // Empty canvas with auto-select: rubber-band select layers.
    drag = { kind: 'band', a: { x: e.docX, y: e.docY }, b: { x: e.docX, y: e.docY }, screen0: screen, moved: false, additive: e.shiftKey, hits: [] };
    return;
  }
  const cur = activeSession()!;
  const sel = topLevelIds(cur.doc, selectedIds());
  if (!sel.length) {
    drag = { kind: 'blocked', screen0: screen, message: 'Select a layer to move (or turn on Auto-Select).' };
    return;
  }
  const { movable } = transformableLeaves(cur.doc, sel);
  if (!movable.length) {
    // Clicks (e.g. a double-click to edit text) stay quiet; only an actual drag explains why nothing moves.
    drag = { kind: 'blocked', screen0: screen, message: explain(cur.doc, sel) };
    return;
  }
  const starts = new Map<ID, Transform>();
  for (const id of movable) {
    const l = cur.doc.layers[id];
    if (isTransformable(l)) starts.set(id, { ...l.transform });
  }
  drag = {
    kind: 'move',
    q0: { x: e.docX, y: e.docY },
    screen0: screen,
    moved: false,
    selection: sel,
    leaves: movable,
    starts,
    bounds: unionOfCorners(cur.doc, movable),
    targets: null,
    duplicate: e.altKey,
    duplicated: false,
    cloneRoots: [],
    follower: null,
    dx: 0,
    dy: 0,
    last: { x: e.docX, y: e.docY },
  };
}

function startDuplicate(d: MoveDrag) {
  const s = activeSession();
  if (!s) return;
  const doc = s.doc;
  const clones: { layers: Layer[]; rootId: ID; above: ID }[] = d.selection.map((id) => {
    const c = cloneLayerTree(doc, id);
    // Same naming as Layer ▸ Duplicate Layer: "<name> copy".
    const root = c.layers.find((l) => l.id === c.rootId);
    if (root) root.name = `${doc.layers[id]?.name ?? root.name} copy`;
    return { ...c, above: id };
  });
  useEditor.getState().preview((draft) => {
    for (const c of clones) {
      for (const l of c.layers) if (l.id !== c.rootId) draft.layers[l.id] = l;
      const root = c.layers.find((l) => l.id === c.rootId)!;
      insertLayerDraft(draft, root, { aboveId: c.above });
    }
  });
  const after = activeSession()!.doc;
  d.cloneRoots = clones.map((c) => c.rootId);
  const { movable } = transformableLeaves(after, d.cloneRoots);
  d.leaves = movable;
  d.starts = new Map();
  for (const id of movable) {
    const l = after.layers[id];
    if (isTransformable(l)) d.starts.set(id, { ...l.transform });
  }
  d.duplicated = true;
}

function onPointerMove(e: ToolPointerEvent) {
  if (!drag) return;
  if (drag.kind === 'transform') {
    drag.session.move(e);
    return;
  }
  if (drag.kind === 'blocked') {
    if (Math.hypot(e.screenX - drag.screen0.x, e.screenY - drag.screen0.y) < 3) return;
    toastOnce(drag.message, drag.message.startsWith('Select a layer') ? 'info' : 'warning');
    drag = null;
    return;
  }
  if (drag.kind === 'band') {
    const b = drag;
    if (!b.moved && Math.hypot(e.screenX - b.screen0.x, e.screenY - b.screen0.y) < 3) return;
    b.moved = true;
    b.b = { x: e.docX, y: e.docY };
    const s = activeSession();
    b.hits = s ? layersInRect(s.doc, bandRect(b)) : [];
    viewport.requestOverlay();
    return;
  }
  const d = drag;
  if (!d.moved) {
    if (Math.hypot(e.screenX - d.screen0.x, e.screenY - d.screen0.y) < 3) return;
    d.moved = true;
    const s = activeSession();
    if (s) d.targets = collectSnapTargets(s.doc, { exclude: new Set(d.selection) });
    if (d.duplicate) startDuplicate(d);
    const after = activeSession();
    if (after) d.follower = MaskFollower.forLayers(after.doc, d.duplicated ? d.cloneRoots : d.selection);
  }
  let dx = e.docX - d.q0.x;
  let dy = e.docY - d.q0.y;
  if (e.shiftKey) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  if (d.bounds && d.targets) {
    const r = { ...d.bounds, x: d.bounds.x + dx, y: d.bounds.y + dy };
    const sn = snapRect(r, { targets: d.targets, axes: { x: !e.shiftKey || dx !== 0, y: !e.shiftKey || dy !== 0 } });
    dx += sn.dx;
    dy += sn.dy;
  }
  // Whole pixels at normal zoom (no blurry half-pixel positions); finer steps when zoomed in.
  const z = viewport.zoom();
  const q = z >= 4 ? 0.25 : 1;
  dx = Math.round(dx / q) * q;
  dy = Math.round(dy / q) * q;
  d.dx = dx;
  d.dy = dy;
  d.last = { x: e.docX, y: e.docY };
  const leaves = d.leaves;
  const starts = d.starts;
  const masks = d.follower ? d.follower.update(translate(dx, dy)) : null;
  useEditor.getState().preview((draft) => {
    for (const id of leaves) {
      const l = draft.layers[id];
      const st = starts.get(id);
      if (!l || !st || !isTransformable(l)) continue;
      l.transform.x = st.x + dx;
      l.transform.y = st.y + dy;
    }
    masks?.(draft);
  });
  viewport.requestOverlay();
}

function onPointerUp() {
  const d = drag;
  drag = null;
  clearSmartGuides();
  if (!d || d.kind === 'blocked') return;
  if (d.kind === 'transform') {
    const moved = d.session.end();
    if (!d.persistent) {
      if (moved) d.session.commit();
      else d.session.cancel();
    }
    viewport.requestOverlay();
    return;
  }
  if (d.kind === 'band') {
    viewport.requestOverlay();
    const s = activeSession();
    if (!s || !d.moved) return;
    let ids = d.hits;
    if (d.additive) ids = [...s.selectedLayerIds.filter((id) => !ids.includes(id)), ...ids];
    if (ids.length) useEditor.getState().setSelectedLayers(ids, d.hits[0] ?? ids[ids.length - 1]);
    return;
  }
  if (!d.moved) return;
  const st = useEditor.getState();
  if (d.duplicated) {
    st.commit(d.cloneRoots.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer', undefined, {
      selectedLayerIds: d.cloneRoots,
      activeLayerId: d.cloneRoots[d.cloneRoots.length - 1],
    });
  } else if (d.dx !== 0 || d.dy !== 0) st.commit('Move');
  else st.cancelPreview();
  viewport.requestOverlay();
}

function onDoubleClick(e: ToolPointerEvent) {
  const ses = activeTransform();
  if (ses) {
    if (ses.hitTest({ x: e.screenX, y: e.screenY }).kind === 'inside') commitTransform();
    return;
  }
  // Double-clicking a text layer edits it on the canvas (switches to the Type tool).
  const s = activeSession();
  if (!s) return;
  const id = textLayerAt(s.doc, e.docX, e.docY, s.activeLayerId);
  if (!id) return;
  const at = { x: e.docX, y: e.docY };
  // Imported lazily: the type module itself imports this module.
  import('../../tools/type')
    .then((m) => {
      const edit = (m as { editTextLayer?: (layerId: string, opts?: { at?: Point }) => unknown }).editTextLayer;
      if (typeof edit === 'function') edit(id, { at });
    })
    .catch((err) => console.error('[move] could not start text editing', err));
}

/**
 * Text layer a double-click at (x, y) should edit: the layer under the pointer when it is text,
 * else the active text layer whose box contains the point, else the topmost visible, unlocked
 * text layer whose box contains it and that sits above the hit layer.
 */
function textLayerAt(doc: Document, x: number, y: number, activeId: ID | null): ID | null {
  const hit = pickLayer(doc, x, y);
  const editable = (l: Layer | undefined): l is Layer => !!l && l.type === 'text' && !l.locks.all && isEffectivelyVisible(doc, l.id);
  if (hit && editable(doc.layers[hit])) return hit;
  const inBox = (l: Layer) => isTransformable(l) && pointInPolygon({ x, y }, layerCorners(l));
  const a = activeId ? doc.layers[activeId] : undefined;
  if (editable(a) && inBox(a)) return a.id;
  for (const id of layersTopDown(doc)) {
    if (id === hit) break;
    const l = doc.layers[id];
    if (editable(l) && inBox(l)) return id;
  }
  return null;
}

let lastHover = 0;
function onHover(e: ToolPointerEvent) {
  const screen = { x: e.screenX, y: e.screenY };
  const ses = activeTransform();
  if (ses) {
    viewport.setCursor(ses.cursorFor(ses.hitTest(screen), e));
    return;
  }
  const ctl = controlsSession();
  const hit = ctl ? ctl.hitTest(screen) : null;
  viewport.setCursor(ctl && hit && (hit.kind === 'handle' || hit.kind === 'rotate') && !e.altKey ? ctl.cursorFor(hit, e) : null);
  // Hover outline of the layer that auto-select would pick.
  const now = performance.now();
  if (now - lastHover < 30) return;
  lastHover = now;
  const s = activeSession();
  const auto = toolOptions('move', MOVE_DEFAULTS).autoSelect !== e.ctrlKey;
  const next = s && auto ? pickLayer(s.doc, e.docX, e.docY) : null;
  if (next !== vpState.hoverLayerId) {
    vpState.hoverLayerId = next;
    viewport.requestOverlay();
  }
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function onKeyDown(e: KeyboardEvent): boolean {
  const ses = activeTransform();
  if (ses) {
    if (e.key === 'Enter') {
      commitTransform();
      return true;
    }
    if (e.key === 'Escape') {
      cancelTransform();
      return true;
    }
    if (matchShortcut(e, 'Ctrl+Z')) {
      if (!ses.undoStep()) cancelTransform();
      return true;
    }
    if (ARROWS[e.key] && !e.ctrlKey && !e.metaKey) {
      const k = e.shiftKey ? 10 : 1;
      ses.nudge(ARROWS[e.key][0] * k, ARROWS[e.key][1] * k);
      return true;
    }
    return false;
  }
  if (e.key === 'Escape' && drag) {
    if (drag.kind === 'move' && drag.moved) useEditor.getState().cancelPreview();
    if (drag.kind === 'transform' && !drag.persistent) drag.session.cancel();
    drag = null;
    clearSmartGuides();
    viewport.requestOverlay();
    return true;
  }
  if (ARROWS[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey && activeSession()) {
    const k = e.shiftKey ? 10 : 1;
    nudgeLayers(ARROWS[e.key][0] * k, ARROWS[e.key][1] * k);
    return true;
  }
  return false;
}

function onDeactivate() {
  // Space → temporary Hand: keep the free transform session and any running gesture.
  if (isTemporarilySuspended('move')) return;
  if (drag?.kind === 'transform' && !drag.persistent) drag.session.cancel();
  if (drag?.kind === 'move' && drag.moved) useEditor.getState().cancelPreview();
  drag = null;
  vpState.hoverLayerId = null;
  if (activeTransform()) commitTransform();
  clearSmartGuides();
}

function strokeLayerOutline(ctx: CanvasRenderingContext2D, l: Layer, color: string) {
  if (!isTransformable(l)) return;
  // strokePoly pixel-snaps axis-aligned boxes so the outline stays a crisp 1px line.
  strokePoly(ctx, layerCorners(l).map((p) => viewport.docToScreen(p)), color);
}

function renderOverlay(ctx: CanvasRenderingContext2D) {
  const s = activeSession();
  if (!s) return;
  const ses = activeTransform();
  if (ses) {
    ses.render(ctx);
    return;
  }
  if (drag?.kind === 'transform') {
    drag.session.render(ctx);
    return;
  }
  const extras = useUI.getState().view.extras;
  if (drag?.kind === 'band') {
    if (!drag.moved) return;
    ctx.save();
    for (const id of drag.hits) {
      const l = s.doc.layers[id];
      if (!l) continue;
      if (l.type === 'group') {
        for (const leaf of transformableLeaves(s.doc, [id]).movable) strokeLayerOutline(ctx, s.doc.layers[leaf], ACCENT);
      } else strokeLayerOutline(ctx, l, ACCENT);
    }
    const r = bandRect(drag);
    const p0 = viewport.docToScreen({ x: r.x, y: r.y });
    const p1 = viewport.docToScreen({ x: r.x + r.width, y: r.y + r.height });
    const x = Math.round(p0.x) + 0.5;
    const y = Math.round(p0.y) + 0.5;
    const w = Math.round(p1.x - p0.x);
    const h = Math.round(p1.y - p0.y);
    ctx.fillStyle = 'rgba(139,124,246,0.10)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(139,124,246,0.9)';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
    return;
  }
  // Hover outline (auto-select preview)
  const hov = vpState.hoverLayerId;
  if (hov && extras && !drag && !selectedIds().includes(hov)) {
    const l = s.doc.layers[hov];
    if (l) {
      ctx.save();
      strokeLayerOutline(ctx, l, 'rgba(139,124,246,0.9)');
      ctx.restore();
    }
  }
  const ctl = controlsSession();
  if (ctl) ctl.render(ctx, { handles: !(drag?.kind === 'move' && drag.moved) });
  if (drag?.kind === 'move' && drag.moved) {
    drawLabel(ctx, [`ΔX: ${fmtPx(drag.dx)} px`, `ΔY: ${fmtPx(drag.dy)} px`], viewport.docToScreen(drag.last));
  }
}

export const moveTool: ToolDef = {
  id: 'move',
  name: 'Move',
  shortcut: 'V',
  icon: Move,
  group: 'move',
  order: 10,
  cursor: 'default',
  OptionsBar: MoveOptionsBar,
  defaultOptions: { ...MOVE_DEFAULTS },
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onHover,
  onDoubleClick,
  onKeyDown,
  onDeactivate,
  renderOverlay,
};
