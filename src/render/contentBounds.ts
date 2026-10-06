/**
 * Content crops of layer renders (release review render-paint-diff-3).
 *
 * A raster layer with layer effects renders several canvases as large as its padded region (the
 * content, the behind pieces of shadows / strokes / glows…). The region used to be the whole
 * bitmap: a New Layer (document-sized) holding a small painted blob with Drop Shadow + Stroke held
 * ≈ 25M px of renders at 4K however small the blob. Such renders are cropped to the bitmap's
 * content instead: its opaque bounds plus slack (painting near the content stays inside the crop
 * and keeps updating the render in place), snapped to a coarse grid.
 *
 * The bounds are CONSERVATIVE: exact after a scan of the bitmap's alpha, then grown by the regions
 * touched since (bitmaps.dirtySince) — erasing never shrinks them until a change of unknown extent
 * forces a new scan. They never miss an opaque pixel, so a cropped render loses nothing. They are
 * a property of the bitmap's content history (keyed by bitmap id + version), not a render cache:
 * every render of the same bitmap version — cached, incremental or from scratch after
 * invalidateRenderCache() — uses the same crop.
 */
import type { ID, Rect } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { ctxRead } from '../core/canvas';

interface Entry {
  v: number;
  w: number;
  h: number;
  /** Opaque bounds (bitmap px), null = empty. */
  r: Rect | null;
}

const cache = new Map<ID, Entry>();
const MAX_ENTRIES = 512;

/** Full scans of a bitmap's alpha (tests / profiling). */
export const boundsStats = { scans: 0 };

/** Exact bounds of the non-zero alpha of RGBA pixels (null when fully transparent). */
export function scanAlphaBounds(data: Uint8ClampedArray | Uint8Array, w: number, h: number): Rect | null {
  // One 32-bit load per pixel: alpha is the top byte of the little-endian RGBA word.
  const d32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const rowEmpty = (y: number) => {
    const o = y * w;
    for (let x = 0; x < w; x++) if (d32[o + x] >>> 24) return false;
    return true;
  };
  let y0 = 0;
  while (y0 < h && rowEmpty(y0)) y0++;
  if (y0 >= h) return null;
  let y1 = h - 1;
  while (y1 > y0 && rowEmpty(y1)) y1--;
  let x0 = w;
  let x1 = -1;
  for (let y = y0; y <= y1; y++) {
    const o = y * w;
    for (let x = 0; x < x0; x++)
      if (d32[o + x] >>> 24) {
        x0 = x;
        break;
      }
    for (let x = w - 1; x > x1; x--)
      if (d32[o + x] >>> 24) {
        x1 = x;
        break;
      }
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, width: Math.max(a.x + a.width, b.x + b.width) - x0, height: Math.max(a.y + a.height, b.y + b.height) - y0 };
}

function remember(id: ID, e: Entry): Rect | null {
  cache.delete(id);
  cache.set(id, e);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as ID);
  return e.r;
}

/**
 * Conservative opaque bounds of a bitmap (bitmap px): a superset of its non-transparent pixels;
 * null when it is empty, undefined when there is no such bitmap.
 */
export function conservativeBounds(id: ID): Rect | null | undefined {
  const c = bitmaps.tryGet(id);
  if (!c) return undefined;
  const v = bitmaps.version(id);
  const hit = cache.get(id);
  if (hit && hit.w === c.width && hit.h === c.height) {
    if (hit.v === v) return hit.r;
    const d = bitmaps.dirtySince(id, hit.v);
    if (d) return remember(id, { v, w: c.width, h: c.height, r: d.width > 0 && d.height > 0 ? union(hit.r, d) : hit.r });
  }
  boundsStats.scans++;
  const img = ctxRead(c).getImageData(0, 0, c.width, c.height);
  return remember(id, { v, w: c.width, h: c.height, r: scanAlphaBounds(img.data, img.width, img.height) });
}

/** Grid (bitmap px) crops are snapped to. */
const CROP_GRID = 64;
/** A crop covering at least this share of the layer is not worth it (the whole layer is rendered). */
const CROP_MIN_SAVING = 0.6;

/**
 * Crop (layer-local px, inside the layer box `w`×`h`) a raster layer's render can be limited to at
 * render scale `s`: its conservative opaque bounds grown by slack — a quarter of their size, at
 * least 64 bitmap px and 3 output px (resampling never reaches past it) — and snapped outward to a
 * 64 px grid. 'full' when cropping saves too little (or the bitmap is missing, or not the size of
 * the layer box), null when the bitmap is empty (the render draws nothing).
 */
export function rasterCrop(bitmapId: ID, w: number, h: number, s: number): Rect | null | 'full' {
  // A bitmap of another size than its layer box draws beyond the box: not cropped.
  const c = bitmaps.tryGet(bitmapId);
  if (!c || c.width !== w || c.height !== h) return 'full';
  const b = conservativeBounds(bitmapId);
  if (b === undefined) return 'full';
  if (b === null) return null;
  const slack = Math.max(CROP_GRID, Math.ceil(0.25 * Math.max(b.width, b.height)), Math.ceil(3 / Math.max(1e-6, s)));
  const G = CROP_GRID;
  const x0 = Math.max(0, Math.floor((b.x - slack) / G) * G);
  const y0 = Math.max(0, Math.floor((b.y - slack) / G) * G);
  const x1 = Math.min(w, Math.ceil((b.x + b.width + slack) / G) * G);
  const y1 = Math.min(h, Math.ceil((b.y + b.height + slack) / G) * G);
  if (x1 <= x0 || y1 <= y0) return null;
  if ((x1 - x0) * (y1 - y0) >= CROP_MIN_SAVING * w * h) return 'full';
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Forget every bitmap's bounds (tests). */
export function resetContentBounds() {
  cache.clear();
  boundsStats.scans = 0;
}
