/**
 * Pure math helpers for the IO module (no DOM): whole-document geometry operations, export
 * sizing, trimming, PSD blend-mode mapping, selection-stroke distance fields, recent lists.
 * Everything here is unit-tested (math.test.ts).
 */
import type { BlendMode, GroupBlendMode, Rect, Transform } from '../core/types';

/* ------------------------------------------------------------------ */
/* Whole-document geometry                                             */
/* ------------------------------------------------------------------ */

export type CanvasOp = 'rotate90cw' | 'rotate90ccw' | 'rotate180' | 'flipH' | 'flipV';

/** Document size after a canvas rotation/flip. */
export function opDocSize(op: CanvasOp, w: number, h: number): { width: number; height: number } {
  return op === 'rotate90cw' || op === 'rotate90ccw' ? { width: h, height: w } : { width: w, height: h };
}

/** Map a document point through a canvas rotation/flip (old doc w×h → new doc space). */
export function opMapPoint(op: CanvasOp, x: number, y: number, w: number, h: number): { x: number; y: number } {
  switch (op) {
    case 'rotate90cw':
      return { x: h - y, y: x };
    case 'rotate90ccw':
      return { x: y, y: w - x };
    case 'rotate180':
      return { x: w - x, y: h - y };
    case 'flipH':
      return { x: w - x, y };
    case 'flipV':
      return { x, y: h - y };
  }
}

/** Normalize an angle to (-180, 180]. */
export function normAngle(a: number): number {
  let r = a % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return Math.abs(r) < 1e-9 ? 0 : r;
}

/**
 * New transform of a layer (local box w×h) after a canvas rotation/flip, keeping its content
 * unchanged (only the transform changes). Exact for any rotation/scale/skew.
 */
export function opTransform(op: CanvasOp, t: Transform, lw: number, lh: number, docW: number, docH: number): Transform {
  const c = opMapPoint(op, t.x + lw / 2, t.y + lh / 2, docW, docH);
  const next: Transform = { ...t, x: c.x - lw / 2, y: c.y - lh / 2 };
  switch (op) {
    case 'rotate90cw':
      next.rotation = normAngle(t.rotation + 90);
      break;
    case 'rotate90ccw':
      next.rotation = normAngle(t.rotation - 90);
      break;
    case 'rotate180':
      next.rotation = normAngle(t.rotation + 180);
      break;
    case 'flipH':
      next.rotation = normAngle(-t.rotation);
      next.skewX = t.skewX ? -t.skewX : t.skewX;
      next.scaleX = -t.scaleX;
      break;
    case 'flipV':
      next.rotation = normAngle(-t.rotation);
      next.skewX = t.skewX ? -t.skewX : t.skewX;
      next.scaleY = -t.scaleY;
      break;
  }
  return next;
}

/**
 * Gradient direction after a canvas rotation/flip (gradient angles are y-down: 0° = left → right,
 * 90° = top → bottom) and its center offset (fractions of the box).
 */
export function opGradient(op: CanvasOp, angle: number, offsetX = 0, offsetY = 0): { angle: number; offsetX: number; offsetY: number } {
  switch (op) {
    case 'rotate90cw':
      return { angle: normAngle(angle + 90), offsetX: -offsetY, offsetY: offsetX };
    case 'rotate90ccw':
      return { angle: normAngle(angle - 90), offsetX: offsetY, offsetY: -offsetX };
    case 'rotate180':
      return { angle: normAngle(angle + 180), offsetX: -offsetX, offsetY: -offsetY };
    case 'flipH':
      return { angle: normAngle(180 - angle), offsetX: -offsetX, offsetY };
    case 'flipV':
      return { angle: normAngle(-angle), offsetX, offsetY: -offsetY };
  }
}

/**
 * Transform of a raster layer after a canvas op when its PIXELS are rotated/flipped the same way
 * (so the transform stays clean — e.g. an untransformed Background stays untransformed).
 * Returns the new local box size too. Returns null when baking is not exact (skewed 90° turns).
 */
