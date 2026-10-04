/** Noise & grain filters: add noise, film grain, dust & scratches, median. */
import { Binary, Film, Sparkles, Tally5 } from 'lucide-react';
import type { FilterDef } from '../../../registry';
import { anchor, bool, clamp, hash, hashGauss, isEmpty, num, sc, str } from '../util';
import { medianImage } from '../median';
import { boolP, numP, pctP, pxP, seedP, selectP } from '../params';

/* ------------------------------------------------------------------ */
/* Add noise                                                           */
/* ------------------------------------------------------------------ */

export const addNoise: FilterDef = {
  id: 'add-noise',
  name: 'Add Noise',
  category: 'Noise & Grain',
  icon: Binary,
  description: 'Per-pixel random noise (gaussian or uniform), monochrome or colored.',
  keywords: ['grain', 'static', 'dither', 'texture'],
  params: [
    numP('amount', 'Amount', 0, 100, 10, { unit: '%', step: 0.5 }),
    selectP('distribution', 'Distribution', [['gaussian', 'Gaussian'], ['uniform', 'Uniform']], 'gaussian'),
    boolP('monochrome', 'Monochromatic', true),
    seedP(1),
  ],
  apply(img, p, ctx) {
    const amt = clamp(num(p.amount, 10), 0, 100) / 100;
    if (amt <= 0 || isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const { ax, ay, s } = anchor(ctx);
    const mono = bool(p.monochrome, true);
    const gauss = str(p.distribution, 'gaussian') !== 'uniform';
    const seed = num(p.seed, 1) | 0;
    const k = amt * (gauss ? 110 : 255);
    // noise is defined per DOCUMENT pixel so previews at other scales look the same
    const inv = 1 / s;
    for (let y = 0; y < h; y++) {
      const Y = Math.floor((y + 0.5 + ay) * inv);
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const X = Math.floor((x + 0.5 + ax) * inv);
        if (mono) {
          const v = (gauss ? hashGauss(X, Y, seed) : hash(X, Y, seed) - 0.5) * k;
          data[j] += v;
          data[j + 1] += v;
          data[j + 2] += v;
        } else {
          data[j] += (gauss ? hashGauss(X, Y, seed) : hash(X, Y, seed) - 0.5) * k;
          data[j + 1] += (gauss ? hashGauss(X, Y, seed + 101) : hash(X, Y, seed + 101) - 0.5) * k;
          data[j + 2] += (gauss ? hashGauss(X, Y, seed + 202) : hash(X, Y, seed + 202) - 0.5) * k;
        }
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Film grain                                                          */
/* ------------------------------------------------------------------ */

/** Smooth gaussian-valued noise: bilinear interpolation of per-cell gaussian hashes. */
function grainNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const tx = x - xi,
    ty = y - yi;
  const a = hashGauss(xi, yi, seed),
    b = hashGauss(xi + 1, yi, seed),
    c = hashGauss(xi, yi + 1, seed),
    d = hashGauss(xi + 1, yi + 1, seed);
  const r0 = a + (b - a) * tx,
    r1 = c + (d - c) * tx;
  return r0 + (r1 - r0) * ty;
}

export const filmGrain: FilterDef = {
  id: 'film-grain',
  name: 'Film Grain',
  category: 'Noise & Grain',
  icon: Film,
  description: 'Organic photographic grain: clumpy, strongest in the midtones.',
  keywords: ['grain', 'analog', 'film', 'noise', 'texture', 'cinematic'],
  params: [pctP('amount', 'Amount', 0.35), pxP('size', 'Grain size', 0.5, 8, 1.5, { step: 0.1 }), pctP('color', 'Color grain', 0), pctP('shadows', 'Shadow grain', 0.5), seedP(1)],
  apply(img, p, ctx) {
    const amt = clamp(num(p.amount, 0.35), 0, 1);
    if (amt <= 0 || isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const { ax, ay, s } = anchor(ctx);
    const size = Math.max(0.35, num(p.size, 1.5));
    const colorAmt = clamp(num(p.color, 0), 0, 1);
    const shadows = clamp(num(p.shadows, 0.5), 0, 1);
    const seed = num(p.seed, 1) | 0;
    // grain coordinates in document px / size; at small preview scales fade fine grain (it would
    // alias into a different, harsher texture)
    const f = 1 / (s * size);
    const visible = Math.min(1, s * size * 1.6);
    const k = amt * 70 * (0.35 + 0.65 * visible);
    for (let y = 0; y < h; y++) {
      const Y = (y + 0.5 + ay) * f;
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const X = (x + 0.5 + ax) * f;
        const g = grainNoise(X, Y, seed) * 0.7 + grainNoise(X * 2.1 + 17.3, Y * 2.1 - 9.1, seed + 7) * 0.45;
        const l = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255;
        // response: strongest in the midtones, configurable in shadows, weak in highlights
        const resp = l < 0.5 ? shadows + (1 - shadows) * (l * 2) : 1 - (l - 0.5) * 1.4;
        const v = g * k * Math.max(0.05, resp);
        if (colorAmt > 0) {
          const cr = grainNoise(X + 31.7, Y + 11.3, seed + 13) * colorAmt;
          const cb = grainNoise(X - 21.1, Y + 41.9, seed + 29) * colorAmt;
          data[j] += v * (1 + cr);
          data[j + 1] += v * (1 - (cr + cb) * 0.5);
          data[j + 2] += v * (1 + cb);
        } else {
          data[j] += v;
          data[j + 1] += v;
          data[j + 2] += v;
        }
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Dust & scratches                                                    */
/* ------------------------------------------------------------------ */

export const dustScratches: FilterDef = {
  id: 'dust-scratches',
  name: 'Dust & Scratches',
  category: 'Noise & Grain',
  icon: Sparkles,
  description: 'Removes specks and scratches that differ from their surroundings by more than the threshold.',
  keywords: ['despeckle', 'clean', 'denoise', 'restore', 'retouch'],
  params: [pxP('radius', 'Radius', 1, 16, 2, { step: 1 }), numP('threshold', 'Threshold', 0, 255, 20, { step: 1, unit: 'lv' })],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const r = Math.max(1, Math.round(num(p.radius, 2) * sc(ctx)));
    const t = clamp(num(p.threshold, 20), 0, 255);
    const d = img.data;
    const med = { data: new Uint8ClampedArray(d), width: img.width, height: img.height };
    medianImage(med, r);
    const m = med.data;
    for (let j = 0; j < d.length; j += 4) {
      if (d[j + 3] === 0) continue;
      const diff = Math.abs((d[j] - m[j]) * 0.2126 + (d[j + 1] - m[j + 1]) * 0.7152 + (d[j + 2] - m[j + 2]) * 0.0722);
      if (diff <= t) continue;
      const k = Math.min(1, (diff - t) / 6 + 0.35);
      d[j] += (m[j] - d[j]) * k;
      d[j + 1] += (m[j + 1] - d[j + 1]) * k;
      d[j + 2] += (m[j + 2] - d[j + 2]) * k;
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Median                                                              */
/* ------------------------------------------------------------------ */

export const median: FilterDef = {
  id: 'median',
  name: 'Median',
  category: 'Noise & Grain',
  icon: Tally5,
  description: 'Replaces each pixel with the median of its neighbourhood: removes noise, flattens detail.',
  keywords: ['denoise', 'smooth', 'flatten', 'despeckle'],
  params: [pxP('radius', 'Radius', 1, 50, 2, { step: 1 })],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    return medianImage(img, Math.max(1, num(p.radius, 2) * sc(ctx))) as ImageData;
  },
};

export const noiseFilters: FilterDef[] = [addNoise, filmGrain, dustScratches, median];
