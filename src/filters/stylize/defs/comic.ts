/** Comic & Print filters: halftone, comic dots, newsprint, dither, risograph, screen print, ink outline. */
import { CircleDot, Grid2x2, Grid3x3, Newspaper, PenTool, Printer, Shirt } from 'lucide-react';
import type { FilterContext, FilterDef } from '../../../registry';
import type { ParamValues } from '../../../core/types';
import {
  anchor,
  blurPlane,
  blurPlanes,
  blurredOne,
  isOpaque,
  bool,
  clamp,
  coarseField,
  contrastFactor,
  fbmValue,
  hash,
  isEmpty,
  mixWith,
  num,
  pixelWords,
  rgb,
  samplePlane,
  saturateInPlace,
  str,
  toPlanes,
  type Img,
} from '../util';
import { screenPlane, SPOT_SHAPES, toneSigma, type SpotShape } from '../screen';
import { outlineCoverage } from '../edges';
import { angleP, boolP, colorP, numP, pctP, pxP, seedP, selectP } from '../params';

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

/** Straight (un-premultiplied) blurred color planes 0..255 + alpha 0..1. */
function blurredColor(img: Img, sigma: number) {
  const { width: w, height: h } = img;
  const p = toPlanes(img, true);
  blurPlanes(p, w, h, sigma);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const a = p.a[i];
    if (a > 1e-4) {
      const m = 255 / a;
      p.r[i] *= m;
      p.g[i] *= m;
      p.b[i] *= m;
    } else {
      p.r[i] = p.g[i] = p.b[i] = 255;
    }
  }
  return p;
}

/**
 * Darkness plane (1 − luma of the blurred straight color; transparent areas count as paper) from
 * just two blurred planes — premultiplied luma and alpha — instead of four (mono screens).
 */
function blurredDarkness(img: Img, sigma: number): Float32Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const L = new Float32Array(n);
  if (isOpaque(data)) {
    // alpha is 1 everywhere: its blur is a known constant (no second plane to blur)
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) * (255 / 255 / 255);
    blurPlane(L, w, h, sigma);
    const a = blurredOne(w, h, sigma);
    for (let i = 0; i < n; i++) L[i] = a > 1e-4 ? 1 - Math.min(1, L[i] / a) : 0;
    return L;
  }
  const A = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = data[j + 3] / 255;
    A[i] = a;
    L[i] = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) * (a / 255);
  }
  blurPlane(L, w, h, sigma);
  blurPlane(A, w, h, sigma);
  for (let i = 0; i < n; i++) {
    const a = A[i];
    L[i] = a > 1e-4 ? 1 - Math.min(1, L[i] / a) : 0;
  }
  return L;
}

function darknessFrom(p: { r: Float32Array; g: Float32Array; b: Float32Array }, n: number): Float32Array {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = 1 - (p.r[i] * 0.2126 + p.g[i] * 0.7152 + p.b[i] * 0.0722) / 255;
  return d;
}

const PROCESS = {
  c: [0, 158, 224],
  m: [228, 0, 124],
  y: [255, 237, 0],
};

/**
 * Subtractive ink separation: least-squares fit of optical densities
 * D(src) ≈ Σ c_k · D(ink_k) (all relative to the paper), clamped to 0..1.
 */
export function separateInks(
  r: Float32Array,
  g: Float32Array,
  b: Float32Array,
  n: number,
  paper: number[],
  inks: number[][],
  lambda = 0.02,
): Float32Array[] {
  const K = inks.length;
  const dens = (v: number, p: number) => -Math.log(Math.min(1, Math.max(1 / 255, v / Math.max(1, p))));
  const A = inks.map((ink) => [dens(ink[0], paper[0]), dens(ink[1], paper[1]), dens(ink[2], paper[2])]);
  // M = AᵀA + λI (K×K)
  const M: number[][] = [];
  for (let i = 0; i < K; i++) {
    M.push([]);
    for (let j = 0; j < K; j++) M[i].push(A[i][0] * A[j][0] + A[i][1] * A[j][1] + A[i][2] * A[j][2] + (i === j ? lambda : 0));
  }
  const inv = invert(M);
  // P = M⁻¹ Aᵀ (K×3)
  const P: number[][] = inv.map((row) => [0, 1, 2].map((ch) => row.reduce((s, v, k) => s + v * A[k][ch], 0)));
  const lut = [0, 1, 2].map((ch) => {
    const t = new Float32Array(256);
    for (let v = 0; v < 256; v++) t[v] = dens(v, paper[ch]);
    return t;
  });
  const out = inks.map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const dr = lut[0][r[i] < 0 ? 0 : r[i] > 255 ? 255 : r[i] | 0],
      dg = lut[1][g[i] < 0 ? 0 : g[i] > 255 ? 255 : g[i] | 0],
      db = lut[2][b[i] < 0 ? 0 : b[i] > 255 ? 255 : b[i] | 0];
    for (let k = 0; k < K; k++) {
      const c = P[k][0] * dr + P[k][1] * dg + P[k][2] * db;
      out[k][i] = c < 0 ? 0 : c > 1 ? 1 : c;
    }
  }
  return out;
}

