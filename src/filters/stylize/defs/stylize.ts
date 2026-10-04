/** Stylize filters: cel shade, posterize edges, emboss, find/glowing edges, solarize, Kuwahara,
 * oil paint, pixelate, mosaic, crystallize, rough edges, sketch. */
import {
  Brush,
  Gem,
  Grid2x2Check,
  Hexagon,
  Layers2,
  Mountain,
  Paintbrush,
  Scan,
  ScissorsLineDashed,
  Sun,
  Zap,
  PencilLine,
} from 'lucide-react';
import type { FilterContext, FilterDef } from '../../../registry';
import type { ParamValues } from '../../../core/types';
import { createNoise2D } from '../../../core/noise';
import {
  anchor,
  blurPlane,
  bool,
  clamp,
  boundedDistance,
  hash,
  insideDistance,
  isEmpty,
  lumaPlane,
  num,
  rgb,
  samplePlane,
  saturateInPlace,
  sc,
  smoothstep,
  sobel,
  toPlanes,
  blurPlanes,
  valueNoise,
  type Img,
} from '../util';
import { outlineCoverage } from '../edges';
import { kuwahara } from '../kuwahara';
import { angleP, boolP, colorP, numP, pctP, pxP, seedP } from '../params';

/* ------------------------------------------------------------------ */
/* Cel shade                                                           */
/* ------------------------------------------------------------------ */

/**
 * Smooth band quantization of a 0..1 value into `levels` bands. Each band outputs its
 * representative value (`reps[i]`, default: the band center); `smoothness` softens the steps.
 */
export function quantizeSmooth(L: number, levels: number, smoothness: number, reps?: ArrayLike<number>): number {
  const t = L * levels - 0.5;
  const i0 = Math.floor(t);
  const f = t - i0;
  const w2 = smoothness * 0.5;
  const s = w2 > 0.001 ? smoothstep(0.5 - w2, 0.5 + w2, f) : f >= 0.5 ? 1 : 0;
  if (!reps) return (clamp(i0 + s, 0, levels - 1) + 0.5) / levels;
  const a = reps[i0 < 0 ? 0 : i0 > levels - 1 ? levels - 1 : i0];
  const b = reps[i0 + 1 < 0 ? 0 : i0 + 1 > levels - 1 ? levels - 1 : i0 + 1];
  return a + (b - a) * s;
}

/**
 * Representative tone of each band: the mean luminance of the opaque pixels falling in it, so
 * flat bands keep the image's own tonality (blacks stay black, highlights stay bright).
 */
export function bandRepresentatives(lum: Float32Array, data: Uint8ClampedArray, levels: number): Float32Array {
  const sum = new Float64Array(levels),
    cnt = new Float64Array(levels);
  for (let i = 0, j = 3; i < lum.length; i++, j += 4) {
    const a = data[j];
    if (a === 0) continue;
    const L = lum[i];
    const b = L <= 0 ? 0 : L >= 1 ? levels - 1 : Math.min(levels - 1, Math.floor(L * levels));
    sum[b] += L * a;
    cnt[b] += a;
  }
  const reps = new Float32Array(levels);
  for (let b = 0; b < levels; b++) {
    const center = (b + 0.5) / levels;
    // lean slightly towards the band center so neighbouring bands stay distinct
    reps[b] = cnt[b] > 0 ? (sum[b] / cnt[b]) * 0.8 + center * 0.2 : center;
  }
  return reps;
}

/** Re-light a color to luminance Lq (0..1) keeping hue: darken by ratio, lighten towards white. */
function relight(d: Uint8ClampedArray, j: number, L0: number, Lq: number) {
  if (Lq < L0) {
    const k = Lq / Math.max(L0, 1e-4);
    d[j] *= k;
    d[j + 1] *= k;
    d[j + 2] *= k;
  } else if (Lq > L0) {
    const k = (Lq - L0) / Math.max(1 - L0, 1e-4);
    d[j] += (255 - d[j]) * k;
    d[j + 1] += (255 - d[j + 1]) * k;
    d[j + 2] += (255 - d[j + 2]) * k;
  }
}

