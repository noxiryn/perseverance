/**
 * Histogram helpers (luminance + per-channel) from ImageData-like objects or canvases.
 * Transparent pixels are ignored; an optional mask (0..255 per pixel) restricts the sample.
 */
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Pixels } from './math';

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** Rec.601 luminosity (0.299/0.587/0.114), rounded. */
  lum: Uint32Array;
  /** Number of sampled pixels. */
  count: number;
}

export function emptyHistogram(): Histogram {
  return { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), lum: new Uint32Array(256), count: 0 };
}

/**
 * Compute a histogram. `step` samples every n-th pixel (for speed on big images); `mask` is a
 * per-pixel weight array (pixels with mask 0 are skipped); pixels with alpha below
 * `alphaThreshold` are skipped (default: only fully transparent ones).
 */
export function computeHistogram(
  img: Pixels,
  opts: { step?: number; mask?: ArrayLike<number> | null; alphaThreshold?: number } = {},
): Histogram {
  const h = emptyHistogram();
  const d = img.data;
  const step = Math.max(1, Math.floor(opts.step ?? 1));
  const mask = opts.mask ?? null;
  const at = Math.max(1, opts.alphaThreshold ?? 1);
  const n = img.width * img.height;
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    if (d[i + 3] < at) continue;
    if (mask && !(mask[p] > 0)) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    h.r[r]++;
    h.g[g]++;
    h.b[b]++;
    h.lum[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;
    h.count++;
  }
  return h;
}

/** Read a canvas (downscaled so its longest side is ≤ maxSize) and compute its histogram. */
export function histogramFromCanvas(src: HTMLCanvasElement, maxSize = 512): Histogram {
  return computeHistogram(readDownscaled(src, maxSize));
}

/** Pixels of a canvas, downscaled to fit maxSize (no scaling when already small). */
export function readDownscaled(src: HTMLCanvasElement, maxSize = 512): ImageData {
  const s = Math.min(1, maxSize / Math.max(src.width, src.height, 1));
  const w = Math.max(1, Math.round(src.width * s));
  const h = Math.max(1, Math.round(src.height * s));
  const c = createCanvas(w, h);
  const ctx = ctx2d(c, { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Sum several channel histograms (e.g. r+g+b for a "monochromatic" composite). */
export function sumChannels(...chs: ArrayLike<number>[]): Uint32Array {
  const out = new Uint32Array(256);
  for (const ch of chs) for (let i = 0; i < 256; i++) out[i] += ch[i];
  return out;
}

function total(ch: ArrayLike<number>): number {
  let t = 0;
  for (let i = 0; i < 256; i++) t += ch[i];
  return t;
}

/**
 * Lowest/highest levels after clipping `lowFrac` / `highFrac` of the samples from each end
 * (e.g. 0.001 = Photoshop's 0.1% default). Returns [0, 255] for an empty histogram.
 */
export function clipRange(ch: ArrayLike<number>, lowFrac = 0.001, highFrac = lowFrac): [number, number] {
  const t = total(ch);
  if (!t) return [0, 255];
  const lowLimit = t * lowFrac;
  const highLimit = t * highFrac;
  let lo = 0;
  let acc = 0;
  for (; lo < 255; lo++) {
    acc += ch[lo];
    if (acc > lowLimit) break;
  }
  let hi = 255;
  acc = 0;
  for (; hi > 0; hi--) {
    acc += ch[hi];
    if (acc > highLimit) break;
  }
  if (hi < lo) hi = lo;
  return [lo, hi];
}

/** Level at which the cumulative count first reaches `frac` of the total (0..1). */
export function percentile(ch: ArrayLike<number>, frac: number): number {
  const t = total(ch);
  if (!t) return 0;
  const target = t * Math.max(0, Math.min(1, frac));
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += ch[i];
    if (acc >= target) return i;
  }
  return 255;
}

export function histogramStats(ch: ArrayLike<number>): { mean: number; median: number; stdDev: number; count: number } {
  const t = total(ch);
  if (!t) return { mean: 0, median: 0, stdDev: 0, count: 0 };
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * ch[i];
  const mean = sum / t;
  let v = 0;
  for (let i = 0; i < 256; i++) v += ch[i] * (i - mean) * (i - mean);
  return { mean, median: percentile(ch, 0.5), stdDev: Math.sqrt(v / t), count: t };
}