function invert(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c] || 1e-9;
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/** Sample a plane shifted by (dx, dy) image px (bilinear, clamped). */
function shifted(plane: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return plane;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = samplePlane(plane, w, h, x - dx, y - dy);
  return out;
}

/* ------------------------------------------------------------------ */
/* Halftone                                                            */
/* ------------------------------------------------------------------ */

function applyHalftone<T extends Img>(img: T, p: ParamValues, ctx: FilterContext): T {
  if (isEmpty(img)) return img;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const { ax, ay, s } = anchor(ctx);
  const S = Math.max(1, num(p.size, 8) * s);
  const angle = num(p.angle, 45);
  const shape = str(p.shape, 'dot') as SpotShape;
  const k = contrastFactor(num(p.contrast, 0));
  const mode = str(p.mode, 'mono');
  const ink = rgb(p.ink, '#111111');
  const paper = rgb(p.paper, '#f5f1e8');
  const transparent = bool(p.transparentPaper, false);
  const mix = clamp(num(p.mix, 1), 0, 1);
  const orig = mix < 0.999 ? new Uint8ClampedArray(data) : null;
  const screen = { cell: S, angle, shape, ax, ay, contrast: k };
  // mono only needs the tone: blur luma + alpha (2 planes) instead of the 4 color planes
  const col = mode === 'mono' ? null : blurredColor(img, toneSigma(S));

  if (mode === 'cmyk' && col) {
    const C = new Float32Array(n),
      M = new Float32Array(n),
      Y = new Float32Array(n),
      K = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = col.r[i] / 255,
        g = col.g[i] / 255,
        b = col.b[i] / 255;
      const kk = 1 - Math.max(r, g, b);
      K[i] = kk;
      if (kk < 0.999) {
        const inv = 1 / (1 - kk);
        C[i] = (1 - r - kk) * inv;
        M[i] = (1 - g - kk) * inv;
        Y[i] = (1 - b - kk) * inv;
      }
    }
    const cc = new Float32Array(n),
      cm = new Float32Array(n),
      cy = new Float32Array(n),
      ck = new Float32Array(n);
    screenPlane(C, w, h, { ...screen, angle: angle - 30 }, cc);
    screenPlane(M, w, h, { ...screen, angle: angle + 30 }, cm);
    screenPlane(Y, w, h, { ...screen, angle: angle - 45 }, cy);
    screenPlane(K, w, h, screen, ck);
    const fC = PROCESS.c.map((v) => 1 - v / 255),
      fM = PROCESS.m.map((v) => 1 - v / 255),
      fY = PROCESS.y.map((v) => 1 - v / 255),
      fK = ink.map((v) => 1 - v / 255);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3];
      if (a === 0) continue;
      const vc = cc[i],
        vm = cm[i],
        vy = cy[i],
        vk = ck[i];
      if (transparent) {
        const A = 1 - (1 - vc) * (1 - vm) * (1 - vy) * (1 - vk);
        if (A < 0.002) {
          data[j + 3] = 0;
          continue;
        }
        for (let ch = 0; ch < 3; ch++) {
          const over = 255 * (1 - vc * fC[ch]) * (1 - vm * fM[ch]) * (1 - vy * fY[ch]) * (1 - vk * fK[ch]);
          data[j + ch] = 255 - (255 - over) / A;
        }
        data[j + 3] = a * A;
      } else {
        for (let ch = 0; ch < 3; ch++)
          data[j + ch] = paper[ch] * (1 - vc * fC[ch]) * (1 - vm * fM[ch]) * (1 - vy * fY[ch]) * (1 - vk * fK[ch]);
      }
    }
  } else if (mode === 'color' && col) {
    const P = paper.map((v) => Math.max(1, v));
    const cov = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = Math.max((P[0] - col.r[i]) / P[0], (P[1] - col.g[i]) / P[1], (P[2] - col.b[i]) / P[2]);
      cov[i] = c < 0 ? 0 : c > 1 ? 1 : c;
    }
    const out = new Float32Array(n);
    const cr = new Float32Array(n),
      cg = new Float32Array(n),
      cb = new Float32Array(n);
    screenPlane(cov, w, h, screen, out, [col.r, col.g, col.b], [cr, cg, cb]);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3];
      if (a === 0) continue;
      const v = out[i];
      // ink color = the cell color pushed to full strength (paper + ink·cov averages to the cell color)
      let c = Math.max((P[0] - cr[i]) / P[0], (P[1] - cg[i]) / P[1], (P[2] - cb[i]) / P[2]);
      c = c < 0.02 ? 0.02 : c > 1 ? 1 : c;
      const ir = P[0] - (P[0] - cr[i]) / c,
        ig = P[1] - (P[1] - cg[i]) / c,
        ib = P[2] - (P[2] - cb[i]) / c;
      if (transparent) {
        data[j] = ir;
        data[j + 1] = ig;
        data[j + 2] = ib;
        data[j + 3] = a * v;
      } else {
        data[j] = paper[0] + (ir - paper[0]) * v;
        data[j + 1] = paper[1] + (ig - paper[1]) * v;
        data[j + 2] = paper[2] + (ib - paper[2]) * v;
      }
    }
  } else {
    const dark = blurredDarkness(img, toneSigma(S));
    const out = new Float32Array(n);
    screenPlane(dark, w, h, screen, out);
    inkOnPaper(data, n, out, ink[0], ink[1], ink[2], paper[0], paper[1], paper[2], transparent);
  }
  if (orig) mixWith(orig, data, mix);
  return img;
}

