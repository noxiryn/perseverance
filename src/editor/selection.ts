/**
 * Selection model helpers. A selection is a doc-sized alpha mask bitmap (see core/types Selection).
 * All functions are non-destructive: they create a NEW mask bitmap and return a new Selection
 * (selections are part of the document → undoable). Use `setSelection()` to commit one.
 */
import type { Document, Point, Rect, Selection } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../core/canvas';
import { boxBlurImageData } from '../core/blur';
import { activeDoc, useEditor } from '../state/editor';

export type SelectionMode = 'new' | 'add' | 'subtract' | 'intersect';

function maskCanvas(doc: Document): HTMLCanvasElement {
  return createCanvas(doc.width, doc.height);
}

/** Compute tight bounds of alpha > 0 in a mask canvas. */
export function maskBounds(c: HTMLCanvasElement): Rect | null {
  const { width, height } = c;
  const data = ctxRead(c).getImageData(0, 0, width, height).data;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    let row = (y * width) * 4 + 3;
    for (let x = 0; x < width; x++, row += 4) {
      if (data[row] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Build a Selection from a mask canvas (takes ownership). Returns null for an empty mask. */
export function selectionFromCanvas(c: HTMLCanvasElement, shape: Selection['shape'] = null): Selection | null {
  const bounds = maskBounds(c);
  if (!bounds) return null;
  return { bitmapId: bitmaps.add(c), bounds, shape };
}

/** Combine a new mask with the existing selection using a mode. */
export function combine(doc: Document, newMask: HTMLCanvasElement, mode: SelectionMode, shape: Selection['shape'] = null): Selection | null {
  const existing = doc.selection ? bitmaps.tryGet(doc.selection.bitmapId) : null;
  if (mode === 'new' || !existing) {
    // Subtracting from / intersecting with nothing leaves nothing selected.
    if (mode === 'subtract' || mode === 'intersect') return null;
    return selectionFromCanvas(newMask, shape);
  }
  const out = maskCanvas(doc);
  const ctx = ctx2d(out);
  ctx.drawImage(existing, 0, 0);
  ctx.globalCompositeOperation =
    mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
  ctx.drawImage(newMask, 0, 0);
  return selectionFromCanvas(out, null);
}

export function rectMask(doc: Document, r: Rect): HTMLCanvasElement {
  const c = maskCanvas(doc);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#000';
  ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
  return c;
}

export function ellipseMask(doc: Document, r: Rect): HTMLCanvasElement {
  const c = maskCanvas(doc);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, Math.abs(r.width / 2), Math.abs(r.height / 2), 0, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

export function polygonMask(doc: Document, pts: Point[]): HTMLCanvasElement {
  const c = maskCanvas(doc);
  if (pts.length < 3) return c;
  const ctx = ctx2d(c);
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
  return c;
}

/** Alpha mask from any canvas (uses its alpha channel), positioned at (x,y) in doc space. */
export function alphaMask(doc: Document, src: HTMLCanvasElement, x = 0, y = 0): HTMLCanvasElement {
  const c = maskCanvas(doc);
  const ctx = ctx2d(c);
  ctx.drawImage(src, x, y);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/* ---------------- commit helpers ---------------- */

export function setSelection(sel: Selection | null, label = sel ? 'Selection' : 'Deselect') {
  useEditor.getState().commit(label, (d) => {
    d.selection = sel;
  });
}

export function selectAll() {
  const doc = activeDoc();
  if (!doc) return;
  const r = { x: 0, y: 0, width: doc.width, height: doc.height };
  setSelection(selectionFromCanvas(rectMask(doc, r), { type: 'rect', rect: r }), 'Select All');
}

export function deselect() {
  if (activeDoc()?.selection) setSelection(null, 'Deselect');
}

export function invertSelection() {
  const doc = activeDoc();
  if (!doc) return;
  const c = maskCanvas(doc);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  if (doc.selection) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(bitmaps.get(doc.selection.bitmapId), 0, 0);
  }
  setSelection(selectionFromCanvas(c), 'Inverse');
}

/** Feather (blur) the selection mask by radius px. */
export function featherSelection(radius: number) {
  const doc = activeDoc();
  if (!doc?.selection || radius <= 0) return;
  const src = bitmaps.get(doc.selection.bitmapId);
  const c = maskCanvas(doc);
  const ctx = ctx2d(c);
  ctx.filter = `blur(${radius / 2}px)`;
  ctx.drawImage(src, 0, 0);
  setSelection(selectionFromCanvas(c), 'Feather');
}

/** Grow (amount > 0) or shrink (amount < 0) the selection by approximately |amount| px. */
export function expandSelection(amount: number) {
  const doc = activeDoc();
  if (!doc?.selection || !amount) return;
  const src = bitmaps.get(doc.selection.bitmapId);
  const c = maskCanvas(doc);
  const ctx = ctxRead(c);
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  boxBlurImageData(img, Math.abs(amount) * 2);
  const d = img.data;
  // Threshold the blurred alpha: low threshold grows, high threshold shrinks.
  const t = amount > 0 ? 8 : 247;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] > t ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  setSelection(selectionFromCanvas(c), amount > 0 ? 'Expand' : 'Contract');
}

/** Selection from a layer's opaque pixels (Ctrl+click on a layer thumbnail). */
export function selectionFromLayerCanvas(docCanvas: HTMLCanvasElement, mode: SelectionMode = 'new') {
  const doc = activeDoc();
  if (!doc) return;
  setSelection(combine(doc, alphaMask(doc, docCanvas), mode), 'Load Selection');
}

/** The selection mask canvas of a document (alpha = selected), or null when nothing is selected. */
export function getSelectionMask(doc: Document | null = activeDoc()): HTMLCanvasElement | null {
  if (!doc?.selection) return null;
  return bitmaps.tryGet(doc.selection.bitmapId);
}

/**
 * Clip drawing to the selection: draws `content` (doc-space canvas) into a new canvas keeping only
 * selected pixels. Returns `content` unchanged when there is no selection.
 */
export function clipToSelection(doc: Document, content: HTMLCanvasElement): HTMLCanvasElement {
  const mask = getSelectionMask(doc);
  if (!mask) return content;
  const out = createCanvas(content.width, content.height);
  const ctx = ctx2d(out);
  ctx.drawImage(content, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0, content.width, content.height);
  return out;
}

/**
 * Magic-wand / flood selection from an RGBA canvas at doc point (x, y).
 * `contiguous` = flood fill; otherwise selects all pixels within tolerance.
 */
export function colorSelectMask(
  doc: Document,
  source: HTMLCanvasElement,
  x: number,
  y: number,
  tolerance: number,
  contiguous: boolean,
  antiAlias = true,
): HTMLCanvasElement {
  const w = source.width,
    h = source.height;
  const src = ctxRead(source).getImageData(0, 0, w, h).data;
  const out = maskCanvas(doc);
  const octx = ctxRead(out);
  const outImg = octx.createImageData(w, h);
  const o = outImg.data;
  const sx = Math.floor(x),
    sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
  const i0 = (sy * w + sx) * 4;
  const r0 = src[i0],
    g0 = src[i0 + 1],
    b0 = src[i0 + 2],
    a0 = src[i0 + 3];
  const tol = tolerance * 4;
  const match = (i: number) =>
    Math.abs(src[i] - r0) + Math.abs(src[i + 1] - g0) + Math.abs(src[i + 2] - b0) + Math.abs(src[i + 3] - a0) <= tol;
  if (contiguous) {
    // Scanline flood fill on typed arrays: each span is filled once and only span seeds are pushed.
    const filled = new Uint8Array(w * h);
    let stack = new Int32Array(1024);
    let sp = 0;
    const push = (x: number, y: number) => {
      if (sp + 2 > stack.length) {
        const n = new Int32Array(stack.length * 2);
        n.set(stack);
        stack = n;
      }
      stack[sp++] = x;
      stack[sp++] = y;
    };
    const ok = (x: number, y: number) => {
      const p = y * w + x;
      return !filled[p] && match(p * 4);
    };
    push(sx, sy);
    while (sp > 0) {
      const y = stack[--sp];
      let x = stack[--sp];
      if (!ok(x, y)) continue;
      while (x > 0 && ok(x - 1, y)) x--;
      let upOpen = false;
      let downOpen = false;
      for (; x < w && ok(x, y); x++) {
        const p = y * w + x;
        filled[p] = 1;
        o[p * 4 + 3] = 255;
        if (y > 0) {
          const u = ok(x, y - 1);
          if (u && !upOpen) push(x, y - 1);
          upOpen = u;
        }
        if (y < h - 1) {
          const d = ok(x, y + 1);
          if (d && !downOpen) push(x, y + 1);
          downOpen = d;
        }
      }
    }
  } else {
    for (let p = 0; p < w * h; p++) if (match(p * 4)) o[p * 4 + 3] = 255;
  }
  octx.putImageData(outImg, 0, 0);
  if (antiAlias) {
    const blurred = createCanvas(w, h);
    const bctx = ctx2d(blurred);
    bctx.filter = 'blur(0.6px)';
    bctx.drawImage(out, 0, 0);
    return blurred;
  }
  return out;
}