export function applyCelShade<T extends Img>(img: T, p: ParamValues, ctx: FilterContext): T {
  if (isEmpty(img)) return img;
  const { width: w, height: h, data } = img;
  const s = sc(ctx);
  const levels = clamp(Math.round(num(p.levels, 4)), 2, 8);
  const smooth = clamp(num(p.smoothness, 0.2), 0, 1);
  const outline = bool(p.outline, true);
  const thick = num(p.outlineThickness, 2) * s;
  const oc = rgb(p.outlineColor, '#000000');
  const thr = clamp(num(p.edgeThreshold, 0.35), 0, 1);
  const sat = 1 + num(p.saturation, 10) / 100;
  const lum0 = lumaPlane(img);
  // outline is detected on the source before re-lighting
  const cov = outline && thick > 0 ? outlineCoverage(img, { thickness: thick, threshold: thr, smooth: Math.max(0.8, 1.1 * s), minLength: Math.max(3, Math.round(6 * s)) }) : null;
  const lumS = Float32Array.from(lum0);
  blurPlane(lumS, w, h, Math.max(0.5, 0.9 * s));
  const n = w * h;
  const reps = bandRepresentatives(lumS, data, levels);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (data[j + 3] === 0) continue;
    const Lq = quantizeSmooth(lumS[i], levels, smooth, reps);
    relight(data, j, lum0[i], Lq);
  }
  saturateInPlace(data, sat);
  if (cov) {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = cov[i];
      if (v <= 0 || data[j + 3] === 0) continue;
      data[j] += (oc[0] - data[j]) * v;
      data[j + 1] += (oc[1] - data[j + 1]) * v;
      data[j + 2] += (oc[2] - data[j + 2]) * v;
    }
  }
  return img;
}

export const celShade: FilterDef = {
  id: 'cel-shade',
  name: 'Cel Shade',
  category: 'Stylize',
  icon: Layers2,
  description: 'Toon shading: flat luminance bands that keep each color’s hue, plus clean ink outlines.',
  keywords: ['toon', 'anime', 'cartoon', 'posterize', 'outline', 'roblox', 'flat shading'],
  params: [
    numP('levels', 'Tone levels', 2, 8, 4, { step: 1 }),
    pctP('smoothness', 'Smoothness', 0.2),
    numP('saturation', 'Saturation', -100, 100, 10),
    boolP('outline', 'Outline', true, { group: 'Outline' }),
    pxP('outlineThickness', 'Thickness', 0, 10, 2, { group: 'Outline', showIf: (v) => v.outline !== false }),
    colorP('outlineColor', 'Color', '#000000', { group: 'Outline', showIf: (v) => v.outline !== false }),
    pctP('edgeThreshold', 'Edge threshold', 0.35, { group: 'Outline', showIf: (v) => v.outline !== false }),
  ],
  apply: applyCelShade,
};

/* ------------------------------------------------------------------ */
/* Posterize edges (contour posterize)                                 */
/* ------------------------------------------------------------------ */

export const posterizeEdges: FilterDef = {
  id: 'posterize-edges',
  name: 'Posterize Edges',
  category: 'Stylize',
  icon: Mountain,
  description: 'Anti-aliased color posterization with contour lines drawn between tone bands.',
  keywords: ['contour', 'bands', 'posterize', 'topographic', 'toon'],
  params: [
    numP('levels', 'Levels', 2, 12, 5, { step: 1 }),
    pctP('smoothness', 'Smoothness', 0.25),
    pxP('lineWidth', 'Line width', 0, 6, 1),
    colorP('lineColor', 'Line color', '#111111'),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const s = sc(ctx);
    const L = clamp(Math.round(num(p.levels, 5)), 2, 12);
    const sm = clamp(num(p.smoothness, 0.25), 0, 1);
    const lw = num(p.lineWidth, 1) * s;
    const lc = rgb(p.lineColor, '#111111');
    const pl = toPlanes(img, false);
    const blurS = Math.max(0.5, 0.8 * s);
    blurPlane(pl.r, w, h, blurS);
    blurPlane(pl.g, w, h, blurS);
    blurPlane(pl.b, w, h, blurS);
    const band = new Uint8Array(n);
    const q = (v: number) => {
      const t = v * (L - 1);
      const i0 = Math.floor(t);
      const f = t - i0;
      const w2 = sm * 0.5;
      const st = w2 > 0.001 ? smoothstep(0.5 - w2, 0.5 + w2, f) : f >= 0.5 ? 1 : 0;
      return clamp(i0 + st, 0, L - 1) / (L - 1);
    };
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] === 0) continue;
      const r = pl.r[i],
        g = pl.g[i],
        b = pl.b[i];
      data[j] = q(r) * 255;
      data[j + 1] = q(g) * 255;
      data[j + 2] = q(b) * 255;
      band[i] = Math.round((r * 0.2126 + g * 0.7152 + b * 0.0722) * (L - 1));
    }
    if (lw > 0.05) {
      const seeds = new Uint8Array(n);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (data[i * 4 + 3] === 0) continue;
          if ((x < w - 1 && band[i] !== band[i + 1] && data[i * 4 + 7] !== 0) || (y < h - 1 && band[i] !== band[i + w] && data[(i + w) * 4 + 3] !== 0))
            seeds[i] = 1;
        }
      const half = lw * 0.5,
        faint = Math.min(1, lw);
      const dt = boundedDistance(seeds, w, h, half + 1);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const c = half + 0.5 - dt[i];
        if (c <= 0 || data[j + 3] === 0) continue;
        const v = (c > 1 ? 1 : c) * faint;
        data[j] += (lc[0] - data[j]) * v;
        data[j + 1] += (lc[1] - data[j + 1]) * v;
        data[j + 2] += (lc[2] - data[j + 2]) * v;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Emboss / find edges / glowing edges / solarize                      */