/** Mono screen result → pixels: ink coverage v over the paper (or ink with alpha·v). */
function inkOnPaper(data: Uint8ClampedArray, n: number, out: Float32Array, i0: number, i1: number, i2: number, p0: number, p1: number, p2: number, transparent: boolean) {
  const u = transparent ? null : pixelWords({ data, width: n, height: 1 });
  if (u) {
    // Coverage is exactly 0 (paper) or 1 (ink) over most of a screen: p + (i − p)·0 = p and
    // p + (i − p)·1 = i, so those pixels take the paper / ink bytes as one word store.
    const q = new Uint8ClampedArray(6);
    q[0] = p0;
    q[1] = p1;
    q[2] = p2;
    q[3] = i0;
    q[4] = i1;
    q[5] = i2;
    const P = q[0] | (q[1] << 8) | (q[2] << 16),
      I = q[3] | (q[4] << 8) | (q[5] << 16);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const px = u[i];
      if (px >>> 24 === 0) continue;
      const v = out[i];
      if (v === 0) u[i] = (px & -16777216) | P;
      else if (v === 1) u[i] = (px & -16777216) | I;
      else {
        data[j] = p0 + (i0 - p0) * v;
        data[j + 1] = p1 + (i1 - p1) * v;
        data[j + 2] = p2 + (i2 - p2) * v;
      }
    }
    return;
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = data[j + 3];
    if (a === 0) continue;
    const v = out[i];
    if (transparent) {
      data[j] = i0;
      data[j + 1] = i1;
      data[j + 2] = i2;
      data[j + 3] = a * v;
    } else {
      data[j] = p0 + (i0 - p0) * v;
      data[j + 1] = p1 + (i1 - p1) * v;
      data[j + 2] = p2 + (i2 - p2) * v;
    }
  }
}

export const halftone: FilterDef = {
  id: 'halftone',
  name: 'Halftone',
  category: 'Comic & Print',
  icon: CircleDot,
  description: 'Rotated print screen: dot size follows the tone. Mono ink, spot color or CMYK separations.',
  keywords: ['dots', 'comic', 'screen', 'print', 'cmyk', 'pop art', 'manga'],
  params: [
    selectP('mode', 'Mode', [['mono', 'Mono (ink on paper)'], ['color', 'Color'], ['cmyk', 'CMYK']], 'mono'),
    selectP('shape', 'Shape', SPOT_SHAPES, 'dot'),
    pxP('size', 'Size', 2, 80, 8),
    angleP('angle', 'Angle', 45),
    numP('contrast', 'Contrast', -100, 100, 0),
    colorP('ink', 'Ink', '#111111', { showIf: (v) => v.mode !== 'color' }),
    colorP('paper', 'Paper', '#f5f1e8'),
    boolP('transparentPaper', 'Transparent paper', false),
    pctP('mix', 'Mix', 1),
  ],
  apply: applyHalftone,
};