export function opBakedTransform(
  op: CanvasOp,
  t: Transform,
  lw: number,
  lh: number,
  docW: number,
  docH: number,
): { transform: Transform; width: number; height: number } | null {
  const c = opMapPoint(op, t.x + lw / 2, t.y + lh / 2, docW, docH);
  if (op === 'rotate90cw' || op === 'rotate90ccw') {
    if (t.skewX) return null;
    // Local axes rotate with the pixels: the new local x axis is the old y axis → scales swap.
    return { width: lh, height: lw, transform: { ...t, x: c.x - lh / 2, y: c.y - lw / 2, scaleX: t.scaleY, scaleY: t.scaleX } };
  }
  if (op === 'rotate180') return { width: lw, height: lh, transform: { ...t, x: c.x - lw / 2, y: c.y - lh / 2 } };
  // Flips: the pixel flip absorbs the mirror; rotation and skew change sign.
  return {
    width: lw,
    height: lh,
    transform: { ...t, x: c.x - lw / 2, y: c.y - lh / 2, rotation: normAngle(-t.rotation), skewX: t.skewX ? -t.skewX : t.skewX },
  };
}

export type LayerTurn = 'flipH' | 'flipV' | 'rotate90cw' | 'rotate90ccw' | 'rotate180';

/**
 * Edit ▸ Transform flips/rotations of one layer about its own center, in DOCUMENT space:
 * flips mirror across the canvas axes (for rotated/skewed layers this negates rotation and skew,
 * for upright layers it is simply scale × −1); rotations add to the layer rotation.
 */
export function layerTurnTransform(op: LayerTurn, t: Transform): Transform {
  switch (op) {
    case 'flipH':
      return { ...t, scaleX: -t.scaleX, rotation: normAngle(-t.rotation), ...(t.skewX ? { skewX: -t.skewX } : {}) };
    case 'flipV':
      return { ...t, scaleY: -t.scaleY, rotation: normAngle(-t.rotation), ...(t.skewX ? { skewX: -t.skewX } : {}) };
    case 'rotate90cw':
      return { ...t, rotation: normAngle(t.rotation + 90) };
    case 'rotate90ccw':
      return { ...t, rotation: normAngle(t.rotation - 90) };
    case 'rotate180':
      return { ...t, rotation: normAngle(t.rotation + 180) };
  }
}

/** Map a point through a layer turn about `pivot` (screen-style axes: +y down, CW positive). */
export function turnPoint(op: LayerTurn, x: number, y: number, pivot: { x: number; y: number }): { x: number; y: number } {
  const dx = x - pivot.x;
  const dy = y - pivot.y;
  switch (op) {
    case 'flipH':
      return { x: pivot.x - dx, y };
    case 'flipV':
      return { x, y: pivot.y - dy };
    case 'rotate90cw':
      return { x: pivot.x - dy, y: pivot.y + dx };
    case 'rotate90ccw':
      return { x: pivot.x + dy, y: pivot.y - dx };
    case 'rotate180':
      return { x: pivot.x - dx, y: pivot.y - dy };
  }
}

/**
 * Turn a layer (local box lw×lh) about a document-space pivot — the combined center of all
 * selected layers, so a multi-layer flip mirrors the whole arrangement like Photoshop.
 */
export function layerTurnAbout(op: LayerTurn, t: Transform, lw: number, lh: number, pivot: { x: number; y: number }): Transform {
  const c = turnPoint(op, t.x + lw / 2, t.y + lh / 2, pivot);
  return { ...layerTurnTransform(op, t), x: c.x - lw / 2, y: c.y - lh / 2 };
}

/** Transform of a layer after the whole document is resampled by (sx, sy). */
export function scaleTransform(t: Transform, lw: number, lh: number, sx: number, sy: number): Transform {
  const cx = (t.x + lw / 2) * sx;
  const cy = (t.y + lh / 2) * sy;
  return { ...t, x: cx - lw / 2, y: cy - lh / 2, scaleX: t.scaleX * sx, scaleY: t.scaleY * sy };
}