/* ------------------------------------------------------------------ */

export const emboss: FilterDef = {
  id: 'emboss',
  name: 'Emboss',
  category: 'Stylize',
  icon: Gem,
  description: 'Raised relief lit from an angle (gray, or kept over the colors).',
  keywords: ['relief', 'bevel', 'stamp', 'metal'],
  params: [angleP('angle', 'Angle', 135), pxP('height', 'Height', 1, 10, 3), numP('amount', 'Amount', 1, 500, 100, { unit: '%' }), boolP('keepColor', 'Keep colors', false)],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const s = sc(ctx);
    const hgt = Math.max(0.5, num(p.height, 3) * s);
    const amt = num(p.amount, 100) / 100;
    const th = (num(p.angle, 135) * Math.PI) / 180;
    const dx = Math.cos(th) * hgt,
      dy = -Math.sin(th) * hgt;
    const L = lumaPlane(img);
    const keep = bool(p.keepColor, false);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        if (data[j + 3] === 0) continue;
        const v = (samplePlane(L, w, h, x - dx, y - dy) - samplePlane(L, w, h, x + dx, y + dy)) * amt * 1.5;
        if (keep) {
          const o = v * 255;
          data[j] += o;
          data[j + 1] += o;
          data[j + 2] += o;
        } else {
          const g = (0.5 + v) * 255;
          data[j] = data[j + 1] = data[j + 2] = g;
        }
      }
    return img;
  },
};

export const findEdges: FilterDef = {
  id: 'find-edges',
  name: 'Find Edges',
  category: 'Stylize',
  icon: Scan,
  description: 'Outlines color transitions as dark lines on white (or glowing on black).',
  keywords: ['edges', 'outline', 'sobel', 'lineart'],
  params: [numP('strength', 'Strength', 0.1, 4, 1.2, { step: 0.05 }), boolP('mono', 'Monochrome', false), boolP('invert', 'Light on dark', false)],
  apply(img, p) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const k = num(p.strength, 1.2) * 1.6;
    const mono = bool(p.mono, false);
    const inv = bool(p.invert, false);
    const pl = toPlanes(img, false);
    const chans = mono ? [lumaPlane(img)] : [pl.r, pl.g, pl.b];
    const mags = chans.map((c) => sobel(c, w, h).mag);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] === 0) continue;
      for (let ch = 0; ch < 3; ch++) {
        const m = clamp(mags[mono ? 0 : ch][i] * k, 0, 1);
        data[j + ch] = (inv ? m : 1 - m) * 255;
      }
    }
    return img;
  },
};

function maxFilter(buf: Float32Array, w: number, h: number, r: number) {
  if (r < 1) return buf;
  const tmp = new Float32Array(buf.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const x0 = Math.max(0, x - r),
        x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) if (buf[row + k] > m) m = buf[row + k];
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      const y0 = Math.max(0, y - r),
        y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      buf[y * w + x] = m;
    }
  return buf;
}

