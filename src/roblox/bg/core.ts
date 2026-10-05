/**
 * Background removal core (pure, typed-array based):
 *  - 'auto'  : sample the dominant border colors and flood-fill from every edge with a tolerance,
 *  - 'color' : key out one picked color (globally or contiguous from the edges),
 *  - 'green' : chroma key on green dominance.
 * Then shrink (erode) the edge, feather it, and optionally decontaminate color spill.
 */
import { blurFloat, distanceToOutside, hexToRgb, smoothstep, type PixelBuffer } from '../pixels';

export type BgMode = 'auto' | 'color' | 'green';

export interface BgParams {
  mode: BgMode;
  /** Key color for 'color' mode. */
  keyColor: string;
  /** 0..100 — distance below which pixels are fully removed. */
  tolerance: number;
  /** 0..100 — transition band above the tolerance (partial transparency). */
  softness: number;
  /** Only remove background connected to the image border (always on for 'auto'). */
  contiguous: boolean;
  /** Edge blur in px. */
  feather: number;
  /** Erode the kept area by px. */
  shrink: number;
  /** 0..1 — remove background color spill from edge pixels. */
  decontaminate: number;
}

export const DEFAULT_BG_PARAMS: BgParams = {
  mode: 'auto',
  keyColor: '#00b140',
  tolerance: 18,
  softness: 12,
  contiguous: true,
  feather: 0.6,
  shrink: 0,
  decontaminate: 0.6,
};

export const GREEN_PRESET: Partial<BgParams> = { mode: 'green', tolerance: 30, softness: 25, contiguous: false, decontaminate: 0.8, keyColor: '#00b140' };

export type RGB = [number, number, number];

/** Squared "redmean" color distance (unscaled) — compare these, take the root once. */
function colorDistanceSq(r: number, g: number, b: number, pr: number, pg: number, pb: number): number {
  const rm = (r + pr) / 2;
  const dr = r - pr,
    dg = g - pg,
    db = b - pb;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

const DIST_SCALE = 100 / 765;

/** Perceptual-ish ("redmean") color distance scaled to 0..100. */
export function colorDistance(r: number, g: number, b: number, pr: number, pg: number, pb: number): number {
  return Math.sqrt(colorDistanceSq(r, g, b, pr, pg, pb)) * DIST_SCALE;
}

/**
 * Dominant colors along the image border (ignores transparent pixels). Returns up to `maxColors`
 * colors that each cover a meaningful share of the border.
 */
export function sampleBorderPalette(img: PixelBuffer, maxColors = 4): RGB[] {
  const { width: w, height: h, data: d } = img;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  const perim = 2 * (w + h);
  const step = Math.max(1, Math.floor(perim / 6000));
  const visit = (x: number, y: number) => {
    const q = (y * w + x) * 4;
    if (d[q + 3] < 16) return;
    const key = ((d[q] >> 3) << 10) | ((d[q + 1] >> 3) << 5) | (d[q + 2] >> 3);
    let e = buckets.get(key);
    if (!e) buckets.set(key, (e = { n: 0, r: 0, g: 0, b: 0 }));
    e.n++;
    e.r += d[q];
    e.g += d[q + 1];
    e.b += d[q + 2];
    total++;
  };
  // Sample a 2px-deep frame to be robust against a 1px border line.
  for (let depth = 0; depth < Math.min(2, Math.floor(Math.min(w, h) / 2)); depth++) {
    for (let x = 0; x < w; x += step) {
      visit(x, depth);
      visit(x, h - 1 - depth);
    }
    for (let y = 0; y < h; y += step) {
      visit(depth, y);
      visit(w - 1 - depth, y);
    }
  }
  if (!total) return [];
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  // Merge similar buckets into clusters.
  const clusters: { n: number; r: number; g: number; b: number }[] = [];
  for (const e of sorted) {
    const mr = e.r / e.n,
      mg = e.g / e.n,
      mb = e.b / e.n;
    const c = clusters.find((k) => colorDistance(mr, mg, mb, k.r / k.n, k.g / k.n, k.b / k.n) < 9);
    if (c) {
      c.n += e.n;
      c.r += e.r;
      c.g += e.g;
      c.b += e.b;
    } else clusters.push({ ...e });
  }
  clusters.sort((a, b) => b.n - a.n);
  const out: RGB[] = [];
  let covered = 0;
  for (const c of clusters) {
    if (out.length >= maxColors) break;
    if (out.length && c.n / total < 0.04) break;
    out.push([c.r / c.n, c.g / c.n, c.b / c.n]);
    covered += c.n;
    if (covered / total > 0.97) break;
  }
  return out;
}

/** Per-pixel "background-ness" distance (0 = definitely background). */
export function backgroundDistance(img: PixelBuffer, params: BgParams, palette: RGB[]): Float32Array {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const D = new Float32Array(n);
  if (params.mode === 'green') {
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      if (d[q + 3] < 16) {
        D[i] = 0;
        continue;
      }
      const r = d[q],
        g = d[q + 1],
        b = d[q + 2];
      const excess = g - Math.max(r, b);
      const greenness = Math.max(0, Math.min(100, (excess / 255) * 260));
      D[i] = 100 - greenness;
    }
    return D;
  }
  if (!palette.length) {
    // Border is fully transparent: the existing alpha already separates the subject.
    for (let i = 0, q = 3; i < n; i++, q += 4) D[i] = d[q] < 16 ? 0 : 100;
    return D;
  }
  const pal = palette;
  const k0 = pal.length;
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    if (d[q + 3] < 16) {
      D[i] = 0;
      continue;
    }
    const r = d[q],
      g = d[q + 1],
      b = d[q + 2];
    let best = Infinity;
    for (let k = 0; k < k0; k++) {
      const c = pal[k];
      const v = colorDistanceSq(r, g, b, c[0], c[1], c[2]);
      if (v < best) best = v;
    }
    D[i] = Math.sqrt(best) * DIST_SCALE;
  }
  return D;
}