/** Anchor fractions (0 / 0.5 / 1) for a 3×3 anchor index (0 = top-left … 8 = bottom-right). */
export function anchorFractions(anchor: number): { ax: number; ay: number } {
  const a = Math.max(0, Math.min(8, Math.round(anchor)));
  return { ax: (a % 3) / 2, ay: Math.floor(a / 3) / 2 };
}

/** Offset of the old canvas inside the new canvas for Canvas Size with an anchor. */
export function canvasSizeOffset(oldW: number, oldH: number, newW: number, newH: number, anchor: number): { dx: number; dy: number } {
  const { ax, ay } = anchorFractions(anchor);
  return { dx: Math.round((newW - oldW) * ax), dy: Math.round((newH - oldH) * ay) };
}

/* ------------------------------------------------------------------ */
/* Export sizing                                                       */
/* ------------------------------------------------------------------ */

export type FitMode = 'cover' | 'fit';

/**
 * Placement of a source (sw×sh) inside a target (tw×th): scale and top-left offset.
 * cover = fill the target (cropping), fit = letterbox inside the target.
 */
export function fitRect(
  sw: number,
  sh: number,
  tw: number,
  th: number,
  mode: FitMode,
): { scale: number; x: number; y: number; width: number; height: number } {
  const s = mode === 'cover' ? Math.max(tw / sw, th / sh) : Math.min(tw / sw, th / sh);
  const width = sw * s;
  const height = sh * s;
  return { scale: s, x: (tw - width) / 2, y: (th - height) / 2, width, height };
}