export const glowingEdges: FilterDef = {
  id: 'glowing-edges',
  name: 'Glowing Edges',
  category: 'Stylize',
  icon: Zap,
  description: 'Neon-lit color edges on black.',
  keywords: ['neon', 'edges', 'glow', 'tron', 'cyber'],
  params: [pxP('width', 'Edge width', 1, 14, 2), numP('brightness', 'Brightness', 0, 4, 1.4, { step: 0.05 }), pxP('smoothness', 'Smoothness', 0, 15, 3)],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const s = sc(ctx);
    const pl = toPlanes(img, true);
    blurPlanes(pl, w, h, Math.max(0.4, num(p.smoothness, 3) * 0.5 * s));
    const r = Math.max(0, Math.round((num(p.width, 2) * s) / 2));
    const k = num(p.brightness, 1.4) * 2.2;
    const edges = [pl.r, pl.g, pl.b].map((c) => maxFilter(sobel(c, w, h).mag, w, h, r));
    const glow = edges.map((e) => blurPlane(Float32Array.from(e), w, h, Math.max(1, num(p.width, 2) * 2 * s)));
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] === 0) continue;
      for (let ch = 0; ch < 3; ch++) {
        const v = edges[ch][i] * k + glow[ch][i] * k * 0.8;
        data[j + ch] = clamp(v, 0, 1) * 255;
      }
    }
    return img;
  },
};