/** Palette used for a mode (auto → border colors, color → key color, green → green key). */
export function paletteFor(img: PixelBuffer, params: BgParams): RGB[] {
  if (params.mode === 'auto') return sampleBorderPalette(img);
  return [hexToRgb(params.mode === 'green' ? '#00b140' : params.keyColor)];
}

/**
 * Compute the keep-mask (0 = removed, 255 = kept) for an image. The result does NOT include the
 * image's own alpha; multiply with `applyMask`.
 */
export function computeKeepMask(img: PixelBuffer, params: BgParams, palette = paletteFor(img, params)): Uint8ClampedArray {
  const { width: w, height: h } = img;
  const n = w * h;
  const D = backgroundDistance(img, params, palette);
  const tol = Math.max(0, params.tolerance);
  const soft = Math.max(0.001, params.softness);
  const limit = tol + soft;
  const contiguous = params.mode === 'auto' ? true : params.contiguous;
  let reach: Uint8Array | null = null;
  if (contiguous) {
    // Flood fill from every border pixel through pixels below the limit (inlined: no per-pixel
    // closures — this runs over millions of pixels).
    const R = (reach = new Uint8Array(n));
    const queue = new Int32Array(n);
    let head = 0,
      tail = 0;
    for (let x = 0; x < w; x++) {
      const a = x,
        b = (h - 1) * w + x;
      if (!R[a] && D[a] < limit) (R[a] = 1), (queue[tail++] = a);
      if (!R[b] && D[b] < limit) (R[b] = 1), (queue[tail++] = b);
    }
    for (let y = 0; y < h; y++) {
      const a = y * w,
        b = y * w + w - 1;
      if (!R[a] && D[a] < limit) (R[a] = 1), (queue[tail++] = a);
      if (!R[b] && D[b] < limit) (R[b] = 1), (queue[tail++] = b);
    }
    const last = n - w;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      let j = i - 1;
      if (x > 0 && !R[j] && D[j] < limit) (R[j] = 1), (queue[tail++] = j);
      j = i + 1;
      if (x < w - 1 && !R[j] && D[j] < limit) (R[j] = 1), (queue[tail++] = j);
      j = i - w;
      if (i >= w && !R[j] && D[j] < limit) (R[j] = 1), (queue[tail++] = j);
      j = i + w;
      if (i < last && !R[j] && D[j] < limit) (R[j] = 1), (queue[tail++] = j);
    }
  }
  const maskF = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (reach && !reach[i]) {
      maskF[i] = 1;
      continue;
    }
    const v = D[i];
    maskF[i] = v <= tol ? 0 : v >= limit ? 1 : (v - tol) / soft;
  }
  // Shrink edge
  if (params.shrink > 0.01) {
    const inside = new Uint8Array(n);
    for (let i = 0; i < n; i++) inside[i] = maskF[i] >= 0.5 ? 1 : 0;
    const dist = distanceToOutside(inside, w, h, false);
    const s = params.shrink;
    for (let i = 0; i < n; i++) if (inside[i]) maskF[i] *= smoothstep(s - 0.5, s + 0.5, dist[i]);
  }
  // Feather
  if (params.feather > 0.25) blurFloat(maskF, w, h, params.feather * 2);
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) out[i] = maskF[i] * 255 + 0.5;
  return out;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DecontaminateResult {
  /** True when any pixel color changed. */
  changed: boolean;
  /** Bounds of the changed pixels (null when nothing changed). */
  rect: PixelRect | null;
}

