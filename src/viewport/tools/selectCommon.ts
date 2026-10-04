/** Shared helpers for the selection tools (marquee, lasso, magic wand). */
import type { Document, Point, Selection } from '../../core/types';
import type { ToolPointerEvent } from '../../registry';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../../core/canvas';
import { combine, selectionFromCanvas, setSelection, type SelectionMode } from '../../editor/selection';
import { viewport } from '../../editor/viewport';
import { activeSession } from '../../state/editor';
import { selectionOutline, drawAnts } from '../outline';
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
  const path = selectionOutline(doc?.selection);
  if (!path) return;
  drawAnts(ctx, path, mul(docToScreenMatrix(), translate(d.dx, d.dy)));
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
  const src = bitmaps.tryGet(sel.bitmapId);
  if (!src) return false;
  const c = createCanvas(doc.width, doc.height);
  ctx2d(c).drawImage(src, d.dx, d.dy);
  const shape = sel.shape ? { type: sel.shape.type, rect: { ...sel.shape.rect, x: sel.shape.rect.x + d.dx, y: sel.shape.rect.y + d.dy } } : null;
  const next = selectionFromCanvas(c, shape);
  setSelection(next, next ? 'Move Selection' : 'Deselect');
  return true;
}
