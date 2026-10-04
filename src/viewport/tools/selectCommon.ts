/** Shared helpers for the selection tools (marquee, lasso, magic wand). */
import type { Document, ID, Point, Rect, Selection } from '../../core/types';
import type { ToolPointerEvent } from '../../registry';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../../core/canvas';
import { rectIntersect } from '../../core/geometry';
import { combine, setSelection, type SelectionMode } from '../../editor/selection';
import { viewport } from '../../editor/viewport';
import { activeSession, useEditor } from '../../state/editor';
import { drawSelectionAnts } from '../outline';
import { docToScreenMatrix, vpState } from '../state';
import { mul, translate } from '../math/affine';
import { drawLabel } from '../draw';

/** Effective mode from modifier keys at pointer-down (Shift add, Alt subtract, both intersect). */
export function modeFromEvent(e: { shiftKey: boolean; altKey: boolean }, fallback: SelectionMode): SelectionMode {
  if (e.shiftKey && e.altKey) return 'intersect';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return fallback;
}

/** Blur a mask canvas by a feather radius (returns a new canvas, or the input when radius ≤ 0). */
export function featherMask(mask: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (!(radius > 0)) return mask;
  const c = createCanvas(mask.width, mask.height);
  const ctx = ctx2d(c);
  ctx.filter = `blur(${radius / 2}px)`;
  ctx.drawImage(mask, 0, 0);
  return c;
}

/** Threshold alpha at 50% (for anti-alias off). */
export function hardenMask(mask: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = ctxRead(mask);
  const img = ctx.getImageData(0, 0, mask.width, mask.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return mask;
}

/** Combine a new mask into the document selection and commit it. */
export function commitSelectionMask(
  doc: Document,
  mask: HTMLCanvasElement,
  mode: SelectionMode,
  label: string,
  opts: { feather?: number; shape?: Selection['shape'] } = {},
) {
  const feather = opts.feather ?? 0;
  const m = featherMask(mask, feather);
  const sel = combine(doc, m, mode, feather > 0 ? null : (opts.shape ?? null));
  if (!sel && !doc.selection) return; // nothing selected before or after
  setSelection(sel, sel ? label : 'Deselect');
}

/** Is a doc point inside the current selection (alpha ≥ 50%)? */
export function pointInSelection(doc: Document, x: number, y: number): boolean {
  const sel = doc.selection;
  if (!sel) return false;
  const b = sel.bounds;
  if (x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) return false;
  const bmp = bitmaps.tryGet(sel.bitmapId);
  if (!bmp) return false;
  try {
    return ctxRead(bmp).getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] >= 128;
  } catch {
    return false;
  }
}

