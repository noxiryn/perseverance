/** Noise & grain filters: add noise, film grain, dust & scratches, median. */
import { Binary, Film, Sparkles, Tally5 } from 'lucide-react';
import type { FilterDef } from '../../../registry';
import { anchor, bool, clamp, hash, hashGauss, hashGaussRow, isEmpty, num, sc, str } from '../util';
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
    // hash(X, Y, seed) = mix(X·A ^ Y·B ^ seed·C): the X term per column, Y per row, seed once
    const TX = new Int32Array(w);
    for (let x = 0; x < w; x++) TX[x] = Math.imul(Math.floor((x + 0.5 + ax) * inv) | 0, 374761393);
    const sTerm = (sd: number) => Math.imul(sd | 0, 1442695041);
    // seeds of the (up to) 9 hashes: channel c uses seed + 101c, gaussian sums seed', +7919, +15485
    const S = new Int32Array(9);
    for (let c = 0; c < 3; c++) {
      const sc0 = seed + 101 * c;
      S[c * 3] = sTerm(sc0);
      S[c * 3 + 1] = sTerm(sc0 + 7919);
      S[c * 3 + 2] = sTerm(sc0 + 15485);
    }
    for (let y = 0; y < h; y++) {
      const ty = Math.imul(Math.floor((y + 0.5 + ay) * inv) | 0, 668265263);
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const b = TX[x] ^ ty;
        if (mono) {
          const v = (gauss ? noiseGauss(b, S, 0) : hashMix(b ^ S[0]) - 0.5) * k;
          data[j] += v;
          data[j + 1] += v;
          data[j + 2] += v;
        } else {
          data[j] += (gauss ? noiseGauss(b, S, 0) : hashMix(b ^ S[0]) - 0.5) * k;
          data[j + 1] += (gauss ? noiseGauss(b, S, 3) : hashMix(b ^ S[3]) - 0.5) * k;
          data[j + 2] += (gauss ? noiseGauss(b, S, 6) : hashMix(b ^ S[6]) - 0.5) * k;
        }
      }
    }
    return img;
  },
};

/** The finalizer of util.hash: mixed 32-bit value → [0, 1). */
function hashMix(h: number): number {
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** hashGauss() from the shared X·A ^ Y·B term and the three precomputed seed terms S[o..o+2]. */
function noiseGauss(b: number, S: Int32Array, o: number): number {
  return (hashMix(b ^ S[o]) + hashMix(b ^ S[o + 1]) + hashMix(b ^ S[o + 2]) - 1.5) * 1.1547;
}

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
    // Grain coordinates per column / row (exactly the per-pixel expressions); each noise octave
    // reads its gaussian lattice from cached rows instead of hashing 4 corners per pixel.
    const X = new Float64Array(w);
    for (let x = 0; x < w; x++) X[x] = (x + 0.5 + ax) * f;
    const n1 = new GrainField(X, 1, 0, seed);
    const n2 = new GrainField(X, 2.1, 17.3, seed + 7);
    const nr = colorAmt > 0 ? new GrainField(X, 1, 31.7, seed + 13) : null;
    const nb = colorAmt > 0 ? new GrainField(X, 1, -21.1, seed + 29) : null;
    for (let y = 0; y < h; y++) {
      const Y = (y + 0.5 + ay) * f;
      n1.row(Y);
      n2.row(Y * 2.1 - 9.1);
      if (nr && nb) {
        nr.row(Y + 11.3);
        nb.row(Y + 41.9);
      }
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const g = n1.at(x) * 0.7 + n2.at(x) * 0.45;
        const l = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255;
        // response: strongest in the midtones, configurable in shadows, weak in highlights
        const resp = l < 0.5 ? shadows + (1 - shadows) * (l * 2) : 1 - (l - 0.5) * 1.4;
        const v = g * k * Math.max(0.05, resp);
        if (nr && nb) {
          const cr = nr.at(x) * colorAmt;
          const cb = nb.at(x) * colorAmt;
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

/**
 * grainNoise() along image rows: column x samples (X[x]·mul + off, Yrow). The gaussian lattice
 * values of the current pair of lattice rows are cached (hashGaussRow), so each lattice point is
 * hashed about once instead of four times per pixel; the interpolation is the same arithmetic,
 * so values are identical. Lattices finer than ~2 cells per pixel are sampled directly (caching
 * whole lattice rows would cost more than the 4 corners per pixel).
 */
class GrainField {
  private readonly xs: Float64Array;
  private readonly k: Int32Array;
  private readonly tx: Float64Array;
  private readonly x0: number;
  private readonly len: number;
  private r0: Float64Array;
  private r1: Float64Array;
  private yi = 0;
  private ty = 0;
  private filled = false;
  private Y = 0;
  private readonly direct: boolean;
  constructor(
    X: Float64Array,
    mul: number,
    off: number,
    private readonly seed: number,
  ) {
    const w = X.length;
    this.xs = new Float64Array(w);
    for (let x = 0; x < w; x++) this.xs[x] = mul === 1 ? X[x] + off : X[x] * mul + off;
    const span = w > 1 ? Math.abs(this.xs[w - 1] - this.xs[0]) / (w - 1) : 0;
    this.direct = span > 1.9;
    this.k = new Int32Array(w);
    this.tx = new Float64Array(w);
    let lo = Infinity,
      hi = -Infinity;
    for (let x = 0; x < w; x++) {
      const xi = Math.floor(this.xs[x]);
      if (xi < lo) lo = xi;
      if (xi > hi) hi = xi;
    }
    this.x0 = w ? lo : 0;
    this.len = w ? hi - lo + 2 : 0;
    for (let x = 0; x < w; x++) {
      const xi = Math.floor(this.xs[x]);
      this.k[x] = xi - this.x0;
      this.tx[x] = this.xs[x] - xi;
    }
    this.r0 = new Float64Array(this.direct ? 0 : this.len);
    this.r1 = new Float64Array(this.direct ? 0 : this.len);
  }
  /** Select the row coordinate for the following at() calls. */
  row(Y: number) {
    this.Y = Y;
    if (this.direct) return;
    const yi = Math.floor(Y);
    this.ty = Y - yi;
    if (this.filled && yi === this.yi) return;
    if (this.filled && yi === this.yi + 1) {
      const t = this.r0;
      this.r0 = this.r1;
      this.r1 = t;
      hashGaussRow(this.r1, this.x0, this.len, yi + 1, this.seed);
    } else {
      hashGaussRow(this.r0, this.x0, this.len, yi, this.seed);
      hashGaussRow(this.r1, this.x0, this.len, yi + 1, this.seed);
    }
    this.yi = yi;
    this.filled = true;
  }
  at(x: number): number {
    if (this.direct) return grainNoise(this.xs[x], this.Y, this.seed);
    const k = this.k[x],
      tx = this.tx[x];
    const r0 = this.r0,
      r1 = this.r1;
    const a = r0[k],
      b = r0[k + 1],
      c = r1[k],
      d = r1[k + 1];
    const t0 = a + (b - a) * tx,
      t1 = c + (d - c) * tx;
    return t0 + (t1 - t0) * this.ty;
  }
}

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