/** Edge band (px from the removed area) where spill is removed: color keys / green screen. */
export const DECONTAM_BAND = 3;
export const GREEN_SPILL_BAND = 6;

/**
 * Remove background color spill from kept pixels near the cut (in place): partially transparent
 * pixels and pixels within a few px of the removed area. Interior colors are never touched, so
 * e.g. green clothing away from the edge keeps its color.
 */
export function decontaminate(img: PixelBuffer, mask: Uint8ClampedArray, params: BgParams, palette: RGB[]): DecontaminateResult {
  const none: DecontaminateResult = { changed: false, rect: null };
  const amount = Math.max(0, Math.min(1, params.decontaminate));
  if (amount <= 0) return none;
  const green = params.mode === 'green';
  if (!green && !palette.length) return none;
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const inside = new Uint8Array(n);
  let anyRemoved = false;
  for (let i = 0; i < n; i++) {
    if (mask[i] >= 250) inside[i] = 1;
    else anyRemoved = true;
  }
  if (!anyRemoved) return none;
  const dist = distanceToOutside(inside, w, h, false);
  const band = green ? GREEN_SPILL_BAND : DECONTAM_BAND;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    const m = mask[i];
    if (!m) continue;
    const di = dist[i];
    if (inside[i] && di > band) continue;
    const r = d[q],
      g = d[q + 1],
      b = d[q + 2];
    // Fade the correction out toward the inner edge of the band.
    const fade = inside[i] ? Math.min(1, (band + 1 - di) / 2) : 1;
    const k = amount * fade;
    if (green) {
      const cap = Math.max(r, b);
      if (g <= cap) continue;
      const ng = cap + (g - cap) * (1 - k);
      // Restore lost luminance a little so skin doesn't go magenta.
      const lost = (g - ng) * 0.3;
      d[q] = r + lost * k;
      d[q + 1] = ng;
      d[q + 2] = b + lost * k;
    } else {
      // Nearest background color.
      let best = Infinity,
        bc = palette[0];
      for (const c of palette) {
        const v = colorDistanceSq(r, g, b, c[0], c[1], c[2]);
        if (v < best) {
          best = v;
          bc = c;
        }
      }
      const edgeA = inside[i] ? Math.min(1, 0.55 + di / (band * 2.2)) : m / 255;
      const a = Math.max(0.2, edgeA);
      const fr = (r - (1 - a) * bc[0]) / a;
      const fg = (g - (1 - a) * bc[1]) / a;
      const fb = (b - (1 - a) * bc[2]) / a;
      d[q] = r + (fr - r) * k;
      d[q + 1] = g + (fg - g) * k;
      d[q + 2] = b + (fb - b) * k;
    }
    if (d[q] !== r || d[q + 1] !== g || d[q + 2] !== b) {
      const x = i % w,
        y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? none : { changed: true, rect: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } };
}

/** Multiply the image alpha by the keep-mask (in place). */
export function applyMask(img: PixelBuffer, mask: Uint8ClampedArray): PixelBuffer {
  const d = img.data;
  for (let i = 0, q = 3; i < mask.length; i++, q += 4) d[q] = (d[q] * mask[i]) / 255;
  return img;
}

/**
 * Full pipeline: returns { mask, palette, decontaminated } and modifies `img` in place when
 * decontaminating (only edge pixels; `decontaminated.rect` bounds the changed area).
 */
export function removeBackground(img: PixelBuffer, params: BgParams): { mask: Uint8ClampedArray; palette: RGB[]; decontaminated: DecontaminateResult } {
  const palette = paletteFor(img, params);
  const mask = computeKeepMask(img, params, palette);
  const decontaminated = decontaminate(img, mask, params, palette);
  return { mask, palette, decontaminated };
}

/** Bounds of mask pixels below 255 (pixels whose alpha a 'delete' output changes), or null. */
export function maskChangeBounds(mask: Uint8ClampedArray, w: number, h: number): PixelRect | null {
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] < 255) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Union of two optional rects. */
export function unionRect(a: PixelRect | null, b: PixelRect | null): PixelRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Subject selection heuristic: alpha if the image has transparency, else auto background removal. */
export function subjectMask(img: PixelBuffer): Uint8ClampedArray {
  const params: BgParams = { ...DEFAULT_BG_PARAMS, tolerance: 16, softness: 10, feather: 0.5, decontaminate: 0 };
  const mask = computeKeepMask(img, params);
  const d = img.data;
  for (let i = 0, q = 3; i < mask.length; i++, q += 4) mask[i] = (mask[i] * d[q]) / 255;
  return mask;
}