/** Tight bounds of alpha > 0 inside `region` of a canvas (null when empty). */
function tightAlphaBounds(c: HTMLCanvasElement, region: Rect): Rect | null {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const w = Math.min(c.width, Math.ceil(region.x + region.width)) - x0;
  const h = Math.min(c.height, Math.ceil(region.y + region.height)) - y0;
  if (w <= 0 || h <= 0) return null;
  const d = ctxRead(c).getImageData(x0, y0, w, h).data;
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    let i = y * w * 4 + 3;
    for (let x = 0; x < w; x++, i += 4) {
      if (d[i] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: x0 + minX, y: y0 + minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * The selection translated by whole pixels (clipped to the canvas), or null when nothing remains
 * selected. Bounds are derived from the old bounds, so no full-mask scan is needed.
 */
export function translatedSelection(doc: Document, sel: Selection, dx: number, dy: number): Selection | null {
  const src = bitmaps.tryGet(sel.bitmapId);
  if (!src) return null;
  const ix = Math.round(dx);
  const iy = Math.round(dy);
  const moved = { x: sel.bounds.x + ix, y: sel.bounds.y + iy, width: sel.bounds.width, height: sel.bounds.height };
  let bounds = rectIntersect(moved, { x: 0, y: 0, width: doc.width, height: doc.height });
  if (!bounds) return null;
  const c = createCanvas(doc.width, doc.height);
  ctx2d(c).drawImage(src, ix, iy);
  if (bounds.width !== moved.width || bounds.height !== moved.height) {
    // Clipped by the canvas edge: re-measure the (small) remaining region exactly.
    bounds = tightAlphaBounds(c, bounds);
    if (!bounds) return null;
  }
  let shape: Selection['shape'] = null;
  if (sel.shape) {
    const r = { ...sel.shape.rect, x: sel.shape.rect.x + ix, y: sel.shape.rect.y + iy };
    const inside = r.x >= 0 && r.y >= 0 && r.x + r.width <= doc.width && r.y + r.height <= doc.height;
    if (inside) shape = { type: sel.shape.type, rect: r };
    else if (sel.shape.type === 'rect') shape = { type: 'rect', rect: bounds };
  }
  return { bitmapId: bitmaps.add(c), bounds, shape };
}

/* ------------------------------------------------------------------ */
/* Arrow-key nudge of the selection outline (selection tools)          */
/* ------------------------------------------------------------------ */

let nudgeBase: { docId: ID; entryId: ID; sel: Selection; tx: number; ty: number; time: number } | null = null;

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Arrow keys move the selection outline by 1 px (Shift: 10 px) — like Photoshop with a selection
 * tool active. Consecutive presses coalesce into one history step and are always re-cut from the
 * original mask, so nudging back restores pixels pushed past the canvas edge. Returns true when
 * the key was handled.
 */
export function handleSelectionNudgeKey(e: KeyboardEvent): boolean {
  const a = ARROWS[e.key];
  if (!a || e.ctrlKey || e.metaKey || e.altKey) return false;
  const s = activeSession();
  const sel = s?.doc.selection;
  if (!s || !sel) return false;
  const k = e.shiftKey ? 10 : 1;
  const entryId = s.history.entries[s.history.index]?.id ?? '';
  const now = Date.now();
  let st = nudgeBase;
  if (!st || st.docId !== s.doc.id || st.entryId !== entryId || now - st.time > 900) {
    st = { docId: s.doc.id, entryId: '', sel, tx: 0, ty: 0, time: now };
  }
  st.tx += a[0] * k;
  st.ty += a[1] * k;
  st.time = now;
  const next = translatedSelection(s.doc, st.sel, st.tx, st.ty);
  useEditor.getState().commit(
    'Nudge Selection',
    (d) => {
      d.selection = next;
    },
    { coalesce: true },
  );
  const after = activeSession();
  st.entryId = after?.history.entries[after.history.index]?.id ?? '';
  nudgeBase = st;
  return true;
}

/* ------------------------------------------------------------------ */
/* Drag the selection outline (drag inside an existing selection)      */
/* ------------------------------------------------------------------ */

export interface OutlineDrag {
  start: Point;
  dx: number;
  dy: number;
  moved: boolean;
}

export function beginOutlineDrag(e: ToolPointerEvent): OutlineDrag {
  return { start: { x: e.docX, y: e.docY }, dx: 0, dy: 0, moved: false };
}

/** Stop suppressing the default ants (call when an outline drag ends or is abandoned). */
export function endOutlineDragVisual() {
  if (vpState.suppressAnts) {
    vpState.suppressAnts = false;
    viewport.requestOverlay();
  }
}

export function updateOutlineDrag(d: OutlineDrag, e: ToolPointerEvent) {
  let dx = e.docX - d.start.x;
  let dy = e.docY - d.start.y;
  if (e.shiftKey) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  d.dx = Math.round(dx);
  d.dy = Math.round(dy);
  if (d.dx || d.dy) d.moved = true;
  if (d.moved) vpState.suppressAnts = true;
  viewport.requestOverlay();
}

export function drawOutlineDrag(ctx: CanvasRenderingContext2D, d: OutlineDrag) {
  const doc = activeSession()?.doc;
  if (!doc?.selection) return;
  drawSelectionAnts(ctx, doc.selection, mul(docToScreenMatrix(), translate(d.dx, d.dy)));
  if (d.moved) {
    const p = viewport.docToScreen({ x: d.start.x + d.dx, y: d.start.y + d.dy });
    drawLabel(ctx, [`ΔX: ${d.dx} px`, `ΔY: ${d.dy} px`], p);
  }
}

/** Commit a moved selection outline as a new (translated) mask. */
export function commitOutlineDrag(d: OutlineDrag): boolean {
  endOutlineDragVisual();
  const doc = activeSession()?.doc;
  const sel = doc?.selection;
  if (!doc || !sel || !d.moved) return false;
  const next = translatedSelection(doc, sel, d.dx, d.dy);
  setSelection(next, next ? 'Move Selection' : 'Deselect');
  return true;
}