/** Scale an image down (never up) to fit within maxW×maxH. */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): number {
  return Math.min(1, maxW / w, maxH / h);
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

/** Replace characters that are invalid in file names. */
export function safeFileName(name: string, fallback = 'Untitled'): string {
  const s = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return s.slice(0, 120) || fallback;
}

/** Replace/append the extension of a file name. */
export function withExtension(name: string, ext: string): string {
  const base = name.replace(/\.(pgfx|png|jpe?g|webp|gif|bmp|psd)$/i, '');
  return `${base}.${ext}`;
}

/* ------------------------------------------------------------------ */
/* Trimming                                                            */
/* ------------------------------------------------------------------ */

export interface PixelBuffer {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * Bounds of pixels to KEEP when trimming.
 *  - mode 'transparent': keep pixels with alpha > 0
 *  - mode 'color': keep pixels that differ from `color` ([r,g,b,a]) by more than `tolerance` per channel
 * `sides` limits which edges may be trimmed. Returns null when everything would be trimmed.
 */
export function trimBounds(
  img: PixelBuffer,
  mode: 'transparent' | 'color',
  color: [number, number, number, number] = [0, 0, 0, 0],
  sides: { top: boolean; bottom: boolean; left: boolean; right: boolean } = { top: true, bottom: true, left: true, right: true },
  tolerance = 0,
): Rect | null {
  const { data, width, height } = img;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  const [cr, cg, cb, ca] = color;
  for (let y = 0; y < height; y++) {
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      let keep: boolean;
      if (mode === 'transparent') keep = data[i + 3] > 0;
      else
        keep =
          Math.abs(data[i] - cr) > tolerance ||
          Math.abs(data[i + 1] - cg) > tolerance ||
          Math.abs(data[i + 2] - cb) > tolerance ||
          Math.abs(data[i + 3] - ca) > tolerance;
      if (keep) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const x0 = sides.left ? minX : 0;
  const y0 = sides.top ? minY : 0;
  const x1 = sides.right ? maxX + 1 : width;
  const y1 = sides.bottom ? maxY + 1 : height;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/* ------------------------------------------------------------------ */
/* PSD blend modes                                                     */
/* ------------------------------------------------------------------ */

/** Our blend mode → ag-psd blend mode string. */
export function toPsdBlend(mode: GroupBlendMode): string {
  if (mode === 'pass-through') return 'pass through';
  return mode.replace(/-/g, ' ');
}

const PSD_FALLBACK: Record<string, BlendMode> = {
  dissolve: 'normal',
  'linear burn': 'multiply',
  'darker color': 'darken',
  'lighter color': 'lighten',
  'vivid light': 'hard-light',
  'linear light': 'hard-light',
  'pin light': 'hard-light',
  'hard mix': 'hard-light',
  subtract: 'difference',
  subtraction: 'difference',
  divide: 'color-dodge',
};

const OUR_BLENDS = new Set<string>([
  'normal',
  'darken',
  'multiply',
  'color-burn',
  'lighten',
  'screen',
  'color-dodge',
  'linear-dodge',
  'overlay',
  'soft-light',
  'hard-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

/** ag-psd blend mode → ours (unsupported modes map to the closest available one). */
export function fromPsdBlend(mode: string | undefined, isGroup = false): GroupBlendMode {
  if (!mode) return isGroup ? 'pass-through' : 'normal';
  if (mode === 'pass through') return isGroup ? 'pass-through' : 'normal';
  const ours = mode.replace(/ /g, '-');
  if (OUR_BLENDS.has(ours)) return ours as BlendMode;
  return PSD_FALLBACK[mode] ?? 'normal';
}

/* ------------------------------------------------------------------ */
/* Distance field (selection stroke)                                   */
/* ------------------------------------------------------------------ */

const INF = 1e20;

/** 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Euclidean distance (in px) from every pixel to the nearest pixel where `inside[i]` is truthy.
 * Pixels that are inside get 0.
 */
export function distanceTo(inside: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = inside[i] ? 0 : INF;
  // Columns.
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  // Rows.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = Math.sqrt(d[x]);
  }
  return out;
}

export type StrokeLocation = 'inside' | 'center' | 'outside';

/**
 * Coverage (0..255) of a stroke of `width` px around a binary mask (alpha ≥ 128 = selected).
 * Anti-aliased by ~1px. `alpha` is the mask's alpha channel (length w*h).
 */
export function strokeCoverage(
  alpha: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  width: number,
  location: StrokeLocation,
): Uint8ClampedArray {
  const n = w * h;
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const sel = alpha[i] >= 128;
    inside[i] = sel ? 1 : 0;
    outside[i] = sel ? 0 : 1;
  }
  const dOut = distanceTo(inside, w, h); // distance from unselected pixels to the selection
  const dIn = distanceTo(outside, w, h); // distance from selected pixels to the outside
  const cov = new Uint8ClampedArray(n);
  const half = width / 2;
  for (let i = 0; i < n; i++) {
    // Signed distance to the edge (pixel centers sit half a pixel off the boundary).
    const sd = inside[i] ? -(dIn[i] - 0.5) : dOut[i] - 0.5;
    let lo: number, hi: number;
    if (location === 'outside') {
      lo = 0;
      hi = width;
    } else if (location === 'inside') {
      lo = -width;
      hi = 0;
    } else {
      lo = -half;
      hi = half;
    }
    // Coverage of the pixel [sd-0.5, sd+0.5] by the band [lo, hi].
    const a = Math.max(0, Math.min(sd + 0.5, hi) - Math.max(sd - 0.5, lo));
    cov[i] = Math.round(Math.min(1, a) * 255);
  }
  return cov;
}

/* ------------------------------------------------------------------ */
/* Recent lists                                                        */
/* ------------------------------------------------------------------ */

export interface RecentFile {
  path: string;
  name: string;
  time: number;
}

/** Add/move a path to the top of a recent list (dedupe, case-insensitive on Windows-like paths). */
export function pushRecent(list: RecentFile[], entry: RecentFile, max = 12): RecentFile[] {
  const key = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  return [entry, ...list.filter((e) => key(e.path) !== key(entry.path))].slice(0, max);
}

export interface RecentSize {
  width: number;
  height: number;
}

export function pushRecentSize(list: RecentSize[], s: RecentSize, max = 6): RecentSize[] {
  return [s, ...list.filter((e) => e.width !== s.width || e.height !== s.height)].slice(0, max);
}

/** Integer pixel rect for a rect, clamped to [0,w]x[0,h]; null if empty. */
export function clampRect(r: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.width));
  const y1 = Math.min(h, Math.ceil(r.y + r.height));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