/* ------------------------------------------------------------------ */
/* Comic dots (Ben-Day)                                                */
/* ------------------------------------------------------------------ */

export const comicDots: FilterDef = {
  id: 'comic-dots',
  name: 'Comic Dots',
  category: 'Comic & Print',
  icon: Grid3x3,
  description: 'Pop-art Ben-Day dots: colors become dots on paper, shadows get black dots, plus ink lines.',
  keywords: ['ben day', 'pop art', 'comic', 'lichtenstein', 'dots'],
  params: [
    pxP('size', 'Dot size', 2, 40, 7),
    angleP('angle', 'Angle', 45),
    colorP('paper', 'Paper', '#fff8e7'),
    pctP('shadow', 'Shadow start', 0.6),
    numP('saturation', 'Saturation', -100, 100, 25),
    boolP('outline', 'Ink outline', true),
    pxP('outlineThickness', 'Line width', 0, 8, 2, { showIf: (v) => v.outline !== false }),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const S = Math.max(1, num(p.size, 7) * s);
    const angle = num(p.angle, 45);
    const paper = rgb(p.paper, '#fff8e7');
    const P = paper.map((v) => Math.max(1, v));
    const shadow = clamp(num(p.shadow, 0.6), 0, 0.99);
    const line =
      bool(p.outline, true) && num(p.outlineThickness, 2) > 0
        ? outlineCoverage(img, { thickness: num(p.outlineThickness, 2) * s, threshold: 0.32, smooth: Math.max(0.7, s) })
        : null;
    const work = { data: new Uint8ClampedArray(data), width: w, height: h };
    saturateInPlace(work.data, 1 + num(p.saturation, 25) / 100);
    const col = blurredColor(work, toneSigma(S));
    const cov = new Float32Array(n);
    const sh = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = Math.max((P[0] - col.r[i]) / P[0], (P[1] - col.g[i]) / P[1], (P[2] - col.b[i]) / P[2]);
      // Ben-Day: light colors become dots, saturated/darker colors print solid sooner
      cov[i] = clamp(c * 1.35, 0, 1);
      const d = 1 - (col.r[i] * 0.2126 + col.g[i] * 0.7152 + col.b[i] * 0.0722) / 255;
      sh[i] = clamp((d - shadow) / (1 - shadow), 0, 1) * 0.85;
    }
    const dots = new Float32Array(n),
      kd = new Float32Array(n);
    const cr = new Float32Array(n),
      cg = new Float32Array(n),
      cb = new Float32Array(n);
    screenPlane(cov, w, h, { cell: S, angle, shape: 'dot', ax, ay }, dots, [col.r, col.g, col.b], [cr, cg, cb]);
    screenPlane(sh, w, h, { cell: S * 0.8, angle: angle + 45, shape: 'dot', ax, ay }, kd);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3];
      if (a === 0) continue;
      let c = Math.max((P[0] - cr[i]) / P[0], (P[1] - cg[i]) / P[1], (P[2] - cb[i]) / P[2]) * 1.35;
      c = c < 0.05 ? 0.05 : c > 1 ? 1 : c;
      const v = dots[i];
      const kv = kd[i];
      const l = line ? line[i] : 0;
      for (let ch = 0; ch < 3; ch++) {
        const Pc = P[ch];
        const cc = ch === 0 ? cr[i] : ch === 1 ? cg[i] : cb[i];
        const inkc = clamp(Pc - (Pc - cc) / c, 0, 255);
        let o = paper[ch] + (inkc - paper[ch]) * v;
        o = o + (18 - o) * kv;
        o = o + (12 - o) * l;
        data[j + ch] = o;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Newsprint                                                           */
/* ------------------------------------------------------------------ */

export const newsprint: FilterDef = {
  id: 'newsprint',
  name: 'Newsprint',
  category: 'Comic & Print',
  icon: Newspaper,
  description: 'Cheap newspaper print: fine halftone with ink spread, uneven inking and fibrous paper.',
  keywords: ['newspaper', 'noir', 'print', 'halftone', 'paper'],
  params: [
    pxP('size', 'Screen size', 2, 20, 4.5),
    angleP('angle', 'Angle', 45),
    numP('contrast', 'Contrast', -100, 100, 20),
    colorP('ink', 'Ink', '#1c1b1a'),
    colorP('paper', 'Paper', '#e9e3d6'),
    pctP('spread', 'Ink spread', 0.35),
    pctP('grain', 'Paper grain', 0.4),
    seedP(7),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const S = Math.max(1, num(p.size, 4.5) * s);
    const ink = rgb(p.ink, '#1c1b1a');
    const paper = rgb(p.paper, '#e9e3d6');
    const spread = clamp(num(p.spread, 0.35), 0, 1);
    const grain = clamp(num(p.grain, 0.4), 0, 1);
    const seed = num(p.seed, 7) | 0;
    const col = blurredColor(img, toneSigma(S));
    const dark = darknessFrom(col, n);
    const cov = new Float32Array(n);
    screenPlane(dark, w, h, { cell: S, angle: num(p.angle, 45), shape: 'dot', ax, ay, contrast: contrastFactor(num(p.contrast, 20)) }, cov);
    // ink spread: soften dots, then re-threshold with a noisy level → rough, bleeding dot edges
    if (spread > 0) {
      blurPlane(cov, w, h, Math.max(0.3, S * 0.12 * spread + 0.3 * s));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const nz = hash(Math.floor(x + ax), Math.floor(y + ay), seed) - 0.5;
          const t = 0.5 - spread * 0.18 + nz * spread * 0.25;
          cov[i] = clamp((cov[i] - t) * (3 + (1 - spread) * 6) + 0.5, 0, 1);
        }
      }
    }
    const fs = 1 / Math.max(1, 3 * s);
    // fibrous paper + uneven ink density: smooth noise, evaluated on coarse grids
    const fibF = grain > 0 ? coarseField(w, h, Math.max(1, Math.floor(2 * s)), (x, y) => fbmValue(((x + ax) / s) * 0.02, ((y + ay) / s) * 0.11, seed + 3, 3) - 0.5) : null;
    const densF = coarseField(w, h, Math.max(1, Math.floor(16 * s)), (x, y) => 0.82 + 0.18 * fbmValue(((x + ax) / s) * 0.004, ((y + ay) / s) * 0.004, seed + 5, 2));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        const a = data[j + 3];
        if (a === 0) continue;
        const fib = fibF ? fibF[i] : 0;
        const spec = hash(Math.floor(x + ax), Math.floor(y + ay), seed + 11) - 0.5;
        const pt = 1 + (fib * 0.16 + spec * 0.08 * fs * 3) * grain;
        const dens = densF[i];
        const v = cov[i] * dens;
        for (let ch = 0; ch < 3; ch++) data[j + ch] = paper[ch] * pt + (ink[ch] - paper[ch] * pt) * v;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Dither                                                              */
/* ------------------------------------------------------------------ */

function bayer(n: number): Float32Array {
  let m = [[0]];
  while (m.length < n) {
    const s = m.length;
    const next: number[][] = Array.from({ length: s * 2 }, () => new Array(s * 2).fill(0));
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + s] = v + 2;
        next[y + s][x] = v + 3;
        next[y + s][x + s] = v + 1;
      }
    m = next;
  }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = (m[y][x] + 0.5) / (n * n);
  return out;
}
const BAYER4 = bayer(4);
const BAYER8 = bayer(8);