export const solarize: FilterDef = {
  id: 'solarize',
  name: 'Solarize',
  category: 'Stylize',
  icon: Sun,
  description: 'Sabattier effect: tones above the threshold are inverted.',
  keywords: ['invert', 'darkroom', 'psychedelic'],
  params: [numP('threshold', 'Threshold', 0, 255, 128, { step: 1 }), boolP('normalize', 'Normalize', true)],
  apply(img, p) {
    const t = clamp(num(p.threshold, 128), 0, 255);
    const norm = bool(p.normalize, true);
    const k = norm ? 255 / Math.max(1, Math.max(t, 255 - t)) : 1;
    const d = img.data;
    for (let j = 0; j < d.length; j += 4) {
      if (d[j + 3] === 0) continue;
      for (let ch = 0; ch < 3; ch++) {
        const v = d[j + ch];
        d[j + ch] = (v > t ? 255 - v : v) * k;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Kuwahara & oil paint                                                */
/* ------------------------------------------------------------------ */

export const kuwaharaFilter: FilterDef = {
  id: 'kuwahara',
  name: 'Kuwahara',
  category: 'Stylize',
  icon: Paintbrush,
  description: 'Edge-preserving painterly smoothing (smooth Kuwahara).',
  keywords: ['paint', 'smooth', 'abstract', 'watercolor', 'denoise'],
  params: [pxP('radius', 'Radius', 1, 20, 4, { step: 1 })],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    return kuwahara(img, Math.max(1, num(p.radius, 4) * sc(ctx)));
  },
};

export const oilPaint: FilterDef = {
  id: 'oil-paint',
  name: 'Oil Paint',
  category: 'Stylize',
  icon: Brush,
  description: 'Painterly abstraction with flowing brush texture and impasto lighting.',
  keywords: ['paint', 'impasto', 'brush', 'artistic', 'kuwahara'],
  params: [pxP('radius', 'Brush size', 1, 12, 4, { step: 1 }), pctP('detail', 'Bristle detail', 0.5), pctP('shine', 'Shine', 0.35), angleP('angle', 'Light angle', 135)],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const s = sc(ctx);
    const { ax, ay } = anchor(ctx);
    const r = Math.max(1, num(p.radius, 4) * s);
    kuwahara(img, r);
    const detail = clamp(num(p.detail, 0.5), 0, 1);
    const shine = clamp(num(p.shine, 0.35), 0, 1);
    if (detail <= 0 && shine <= 0) return img;
    const L = lumaPlane(img);
    const Ls = blurPlane(Float32Array.from(L), w, h, Math.max(1, r));
    const { gx, gy } = sobel(Ls, w, h);
    const H = new Float32Array(w * h);
    const len = Math.max(2, r * 2.2),
      wid = Math.max(0.6, r * 0.25);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        // stroke direction follows the image structure (perpendicular to the gradient)
        const ang = Math.atan2(gy[i], gx[i]) + Math.PI / 2;
        const c = Math.cos(ang),
          sn = Math.sin(ang);
        const X = x + ax,
          Y = y + ay;
        const u = (X * c + Y * sn) / len,
          v = (-X * sn + Y * c) / wid;
        H[i] = L[i] * 0.5 + (valueNoise(u, v, 77) - 0.5) * detail * 0.45;
      }
    blurPlane(H, w, h, Math.max(0.5, 0.6 * s));
    const th = (num(p.angle, 135) * Math.PI) / 180;
    const lx = Math.cos(th),
      ly = -Math.sin(th);
    const k = (0.6 + shine * 2.2) * 255;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        if (data[j + 3] === 0) continue;
        const hx = H[y * w + Math.min(w - 1, x + 1)] - H[y * w + Math.max(0, x - 1)];
        const hy = H[Math.min(h - 1, y + 1) * w + x] - H[Math.max(0, y - 1) * w + x];
        let shade = (hx * lx + hy * ly) * k;
        // specular glint on ridges facing the light
        if (shade > 0) shade *= 1 + shine;
        data[j] += shade;
        data[j + 1] += shade;
        data[j + 2] += shade;
      }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Pixelate / mosaic                                                   */
/* ------------------------------------------------------------------ */

interface Blocks {
  bx0: number;
  by0: number;
  nbx: number;
  nby: number;
  col: Int32Array;
  row: Int32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  cnt: Float32Array;
}

/** Document-anchored square block averages (premultiplied). */
function blockAverages(img: Img, S: number, ax: number, ay: number): Blocks {
  const { width: w, height: h, data } = img;
  const bx0 = Math.floor((0.5 + ax) / S),
    by0 = Math.floor((0.5 + ay) / S);
  const nbx = Math.floor((w - 0.5 + ax) / S) - bx0 + 1,
    nby = Math.floor((h - 0.5 + ay) / S) - by0 + 1;
  const col = new Int32Array(w),
    row = new Int32Array(h);
  for (let x = 0; x < w; x++) col[x] = Math.floor((x + 0.5 + ax) / S) - bx0;
  for (let y = 0; y < h; y++) row[y] = Math.floor((y + 0.5 + ay) / S) - by0;
  const nb = nbx * nby;
  const r = new Float32Array(nb),
    g = new Float32Array(nb),
    b = new Float32Array(nb),
    a = new Float32Array(nb),
    cnt = new Float32Array(nb);
  for (let y = 0; y < h; y++) {
    const ro = row[y] * nbx;
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      const k = ro + col[x];
      const al = data[j + 3];
      cnt[k]++;
      if (al === 0) continue;
      r[k] += data[j] * al;
      g[k] += data[j + 1] * al;
      b[k] += data[j + 2] * al;
      a[k] += al;
    }
  }
  return { bx0, by0, nbx, nby, col, row, r, g, b, a, cnt };
}

export const pixelate: FilterDef = {
  id: 'pixelate',
  name: 'Pixelate',
  category: 'Stylize',
  icon: Grid2x2Check,
  description: 'Big square pixels aligned to the document grid.',
  keywords: ['pixel', 'mosaic', 'censor', '8-bit', 'blocks'],
  params: [pxP('size', 'Cell size', 1, 200, 12)],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { ax, ay, s } = anchor(ctx);
    const S = Math.max(1, num(p.size, 12) * s);
    if (S <= 1.01) return img;
    const B = blockAverages(img, S, ax, ay);
    const { width: w, height: h, data } = img;
    for (let y = 0; y < h; y++) {
      const ro = B.row[y] * B.nbx;
      for (let x = 0; x < w; x++) {
        const k = ro + B.col[x];
        const j = (y * w + x) * 4;
        const A = B.a[k];
        if (A <= 0) {
          data[j + 3] = 0;
          continue;
        }
        data[j] = B.r[k] / A;
        data[j + 1] = B.g[k] / A;
        data[j + 2] = B.b[k] / A;
        data[j + 3] = A / B.cnt[k];
      }
    }
    return img;
  },
};

