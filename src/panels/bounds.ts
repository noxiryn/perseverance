/**
 * Content bounds of layers in document space — the area a layer actually covers, not its box.
 * Pixel layers use the bounding box of their non-transparent pixels (cached per bitmap version):
 * a canvas-sized layer with a small painted shape has the shape's bounds. Text / shape layers use
 * their transformed layout box, groups the union of their visible children. Used by Layer ▸ Align /
 * Distribute and the "layer bounds" thumbnails.
 */
import type { Document, ID, Rect, Transform } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctxRead } from '../core/canvas';
import { getLayerBounds } from '../render/compositor';
import { linearApply, unionRects } from './geometryMath';

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Bounding box of the pixels whose alpha exceeds `threshold` in RGBA data, or null if none. */
export function alphaBounds(data: ArrayLike<number>, width: number, height: number, threshold = 0): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4 + 3;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4] > threshold) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x--) {
      if (data[row + x * 4] > threshold) {
        last = x;
        break;
      }
    }
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
    if (y < minY) minY = y;
    maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Axis-aligned document-space bounds of a rect given in a layer's LOCAL coordinates, for a layer
 * whose local box is w×h and whose transform is `t` (same math as core/geometry transformMatrix).
 */
export function localRectToDoc(t: Transform, w: number, h: number, r: Rect): Rect {
  const cx = t.x + w / 2;
  const cy = t.y + h / 2;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x + r.width, r.y + r.height],
    [r.x, r.y + r.height],
  ]) {
    const p = linearApply(t, px - w / 2, py - h / 2);
    x0 = Math.min(x0, cx + p.x);
    y0 = Math.min(y0, cy + p.y);
    x1 = Math.max(x1, cx + p.x);
    y1 = Math.max(y1, cy + p.y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/* ------------------------------------------------------------------ */
/* Bitmap bounds (cached per bitmap version)                           */
/* ------------------------------------------------------------------ */

interface Cached {
  v: number;
  r: Rect | null;
}
const exactCache = new Map<ID, Cached>();
const approxCache = new Map<ID, Cached>();

function remember(cache: Map<ID, Cached>, id: ID, v: number, r: Rect | null) {
  cache.delete(id);
  cache.set(id, { v, r });
  if (cache.size > 96) cache.delete(cache.keys().next().value as ID);
  return r;
}

/** Exact bounds (bitmap px) of the non-transparent pixels of a bitmap. */
export function bitmapContentBounds(id: ID): Rect | null {
  const v = bitmaps.version(id);
  const hit = exactCache.get(id);
  if (hit && hit.v === v) return hit.r;
  if (!bitmaps.has(id)) return null;
  const img = bitmaps.read(id);
  return remember(exactCache, id, v, alphaBounds(img.data, img.width, img.height));
}

const APPROX_SIDE = 160;
let scratch: HTMLCanvasElement | null = null;

/**
 * Fast, slightly conservative bounds (bitmap px) from a downscaled copy — for thumbnails, where
 * a few pixels of slack do not matter and the exact scan of a large bitmap would be too slow.
 */
export function bitmapApproxBounds(id: ID): Rect | null {
  const v = bitmaps.version(id);
  const hit = approxCache.get(id);
  if (hit && hit.v === v) return hit.r;
  const exact = exactCache.get(id);
  if (exact && exact.v === v) return exact.r;
  const c = bitmaps.tryGet(id);
  if (!c) return null;
  const k = Math.min(1, APPROX_SIDE / Math.max(c.width, c.height));
  if (k >= 1) return bitmapContentBounds(id);
  const w = Math.max(1, Math.ceil(c.width * k));
  const h = Math.max(1, Math.ceil(c.height * k));
  if (!scratch) scratch = createCanvas(w, h);
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, w);
    scratch.height = Math.max(scratch.height, h);
  }
  const sctx = ctxRead(scratch);
  sctx.clearRect(0, 0, scratch.width, scratch.height);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(c, 0, 0, w, h);
  const img = sctx.getImageData(0, 0, w, h);
  const r = alphaBounds(img.data, w, h);
  if (!r) return remember(approxCache, id, v, null);
  // Back to bitmap px with one sample of slack on every side.
  const x0 = Math.max(0, Math.floor((r.x - 1) / k));
  const y0 = Math.max(0, Math.floor((r.y - 1) / k));
  const x1 = Math.min(c.width, Math.ceil((r.x + r.width + 1) / k));
  const y1 = Math.min(c.height, Math.ceil((r.y + r.height + 1) / k));
  return remember(approxCache, id, v, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

/* ------------------------------------------------------------------ */
/* Layer bounds                                                        */
/* ------------------------------------------------------------------ */

/**
 * Document-space bounds of what a layer covers: opaque pixels for pixel layers (`precise` = exact
 * scan, else the fast approximation), the transformed box for text / shape layers, the union of
 * visible children for groups. Null for empty layers and for fill / adjustment layers (they cover
 * the whole canvas and are never aligned).
 */
export function layerContentBounds(doc: Document, id: ID, precise = true): Rect | null {
  const l = doc.layers[id];
  if (!l) return null;
  switch (l.type) {
    case 'raster': {
      const c = bitmaps.tryGet(l.bitmapId);
      const b = c ? (precise ? bitmapContentBounds(l.bitmapId) : bitmapApproxBounds(l.bitmapId)) : null;
      if (!c || !b) return null;
      const sx = l.width / c.width;
      const sy = l.height / c.height;
      return localRectToDoc(l.transform, l.width, l.height, { x: b.x * sx, y: b.y * sy, width: b.width * sx, height: b.height * sy });
    }
    case 'text':
    case 'shape': {
      const b = getLayerBounds(doc, id);
      return b && b.width > 0 && b.height > 0 ? b : null;
    }
    case 'group': {
      const parts: Rect[] = [];
      for (const c of l.childIds) {
        if (!doc.layers[c]?.visible) continue;
        const b = layerContentBounds(doc, c, precise);
        if (b) parts.push(b);
      }
      return unionRects(parts);
    }
    default:
      return null;
  }
}