export const dither: FilterDef = {
  id: 'dither',
  name: 'Dither',
  category: 'Comic & Print',
  icon: Grid2x2,
  description: 'Ordered (Bayer) or error-diffusion dithering to two colors or a posterized palette.',
  keywords: ['1-bit', 'retro', 'pixel', 'bayer', 'floyd', 'atkinson', 'gameboy'],
  params: [
    selectP('mode', 'Method', [['bayer4', 'Bayer 4×4'], ['bayer8', 'Bayer 8×8'], ['floyd', 'Floyd–Steinberg'], ['atkinson', 'Atkinson']], 'bayer8'),
    selectP('palette', 'Palette', [['duotone', 'Two colors'], ['color', 'Posterized color']], 'duotone'),
    numP('levels', 'Levels', 2, 16, 2, { step: 1 }),
    colorP('dark', 'Dark', '#111111', { showIf: (v) => v.palette !== 'color' }),
    colorP('light', 'Light', '#f2efe6', { showIf: (v) => v.palette !== 'color' }),
    pxP('pixel', 'Pixel size', 1, 16, 1, { step: 1 }),
    numP('contrast', 'Contrast', -100, 100, 0),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const { ax, ay, s } = anchor(ctx);
    const px = Math.max(1, Math.round(num(p.pixel, 1) * s));
    const L = clamp(Math.round(num(p.levels, 2)), 2, 16);
    const mode = str(p.mode, 'bayer8');
    const color = str(p.palette, 'duotone') === 'color';
    const dark = rgb(p.dark, '#111111'),
      light = rgb(p.light, '#f2efe6');
    const k = contrastFactor(num(p.contrast, 0));
    const shx = ((Math.round(ax) % px) + px) % px,
      shy = ((Math.round(ay) % px) + px) % px;
    const bw = Math.floor((w - 1 + shx) / px) + 1,
      bh = Math.floor((h - 1 + shy) / px) + 1;
    const nb = bw * bh;
    const ch = color ? 3 : 1;
    const val = new Float32Array(nb * ch);
    const wsum = new Float32Array(nb);
    // block averages (alpha weighted)
    for (let y = 0; y < h; y++) {
      const by = Math.floor((y + shy) / px);
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        const a = data[j + 3] / 255;
        if (a === 0) continue;
        const b = by * bw + Math.floor((x + shx) / px);
        wsum[b] += a;
        if (color) {
          val[b * 3] += data[j] * a;
          val[b * 3 + 1] += data[j + 1] * a;
          val[b * 3 + 2] += data[j + 2] * a;
        } else val[b] += (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) * a;
      }
    }
    for (let b = 0; b < nb; b++) {
      const ws = wsum[b];
      for (let c = 0; c < ch; c++) {
        const v = ws > 0 ? val[b * ch + c] / ws / 255 : 0;
        val[b * ch + c] = clamp((v - 0.5) * k + 0.5, 0, 1);
      }
    }
    const q = new Float32Array(nb * ch);
    const steps = L - 1;
    if (mode === 'floyd' || mode === 'atkinson') {
      const e = val; // diffuse in place
      for (let by = 0; by < bh; by++) {
        const ltr = mode === 'atkinson' || by % 2 === 0;
        for (let i = 0; i < bw; i++) {
          const bx = ltr ? i : bw - 1 - i;
          const b = by * bw + bx;
          if (wsum[b] <= 0) continue;
          for (let c = 0; c < ch; c++) {
            const old = e[b * ch + c];
            const nv = clamp(Math.round(old * steps), 0, steps) / steps;
            q[b * ch + c] = nv;
            const err = old - nv;
            const dir = ltr ? 1 : -1;
            const push = (dx: number, dy: number, f: number) => {
              const xx = bx + dx * dir,
                yy = by + dy;
              if (xx < 0 || xx >= bw || yy >= bh) return;
              const t = yy * bw + xx;
              if (wsum[t] <= 0) return;
              e[t * ch + c] += err * f;
            };
            if (mode === 'floyd') {
              push(1, 0, 7 / 16);
              push(-1, 1, 3 / 16);
              push(0, 1, 5 / 16);
              push(1, 1, 1 / 16);
            } else {
              push(1, 0, 1 / 8);
              push(2, 0, 1 / 8);
              push(-1, 1, 1 / 8);
              push(0, 1, 1 / 8);
              push(1, 1, 1 / 8);
              push(0, 2, 1 / 8);
            }
          }
        }
      }
    } else {
      const M = mode === 'bayer4' ? BAYER4 : BAYER8;
      const msz = mode === 'bayer4' ? 4 : 8;
      const ox = Math.floor((Math.round(ax) + shx) / px),
        oy = Math.floor((Math.round(ay) + shy) / px);
      for (let by = 0; by < bh; by++) {
        const my = (((by + oy) % msz) + msz) % msz;
        for (let bx = 0; bx < bw; bx++) {
          const b = by * bw + bx;
          const t = M[my * msz + ((((bx + ox) % msz) + msz) % msz)];
          for (let c = 0; c < ch; c++) q[b * ch + c] = Math.min(steps, Math.floor(val[b * ch + c] * steps + t)) / steps;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      const by = Math.floor((y + shy) / px);
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const b = by * bw + Math.floor((x + shx) / px);
        if (color) {
          data[j] = q[b * 3] * 255;
          data[j + 1] = q[b * 3 + 1] * 255;
          data[j + 2] = q[b * 3 + 2] * 255;
        } else {
          const t = q[b];
          data[j] = dark[0] + (light[0] - dark[0]) * t;
          data[j + 1] = dark[1] + (light[1] - dark[1]) * t;
          data[j + 2] = dark[2] + (light[2] - dark[2]) * t;
        }
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Risograph & screen print                                            */
/* ------------------------------------------------------------------ */

interface PrintOpts {
  inks: number[][];
  paper: number[];
  offset: number;
  /** stochastic grain amount (riso) */
  grain: number;
  grainSize: number;
  /** halftone screen cell size (0 = none) */
  cell: number;
  /** hard posterized edges (screen print without halftone) */
  hard: boolean;
  texture: number;
  contrast: number;
  seed: number;
}

function printProcess<T extends Img>(img: T, o: PrintOpts, ctx: FilterContext): T {
  if (isEmpty(img)) return img;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const { ax, ay, s } = anchor(ctx);
  const col = blurredColor(img, o.cell > 0 ? toneSigma(o.cell) : 0.6 * s);
  if (o.contrast !== 1) {
    for (let i = 0; i < n; i++) {
      col.r[i] = clamp((col.r[i] - 128) * o.contrast + 128, 0, 255);
      col.g[i] = clamp((col.g[i] - 128) * o.contrast + 128, 0, 255);
      col.b[i] = clamp((col.b[i] - 128) * o.contrast + 128, 0, 255);
    }
  }
  const covs = separateInks(col.r, col.g, col.b, n, o.paper, o.inks);
  const rnd = (k: number) => hash(k, 17, o.seed);
  const angles = [15, 75, 45, 0];
  const out = covs.map((cov, k) => {
    // misregistration: every ink but the first is shifted a little in a seeded direction
    const ang = rnd(k) * Math.PI * 2;
    const dist = k === 0 ? 0 : o.offset * s * (0.6 + 0.4 * rnd(k + 9));
    let c = shifted(cov, w, h, Math.cos(ang) * dist, Math.sin(ang) * dist);
    if (o.cell > 0) {
      const sc = new Float32Array(n);
      screenPlane(c, w, h, { cell: o.cell, angle: angles[k % 4], shape: 'dot', ax, ay }, sc);
      c = sc;
    } else if (o.hard) {
      const sc = new Float32Array(n);
      for (let i = 0; i < n; i++) sc[i] = clamp((c[i] - 0.5) * 6 + 0.5, 0, 1);
      c = sc;
    } else if (c === cov) c = Float32Array.from(cov);
    if (o.grain > 0) {
      const gs = Math.max(0.5, o.grainSize * s);
      const soft = coarseField(w, h, Math.max(1, Math.floor(gs)), (x, y) => valueNoise01(((x + ax) / gs) * 0.5, ((y + ay) / gs) * 0.5, o.seed + k));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const gx = (x + ax) / gs,
            gy = (y + ay) / gs;
          const t = hash(Math.floor(gx), Math.floor(gy), o.seed + 31 * k) * 0.7 + soft[i] * 0.3;
          const v = c[i];
          const d = clamp((v - t) * 6 + 0.5, 0, 1);
          c[i] = v + (d - v) * o.grain;
        }
    }
    if (o.texture > 0) {
      const tex = coarseField(w, h, Math.max(1, Math.floor(2 * s)), (x, y) => fbmValue(((x + ax) / s) * 0.08, ((y + ay) / s) * 0.08, o.seed + 101 * k, 3));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const gx = (x + ax) / s,
            gy = (y + ay) / s;
          const t = tex[i];
          const voids = clamp((t - (1 - o.texture * 0.35)) * 8, 0, 1);
          c[i] *= 1 - voids * 0.9 - (hash(Math.floor(gx), Math.floor(gy), o.seed + k) - 0.5) * 0.12 * o.texture;
        }
    }
    return c;
  });
  const f = o.inks.map((ink) => ink.map((v, ch) => 1 - v / Math.max(1, o.paper[ch])));
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (data[j + 3] === 0) continue;
    for (let ch = 0; ch < 3; ch++) {
      let v = o.paper[ch];
      for (let k = 0; k < out.length; k++) v *= 1 - clamp(out[k][i], 0, 1) * f[k][ch];
      data[j + ch] = v;
    }
  }
  return img;
}

function valueNoise01(x: number, y: number, seed: number) {
  return fbmValue(x, y, seed, 1);
}

export const risograph: FilterDef = {
  id: 'risograph',
  name: 'Risograph',
  category: 'Comic & Print',
  icon: Printer,
  description: 'Two-ink offset print with grainy coverage and misregistration (fluoro pink + blue by default).',
  keywords: ['riso', 'zine', 'print', 'duotone', 'grain', 'offset'],
  params: [
    colorP('ink1', 'Ink 1', '#ff48b0'),
    colorP('ink2', 'Ink 2', '#0078bf'),
    colorP('paper', 'Paper', '#f2ede4'),
    pxP('offset', 'Misregistration', 0, 20, 3),
    pctP('grain', 'Grain', 0.65),
    pxP('grainSize', 'Grain size', 0.5, 8, 1.2),
    numP('contrast', 'Contrast', -100, 100, 10),
    seedP(3),
  ],
  apply(img, p, ctx) {
    return printProcess(
      img,
      {
        inks: [rgb(p.ink1, '#ff48b0'), rgb(p.ink2, '#0078bf')],
        paper: rgb(p.paper, '#f2ede4'),
        offset: num(p.offset, 3),
        grain: clamp(num(p.grain, 0.65), 0, 1),
        grainSize: num(p.grainSize, 1.2),
        cell: 0,
        hard: false,
        texture: 0.25,
        contrast: contrastFactor(num(p.contrast, 10)),
        seed: num(p.seed, 3) | 0,
      },
      ctx,
    );
  },
};

export const screenPrint: FilterDef = {
  id: 'screen-print',
  name: 'Screen Print',
  category: 'Comic & Print',
  icon: Shirt,
  description: 'Flat 2–3 ink poster print with halftone midtones, misregistration and gritty ink texture.',
  keywords: ['silkscreen', 'poster', 'warhol', 'print', 'separation'],
  params: [
    selectP('inks', 'Inks', [['2', '2 inks'], ['3', '3 inks']], '3'),
    colorP('ink1', 'Ink 1', '#d62828'),
    colorP('ink2', 'Ink 2', '#16324f'),
    colorP('ink3', 'Ink 3', '#f6bd3b', { showIf: (v) => v.inks !== '2' }),
    colorP('paper', 'Paper', '#f4efe6'),
    boolP('halftone', 'Halftone midtones', true),
    pxP('size', 'Dot size', 2, 30, 6, { showIf: (v) => v.halftone !== false }),
    pxP('offset', 'Misregistration', 0, 30, 4),
    pctP('texture', 'Ink texture', 0.45),
    numP('contrast', 'Contrast', -100, 100, 15),
    seedP(5),
  ],
  apply(img, p, ctx) {
    const inks = [rgb(p.ink1, '#d62828'), rgb(p.ink2, '#16324f')];
    if (str(p.inks, '3') !== '2') inks.push(rgb(p.ink3, '#f6bd3b'));
    const ht = bool(p.halftone, true);
    return printProcess(
      img,
      {
        inks,
        paper: rgb(p.paper, '#f4efe6'),
        offset: num(p.offset, 4),
        grain: 0,
        grainSize: 1,
        cell: ht ? Math.max(1, num(p.size, 6) * (ctx.scale > 0 ? ctx.scale : 1)) : 0,
        hard: !ht,
        texture: clamp(num(p.texture, 0.45), 0, 1),
        contrast: contrastFactor(num(p.contrast, 15)),
        seed: num(p.seed, 5) | 0,
      },
      ctx,
    );
  },
};

/* ------------------------------------------------------------------ */
/* Ink outline                                                         */
/* ------------------------------------------------------------------ */

export const inkOutline: FilterDef = {
  id: 'ink-outline',
  name: 'Ink Outline',
  category: 'Comic & Print',
  icon: PenTool,
  description: 'Clean comic ink lines along edges and the silhouette, over the colors or on paper.',
  keywords: ['outline', 'lineart', 'comic', 'edges', 'inking', 'stroke'],
  params: [
    pxP('thickness', 'Thickness', 0, 10, 2),
    pctP('threshold', 'Threshold', 0.3),
    colorP('color', 'Ink', '#000000'),
    boolP('keepColors', 'Keep colors', true),
    colorP('paper', 'Paper', '#ffffff', { showIf: (v) => v.keepColors === false }),
    boolP('silhouette', 'Outline silhouette', true),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const s = ctx.scale > 0 ? ctx.scale : 1;
    const cov = outlineCoverage(img, {
      thickness: num(p.thickness, 2) * s,
      threshold: clamp(num(p.threshold, 0.3), 0, 1),
      silhouette: bool(p.silhouette, true),
      smooth: Math.max(0.6, s),
      minLength: Math.max(2, Math.round(4 * s)),
    });
    const ink = rgb(p.color, '#000000');
    const keep = bool(p.keepColors, true);
    const paper = rgb(p.paper, '#ffffff');
    const d = img.data;
    for (let i = 0, j = 0; i < cov.length; i++, j += 4) {
      if (d[j + 3] === 0) continue;
      const v = cov[i];
      for (let ch = 0; ch < 3; ch++) {
        const base = keep ? d[j + ch] : paper[ch];
        d[j + ch] = base + (ink[ch] - base) * v;
      }
    }
    return img;
  },
};

export const comicFilters: FilterDef[] = [halftone, comicDots, newsprint, dither, risograph, screenPrint, inkOutline];