export const mosaic: FilterDef = {
  id: 'mosaic',
  name: 'Mosaic Tiles',
  category: 'Stylize',
  icon: Grid2x2Check,
  description: 'Beveled square tiles with grout lines, like a tile mosaic.',
  keywords: ['tiles', 'pixel', 'bathroom', 'grout'],
  params: [
    pxP('size', 'Tile size', 4, 200, 24),
    pctP('grout', 'Grout width', 0.12, {}, 0, 0.5),
    colorP('groutColor', 'Grout color', '#1e1e1e'),
    pctP('bevel', 'Bevel', 0.35),
    pctP('jitter', 'Color variation', 0.15),
    seedP(1),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { ax, ay, s } = anchor(ctx);
    const S = Math.max(2, num(p.size, 24) * s);
    const B = blockAverages(img, S, ax, ay);
    const { width: w, height: h, data } = img;
    const gw = clamp(num(p.grout, 0.12), 0, 0.5) * S;
    const gc = rgb(p.groutColor, '#1e1e1e');
    const bev = clamp(num(p.bevel, 0.35), 0, 1);
    const jit = clamp(num(p.jitter, 0.15), 0, 1);
    const seed = num(p.seed, 1) | 0;
    const bw = Math.max(0.5, S * 0.18);
    for (let y = 0; y < h; y++) {
      const ro = B.row[y] * B.nbx;
      const fy = y + 0.5 + ay - (B.row[y] + B.by0) * S; // px within tile
      for (let x = 0; x < w; x++) {
        const k = ro + B.col[x];
        const j = (y * w + x) * 4;
        const A = B.a[k];
        if (A <= 0) {
          data[j + 3] = 0;
          continue;
        }
        const fx = x + 0.5 + ax - (B.col[x] + B.bx0) * S;
        const jv = (hash(B.col[x] + B.bx0, B.row[y] + B.by0, seed) - 0.5) * 2 * jit * 40;
        let r = B.r[k] / A + jv,
          g = B.g[k] / A + jv,
          b = B.b[k] / A + jv;
        // distance to the tile border (inside), grout centered on the border
        const dl = fx,
          dt = fy,
          dr = S - fx,
          db = S - fy;
        const edge = Math.min(dl, dt, dr, db) - gw * 0.5;
        if (bev > 0) {
          const hl = Math.max(1 - Math.min(dl, dt) / bw, 0) * 70 * bev; // top-left highlight
          const shd = Math.max(1 - Math.min(dr, db) / bw, 0) * 90 * bev; // bottom-right shadow
          r += hl - shd;
          g += hl - shd;
          b += hl - shd;
        }
        const t = clamp(edge + 0.5, 0, 1);
        data[j] = gc[0] + (r - gc[0]) * t;
        data[j + 1] = gc[1] + (g - gc[1]) * t;
        data[j + 2] = gc[2] + (b - gc[2]) * t;
        data[j + 3] = A / B.cnt[k];
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Crystallize                                                         */
/* ------------------------------------------------------------------ */

export const crystallize: FilterDef = {
  id: 'crystallize',
  name: 'Crystallize',
  category: 'Stylize',
  icon: Hexagon,
  description: 'Seeded Voronoi cells filled with their average color (stained glass with borders).',
  keywords: ['voronoi', 'cells', 'stained glass', 'shatter', 'polygon'],
  params: [pxP('size', 'Cell size', 3, 200, 20), pxP('border', 'Border', 0, 10, 0), colorP('borderColor', 'Border color', '#111111'), seedP(1)],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const S = Math.max(2, num(p.size, 20) * s);
    const seed = num(p.seed, 1) | 0;
    const border = num(p.border, 0) * s;
    const bc = rgb(p.borderColor, '#111111');
    const cx0 = Math.floor(ax / S) - 1,
      cy0 = Math.floor(ay / S) - 1;
    const ncx = Math.floor((ax + w) / S) - cx0 + 2,
      ncy = Math.floor((ay + h) / S) - cy0 + 2;
    const nc = ncx * ncy;
    const px = new Float32Array(nc),
      py = new Float32Array(nc);
    for (let cy = 0; cy < ncy; cy++)
      for (let cx = 0; cx < ncx; cx++) {
        const gx = cx + cx0,
          gy = cy + cy0;
        const k = cy * ncx + cx;
        px[k] = (gx + 0.1 + 0.8 * hash(gx, gy, seed)) * S - ax;
        py[k] = (gy + 0.1 + 0.8 * hash(gx, gy, seed + 1)) * S - ay;
      }
    const near = new Int32Array(n),
      second = new Int32Array(n);
    const edgeD = new Float32Array(n);
    const sr = new Float32Array(nc),
      sg = new Float32Array(nc),
      sb = new Float32Array(nc),
      sa = new Float32Array(nc),
      cnt = new Float32Array(nc);
    for (let y = 0; y < h; y++) {
      const yc = y + 0.5;
      const gyc = Math.floor((yc + ay) / S) - cy0;
      for (let x = 0; x < w; x++) {
        const xc = x + 0.5;
        const gxc = Math.floor((xc + ax) / S) - cx0;
        let b1 = -1,
          b2 = -1,
          d1 = Infinity,
          d2 = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = gyc + dy;
          if (yy < 0 || yy >= ncy) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = gxc + dx;
            if (xx < 0 || xx >= ncx) continue;
            const k = yy * ncx + xx;
            const ex = px[k] - xc,
              ey = py[k] - yc;
            const d = ex * ex + ey * ey;
            if (d < d1) {
              d2 = d1;
              b2 = b1;
              d1 = d;
              b1 = k;
            } else if (d < d2) {
              d2 = d;
              b2 = k;
            }
          }
        }
        const i = y * w + x;
        near[i] = b1;
        second[i] = b2;
        if (b2 >= 0) {
          const qx = px[b2] - px[b1],
            qy = py[b2] - py[b1];
          edgeD[i] = (d2 - d1) / (2 * Math.sqrt(qx * qx + qy * qy) + 1e-6);
        } else edgeD[i] = 1e6;
        const j = i * 4;
        const al = data[j + 3];
        cnt[b1]++;
        if (al === 0) continue;
        sr[b1] += data[j] * al;
        sg[b1] += data[j + 1] * al;
        sb[b1] += data[j + 2] * al;
        sa[b1] += al;
      }
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const k1 = near[i],
        k2 = second[i];
      const A1 = sa[k1];
      const e = edgeD[i];
      // anti-alias across the cell boundary using the second-nearest cell
      const wt = clamp(0.5 + e, 0, 1);
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      const add = (k: number, f: number) => {
        const A = sa[k];
        if (A <= 0 || f <= 0) return;
        r += (sr[k] / A) * f;
        g += (sg[k] / A) * f;
        b += (sb[k] / A) * f;
        a += (A / cnt[k]) * f;
      };
      add(k1, wt);
      if (wt < 1 && k2 >= 0) add(k2, 1 - wt);
      const norm = (A1 > 0 ? wt : 0) + (k2 >= 0 && sa[k2] > 0 ? 1 - wt : 0);
      if (norm <= 0) {
        data[j] = data[j + 1] = data[j + 2] = data[j + 3] = 0;
        continue;
      }
      r /= norm;
      g /= norm;
      b /= norm;
      if (border > 0) {
        const t = clamp(e - border * 0.5 + 0.5, 0, 1);
        r = bc[0] + (r - bc[0]) * t;
        g = bc[1] + (g - bc[1]) * t;
        b = bc[2] + (b - bc[2]) * t;
      }
      data[j] = r;
      data[j + 1] = g;
      data[j + 2] = b;
      data[j + 3] = a;
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Rough edges (torn paper)                                            */
/* ------------------------------------------------------------------ */

const noiseCache = new Map<number, (x: number, y: number) => number>();
function simplex(seed: number) {
  let f = noiseCache.get(seed);
  if (!f) {
    f = createNoise2D(seed);
    if (noiseCache.size > 16) noiseCache.clear();
    noiseCache.set(seed, f);
  }
  return f;
}

export const roughEdges: FilterDef = {
  id: 'rough-edges',
  name: 'Rough Edges',
  category: 'Stylize',
  icon: ScissorsLineDashed,
  description: 'Tears the alpha edge with fractal noise for a torn-paper cut-out look (optional paper rim).',
  keywords: ['torn', 'paper', 'cutout', 'ripped', 'grunge', 'edge', 'collage'],
  params: [
    pxP('amount', 'Amount', 0, 100, 14),
    pxP('scale', 'Scale', 1, 200, 30),
    pctP('detail', 'Detail', 0.6),
    pxP('rim', 'Paper rim', 0, 20, 0),
    colorP('rimColor', 'Rim color', '#f3efe6', { showIf: (v) => num(v.rim, 0) > 0 }),
    seedP(1),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const { ax, ay, s } = anchor(ctx);
    const amt = num(p.amount, 14) * s;
    if (amt <= 0.05) return img;
    const scale = Math.max(1, num(p.scale, 30));
    const detail = clamp(num(p.detail, 0.6), 0, 1);
    const rim = num(p.rim, 0) * s;
    const rc = rgb(p.rimColor, '#f3efe6');
    const seed = num(p.seed, 1) | 0;
    const nz = simplex(seed);
    const octaves = 2 + Math.round(detail * 4);
    const gain = 0.35 + detail * 0.3;
    const dIn = insideDistance(img, true, amt + rim + 2);
    const reach = amt + rim + 1.5;
    for (let y = 0; y < h; y++) {
      const dy = (y + 0.5 + ay) / s / scale;
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        if (data[j + 3] === 0) continue;
        const d = dIn[i];
        if (d > reach) continue;
        const dx = (x + 0.5 + ax) / s / scale;
        let sum = 0,
          norm = 0,
          amp = 1,
          f = 1;
        for (let o = 0; o < octaves; o++) {
          sum += nz(dx * f + o * 17.1, dy * f - o * 9.7) * amp;
          norm += amp;
          amp *= gain;
          f *= 2.1;
        }
        let nv = clamp((sum / norm) * 1.25 + 0.5, 0, 1);
        // fine fibrous jaggedness
        nv = clamp(nv + (valueNoise((x + ax) / Math.max(1, 1.6 * s), (y + ay) / Math.max(1, 1.6 * s), seed + 9) - 0.5) * 0.25 * detail, 0, 1);
        const e = d - amt * nv; // distance to the torn edge
        const cov = clamp(e + 0.5, 0, 1);
        if (cov < 1) data[j + 3] *= cov;
        if (rim > 0 && e < rim + 0.5) {
          const t = clamp(rim + 0.5 - e, 0, 1);
          data[j] += (rc[0] - data[j]) * t;
          data[j + 1] += (rc[1] - data[j + 1]) * t;
          data[j + 2] += (rc[2] - data[j + 2]) * t;
        }
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Sketch (cross-hatching)                                             */
/* ------------------------------------------------------------------ */

export const sketch: FilterDef = {
  id: 'sketch',
  name: 'Cross-Hatch Sketch',
  category: 'Stylize',
  icon: PencilLine,
  description: 'Pen-and-ink cross-hatching: line layers build up with darkness, plus contour lines.',
  keywords: ['hatching', 'pen', 'ink', 'engraving', 'drawing', 'etching'],
  params: [
    pxP('density', 'Line spacing', 2, 20, 6),
    angleP('angle', 'Angle', 45),
    pctP('strength', 'Strength', 0.85),
    colorP('ink', 'Ink', '#262626'),
    colorP('paper', 'Paper', '#f7f4ec'),
    boolP('edges', 'Contours', true),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const sp = Math.max(1.5, num(p.density, 6) * s);
    const strength = clamp(num(p.strength, 0.85), 0, 1);
    const ink = rgb(p.ink, '#262626'),
      paper = rgb(p.paper, '#f7f4ec');
    const base = num(p.angle, 45);
    const L = lumaPlane(img);
    blurPlane(L, w, h, Math.max(0.6, sp * 0.35));
    const edges = bool(p.edges, true) ? outlineCoverage(img, { thickness: Math.max(0.8, 1.1 * s), threshold: 0.3, smooth: Math.max(0.7, s) }) : null;
    const layers = [
      { a: base, t: 0.18 },
      { a: base + 90, t: 0.42 },
      { a: base - 45, t: 0.62 },
      { a: base + 45, t: 0.8 },
    ].map((l) => ({ c: Math.cos((l.a * Math.PI) / 180), s: Math.sin((l.a * Math.PI) / 180), t: l.t }));
    for (let y = 0; y < h; y++) {
      const gy = y + 0.5 + ay;
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        if (data[j + 3] === 0) continue;
        const gx = x + 0.5 + ax;
        const d = 1 - L[i];
        let keep = 1;
        const wob = (valueNoise(gx / (sp * 6), gy / (sp * 6), 3) - 0.5) * 0.35;
        for (let k = 0; k < 4; k++) {
          const ly = layers[k];
          if (d <= ly.t) break;
          const v = (-gx * ly.s + gy * ly.c) / sp + wob;
          const dist = Math.abs(v - Math.round(v)) * sp;
          const hw = 0.35 * s + Math.min(1, (d - ly.t) * 2.5) * sp * 0.18;
          const c = clamp(hw - dist + 0.5, 0, 1);
          keep *= 1 - c * strength;
        }
        let cov = 1 - keep;
        if (edges) cov = Math.max(cov, edges[i] * strength);
        for (let ch = 0; ch < 3; ch++) data[j + ch] = paper[ch] + (ink[ch] - paper[ch]) * cov;
      }
    }
    return img;
  },
};

export const stylizeFilters: FilterDef[] = [
  celShade,
  posterizeEdges,
  emboss,
  findEdges,
  glowingEdges,
  solarize,
  kuwaharaFilter,
  oilPaint,
  pixelate,
  mosaic,
  crystallize,
  roughEdges,
  sketch,
];
