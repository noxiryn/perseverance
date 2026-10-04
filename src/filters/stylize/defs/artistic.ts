/** Artistic filters: cutout, watercolor, charcoal, pencil sketch, ink wash, poster edges, stamp. */
import { Droplet, Feather, Highlighter, Palette, Pencil, Scissors, Stamp } from 'lucide-react';
import type { FilterDef } from '../../../registry';
import type { Img } from '../util';
import {
  anchor,
  blurImage,
  blurPlane,
  bool,
  clamp,
  fbmValue,
  hash,
  isEmpty,
  lumaPlane,
  num,
  prng,
  rgb,
  sampleBilinear,
  saturateInPlace,
  smoothstep,
  sobel,
} from '../util';
import { lineBoxBlur } from '../ops';
import { kuwahara } from '../kuwahara';
import { medianImage } from '../median';
import { outlineCoverage } from '../edges';
import { quantizeSmooth } from './stylize';
import { angleP, boolP, colorP, numP, pctP, pxP, seedP } from '../params';

/* ------------------------------------------------------------------ */
/* Color quantization (k-means in OKLab)                               */
/* ------------------------------------------------------------------ */

const SRGB_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linToSrgb(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255;
}

/** sRGB bytes → OKLab (L 0..1, a/b ≈ ±0.4). */
export function toOklab(r: number, g: number, b: number, out: Float32Array, o: number) {
  const lr = SRGB_LIN[r],
    lg = SRGB_LIN[g],
    lb = SRGB_LIN[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

export function fromOklab(L: number, A: number, B: number): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * k-means palette of K colors over opaque pixels of `lab` (3 floats per pixel). Lightness is
 * weighted more than chroma so shading bands separate (cel-like flat tones). Deterministic.
 */
export function kmeansPalette(lab: Float32Array, alpha: Uint8ClampedArray | null, n: number, K: number, seed = 1, iters = 10): Float32Array {
  const LW = 1.6;
  const idx: number[] = [];
  const step = Math.max(1, Math.floor(n / 24000));
  for (let i = 0; i < n; i += step) if (!alpha || alpha[i * 4 + 3] > 24) idx.push(i);
  const m = idx.length;
  const cent = new Float32Array(K * 3);
  if (!m) return cent;
  const rnd = prng(seed);
  const dist2 = (i: number, c: number) => {
    const dl = (lab[i * 3] - cent[c * 3]) * LW,
      da = lab[i * 3 + 1] - cent[c * 3 + 1],
      db = lab[i * 3 + 2] - cent[c * 3 + 2];
    return dl * dl + da * da + db * db;
  };
  // k-means++ initialization
  const first = idx[Math.floor(rnd() * m)];
  cent.set(lab.subarray(first * 3, first * 3 + 3), 0);
  const best = new Float32Array(m).fill(Infinity);
  for (let c = 1; c < K; c++) {
    let sum = 0;
    for (let t = 0; t < m; t++) {
      const d = dist2(idx[t], c - 1);
      if (d < best[t]) best[t] = d;
      sum += best[t];
    }
    let r = rnd() * sum;
    let pick = idx[m - 1];
    for (let t = 0; t < m; t++) {
      r -= best[t];
      if (r <= 0) {
        pick = idx[t];
        break;
      }
    }
    cent.set(lab.subarray(pick * 3, pick * 3 + 3), c * 3);
  }
  const acc = new Float64Array(K * 4);
  for (let it = 0; it < iters; it++) {
    acc.fill(0);
    for (let t = 0; t < m; t++) {
      const i = idx[t];
      let bc = 0,
        bd = Infinity;
      for (let c = 0; c < K; c++) {
        const d = dist2(i, c);
        if (d < bd) {
          bd = d;
          bc = c;
        }
      }
      acc[bc * 4] += lab[i * 3];
      acc[bc * 4 + 1] += lab[i * 3 + 1];
      acc[bc * 4 + 2] += lab[i * 3 + 2];
      acc[bc * 4 + 3]++;
    }
    for (let c = 0; c < K; c++) {
      const cnt = acc[c * 4 + 3];
      if (!cnt) continue;
      cent[c * 3] = acc[c * 4] / cnt;
      cent[c * 3 + 1] = acc[c * 4 + 1] / cnt;
      cent[c * 3 + 2] = acc[c * 4 + 2] / cnt;
    }
  }
  return cent;
}

/** 3×3 majority (mode) filter on a label map, ignoring pixels marked 255 (transparent). */
function modeFilter(lbl: Uint8Array, w: number, h: number, K: number): Uint8Array {
  const out = new Uint8Array(lbl);
  const cnt = new Uint8Array(K);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const c0 = lbl[i];
      if (c0 === 255) continue;
      cnt.fill(0);
      let bestC = c0,
        bestN = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const c = lbl[i + dy * w + dx];
          if (c === 255) continue;
          const v = ++cnt[c] + (c === c0 ? 0.5 : 0);
          if (v > bestN) {
            bestN = v;
            bestC = c;
          }
        }
      out[i] = bestC;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Cutout                                                              */
/* ------------------------------------------------------------------ */

export const cutout: FilterDef = {
  id: 'cutout',
  name: 'Cutout',
  category: 'Artistic',
  icon: Scissors,
  description: 'Flat cut-paper color regions: simplified shapes with a few flat tones (great on Roblox renders).',
  keywords: ['posterize', 'flat', 'vector', 'paper cut', 'cel', 'simplify', 'poster'],
  params: [
    numP('colors', 'Colors', 2, 16, 6, { step: 1 }),
    pxP('simplicity', 'Simplicity', 0, 12, 3, { step: 1 }),
    pctP('fidelity', 'Edge fidelity', 0.6),
    numP('saturation', 'Saturation', -100, 100, 0, { step: 1 }),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const s = ctx.scale > 0 ? ctx.scale : 1;
    const K = clamp(Math.round(num(p.colors, 6)), 2, 16);
    const simp = Math.max(0, num(p.simplicity, 3)) * s;
    const fid = clamp(num(p.fidelity, 0.6), 0, 1);
    const work = { data: new Uint8ClampedArray(data), width: w, height: h };
    if (simp >= 0.75) medianImage(work, simp);
    const wd = work.data;
    const lab = new Float32Array(n * 3);
    for (let i = 0, j = 0; i < n; i++, j += 4) toOklab(wd[j], wd[j + 1], wd[j + 2], lab, i * 3);
    const cent = kmeansPalette(lab, data, n, K, 1);
    // assign
    let lbl: Uint8Array = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] === 0) {
        lbl[i] = 255;
        continue;
      }
      let bc = 0,
        bd = Infinity;
      const L = lab[i * 3],
        A = lab[i * 3 + 1],
        B = lab[i * 3 + 2];
      for (let c = 0; c < K; c++) {
        const dl = (L - cent[c * 3]) * 1.6,
          da = A - cent[c * 3 + 1],
          db = B - cent[c * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) {
          bd = d;
          bc = c;
        }
      }
      lbl[i] = bc;
    }
    // smooth region outlines (fewer jaggies/specks at lower fidelity)
    const passes = Math.round((1 - fid) * 4 * Math.max(0.5, s)) + (simp > 0 ? 1 : 0);
    for (let k = 0; k < passes; k++) lbl = modeFilter(lbl, w, h, K);
    const pal = new Float32Array(K * 3);
    for (let c = 0; c < K; c++) {
      const [r, g, b] = fromOklab(cent[c * 3], cent[c * 3 + 1], cent[c * 3 + 2]);
      pal[c * 3] = r;
      pal[c * 3 + 1] = g;
      pal[c * 3 + 2] = b;
    }
    const satK = 1 + num(p.saturation, 0) / 100;
    if (Math.abs(satK - 1) > 1e-3) {
      for (let c = 0; c < K; c++) {
        const l = pal[c * 3] * 0.2126 + pal[c * 3 + 1] * 0.7152 + pal[c * 3 + 2] * 0.0722;
        for (let ch = 0; ch < 3; ch++) pal[c * 3 + ch] = clamp(l + (pal[c * 3 + ch] - l) * satK, 0, 255);
      }
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const c = lbl[i];
      if (c === 255) continue;
      data[j] = pal[c * 3];
      data[j + 1] = pal[c * 3 + 1];
      data[j + 2] = pal[c * 3 + 2];
    }
    // anti-alias region boundaries: average with neighbours only where labels change
    const src = new Uint8ClampedArray(data);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = lbl[i];
        if (c === 255) continue;
        const l = x > 0 ? lbl[i - 1] : c,
          r = x < w - 1 ? lbl[i + 1] : c,
          u = y > 0 ? lbl[i - w] : c,
          d = y < h - 1 ? lbl[i + w] : c;
        if ((l === c || l === 255) && (r === c || r === 255) && (u === c || u === 255) && (d === c || d === 255)) continue;
        const j = i * 4;
        let sr = src[j] * 2,
          sg = src[j + 1] * 2,
          sb = src[j + 2] * 2,
          cnt = 2;
        const add = (k: number, lab2: number) => {
          if (lab2 === 255) return;
          sr += src[k];
          sg += src[k + 1];
          sb += src[k + 2];
          cnt++;
        };
        if (x > 0) add(j - 4, l);
        if (x < w - 1) add(j + 4, r);
        if (y > 0) add(j - w * 4, u);
        if (y < h - 1) add(j + w * 4, d);
        data[j] = sr / cnt;
        data[j + 1] = sg / cnt;
        data[j + 2] = sb / cnt;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Watercolor                                                          */
/* ------------------------------------------------------------------ */

export const watercolor: FilterDef = {
  id: 'watercolor',
  name: 'Watercolor',
  category: 'Artistic',
  icon: Droplet,
  description: 'Transparent washes with pigment pooling at the edges, wobbly bleeds and paper granulation.',
  keywords: ['paint', 'aquarelle', 'wash', 'artistic', 'soft'],
  params: [
    pxP('brush', 'Brush size', 1, 20, 5, { step: 1 }),
    pctP('bleed', 'Bleed', 0.5),
    pctP('edges', 'Edge darkening', 0.55),
    pctP('texture', 'Paper texture', 0.5),
    numP('saturation', 'Saturation', -100, 100, 10, { step: 1 }),
    colorP('paper', 'Paper', '#f8f4ea'),
    seedP(2),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const r = Math.max(1, num(p.brush, 5) * s);
    const bleed = clamp(num(p.bleed, 0.5), 0, 1);
    const edgeK = clamp(num(p.edges, 0.55), 0, 1);
    const tex = clamp(num(p.texture, 0.5), 0, 1);
    const paper = rgb(p.paper, '#f8f4ea');
    const seed = num(p.seed, 2) | 0;
    const orig = new Uint8ClampedArray(data);
    const wash = { data: new Uint8ClampedArray(data), width: w, height: h };
    kuwahara(wash, r);
    blurImage(wash, Math.max(0.5, r * 0.35));
    saturateInPlace(wash.data, 1 + num(p.saturation, 10) / 100);
    // pigment pooling: difference of gaussians on luminance
    const L1 = lumaPlane(wash);
    const L2 = Float32Array.from(L1);
    blurPlane(L1, w, h, Math.max(0.6, r * 0.3));
    blurPlane(L2, w, h, Math.max(1.5, r * 1.3));
    // wobbly bleed: displace the wash with low-frequency noise
    const amp = bleed * r * 0.9 + bleed * 1.5 * s;
    const wd = wash.data;
    const tmp = new Uint8ClampedArray(4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        if (orig[j + 3] === 0) continue;
        const X = (x + ax) / s,
          Y = (y + ay) / s;
        let R: number, G: number, B: number;
        if (amp > 0.2) {
          const nx = fbmValue(X * 0.03, Y * 0.03, seed, 3) - 0.5,
            ny = fbmValue(X * 0.03 + 9.1, Y * 0.03 - 4.7, seed + 1, 3) - 0.5;
          sampleBilinear(wd, w, h, x + nx * amp * 2, y + ny * amp * 2, tmp, 0, 'clamp');
          R = tmp[0];
          G = tmp[1];
          B = tmp[2];
        } else {
          R = wd[j];
          G = wd[j + 1];
          B = wd[j + 2];
        }
        // pigment density (absorbance relative to the paper)
        const gran = (fbmValue(X * 0.12, Y * 0.12, seed + 5, 3) - 0.5) * 2;
        const fibers = fbmValue(X * 0.02, Y * 0.35, seed + 7, 2) - 0.5;
        const dog = Math.max(0, L2[i] - L1[i]) * 6 + Math.abs(L2[i] - L1[i]) * 2;
        const pool = 1 + dog * edgeK * 1.6;
        const g = 1 + gran * tex * 0.45 + fibers * tex * 0.2;
        const out = [R, G, B];
        for (let c = 0; c < 3; c++) {
          const P = Math.max(1, paper[c]);
          let dens = clamp(1 - out[c] / P, 0, 1);
          dens = clamp(dens * pool * g * 0.92, 0, 1);
          out[c] = P * (1 - dens);
        }
        // paper tooth shows through lightly everywhere
        const tooth = 1 - (hash(Math.floor(X), Math.floor(Y), seed + 9) - 0.5) * 0.05 * tex;
        data[j] = out[0] * tooth;
        data[j + 1] = out[1] * tooth;
        data[j + 2] = out[2] * tooth;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Charcoal                                                            */
/* ------------------------------------------------------------------ */

/** Directional streak texture (0..1, ~0.5 mean): white noise smeared along `angle`. */
function streaks(w: number, h: number, ax: number, ay: number, s: number, angle: number, len: number, seed: number): Float32Array {
  const n = w * h;
  const nz = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) nz[y * w + x] = hash(Math.floor((x + ax) / Math.max(0.5, s)), Math.floor((y + ay) / Math.max(0.5, s)), seed);
  const sm = lineBoxBlur(nz, w, h, angle, Math.max(1, len), true);
  // re-normalize contrast (averaging shrinks variance)
  const k = Math.sqrt(Math.max(1, len * 2 + 1)) * 0.9;
  for (let i = 0; i < n; i++) sm[i] = clamp((sm[i] - 0.5) * k + 0.5, 0, 1);
  return sm;
}

export const charcoal: FilterDef = {
  id: 'charcoal',
  name: 'Charcoal',
  category: 'Artistic',
  icon: Highlighter,
  description: 'Smudgy charcoal drawing: grainy diagonal strokes, bold dark edges on toothy paper.',
  keywords: ['drawing', 'sketch', 'smudge', 'graphite', 'art'],
  params: [
    pxP('thickness', 'Stroke length', 1, 12, 4),
    pctP('detail', 'Detail', 0.5),
    pctP('contrast', 'Contrast', 0.5),
    angleP('angle', 'Stroke angle', 45),
    colorP('ink', 'Charcoal', '#171717'),
    colorP('paper', 'Paper', '#ece8de'),
    seedP(5),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const th = Math.max(1, num(p.thickness, 4)) * s;
    const detail = clamp(num(p.detail, 0.5), 0, 1);
    const contrast = clamp(num(p.contrast, 0.5), 0, 1);
    const ink = rgb(p.ink, '#171717'),
      paper = rgb(p.paper, '#ece8de');
    const seed = num(p.seed, 5) | 0;
    const L = lumaPlane(img);
    blurPlane(L, w, h, Math.max(0.6, (1.5 - detail) * s));
    const st = streaks(w, h, ax, ay, s, num(p.angle, 45), th * 2.5, seed);
    const Le = Float32Array.from(L);
    blurPlane(Le, w, h, Math.max(0.8, (1.6 - detail) * 1.2 * s));
    const { mag } = sobel(Le, w, h);
    const lo = 0.1 + contrast * 0.15,
      hi = 0.9 - contrast * 0.2;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] === 0) continue;
      const x = i % w,
        y = (i - x) / w;
      const tone = 1 - smoothstep(lo, hi, L[i]); // darkness 0..1
      // stroke deposits: darker tones deposit through more of the streak texture
      let cov = clamp((tone - st[i] * 0.85 + 0.2) * 2.4, 0, 1) * (0.55 + tone * 0.45);
      // bold edges
      cov = Math.max(cov, clamp(mag[i] * (6 + detail * 10) - 0.15, 0, 1) * 0.95);
      // paper tooth: charcoal skips the valleys
      const tooth = fbmValue((x + ax) / s * 0.45, (y + ay) / s * 0.45, seed + 3, 2);
      cov *= 0.7 + 0.3 * smoothstep(0.25, 0.6, tooth);
      for (let c = 0; c < 3; c++) data[j + c] = paper[c] + (ink[c] - paper[c]) * cov;
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Pencil sketch                                                       */
/* ------------------------------------------------------------------ */

export const pencilSketch: FilterDef = {
  id: 'pencil-sketch',
  name: 'Pencil Sketch',
  category: 'Artistic',
  icon: Pencil,
  description: 'Graphite pencil drawing: clean contour lines from a color-dodge sketch plus hatched shading.',
  keywords: ['drawing', 'graphite', 'lineart', 'sketch', 'colored pencil'],
  params: [
    pxP('size', 'Line width', 0.5, 12, 2, { step: 0.1 }),
    numP('strength', 'Darkness', 0, 2, 1, { step: 0.01 }),
    pctP('shading', 'Shading', 0.5),
    boolP('colored', 'Colored pencil', false),
    colorP('paper', 'Paper', '#f7f5ef'),
    seedP(9),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const size = Math.max(0.3, num(p.size, 2)) * s;
    const strength = clamp(num(p.strength, 1), 0, 2);
    const shading = clamp(num(p.shading, 0.5), 0, 1);
    const colored = bool(p.colored, false);
    const paper = rgb(p.paper, '#f7f5ef');
    const seed = num(p.seed, 9) | 0;
    const L = lumaPlane(img);
    // transparent areas read as white paper
    for (let i = 0; i < n; i++) {
      const a = data[i * 4 + 3] / 255;
      L[i] = L[i] * a + (1 - a);
    }
    const inv = new Float32Array(n);
    for (let i = 0; i < n; i++) inv[i] = 1 - L[i];
    blurPlane(inv, w, h, size * 1.6);
    const hatch = shading > 0 ? streaks(w, h, ax, ay, s, 30, Math.max(2, 6 * s), seed) : null;
    const Ls = Float32Array.from(L);
    blurPlane(Ls, w, h, Math.max(1, 3 * s));
    const gamma = 1 + strength * 2.5;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] === 0) continue;
      // color dodge of the image with its blurred negative → lines where detail changes
      let v = L[i] / Math.max(1e-3, 1 - inv[i]);
      v = Math.pow(clamp(v, 0, 1), gamma);
      if (hatch) {
        const dark = 1 - smoothstep(0.15, 0.75, Ls[i]);
        const ht = clamp((dark - hatch[i] * 0.9 + 0.1) * 3, 0, 1) * dark * shading;
        v *= 1 - ht * 0.55;
      }
      if (colored) {
        const l = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255;
        for (let c = 0; c < 3; c++) {
          // pastel pencil tint: original hue lightened, multiplied by the graphite value
          const tint = 1 - (1 - (data[j + c] / 255) / Math.max(0.15, l + 0.15)) * 0.45;
          data[j + c] = paper[c] * clamp(tint, 0.3, 1.1) * v;
        }
      } else {
        data[j] = paper[0] * v;
        data[j + 1] = paper[1] * v;
        data[j + 2] = paper[2] * v;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Ink wash (sumi-e)                                                   */
/* ------------------------------------------------------------------ */

export const inkWash: FilterDef = {
  id: 'ink-wash',
  name: 'Ink Wash',
  category: 'Artistic',
  icon: Feather,
  description: 'Sumi-e style: graded ink washes that bleed into the paper, with dry-brush outlines.',
  keywords: ['sumi-e', 'japanese', 'brush', 'ink', 'manga', 'monochrome'],
  params: [
    numP('levels', 'Wash tones', 2, 6, 4, { step: 1 }),
    pxP('bleed', 'Bleed', 0, 20, 4),
    pctP('edges', 'Brush outlines', 0.6),
    pctP('texture', 'Paper texture', 0.5),
    colorP('ink', 'Ink', '#141414'),
    colorP('paper', 'Paper', '#f1ece0'),
    seedP(6),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const levels = clamp(Math.round(num(p.levels, 4)), 2, 6);
    const bleed = Math.max(0, num(p.bleed, 4)) * s;
    const edges = clamp(num(p.edges, 0.6), 0, 1);
    const tex = clamp(num(p.texture, 0.5), 0, 1);
    const ink = rgb(p.ink, '#141414'),
      paper = rgb(p.paper, '#f1ece0');
    const seed = num(p.seed, 6) | 0;
    const work = { data: new Uint8ClampedArray(data), width: w, height: h };
    kuwahara(work, Math.max(1, 3 * s));
    const L = lumaPlane(work);
    const D = new Float32Array(n);
    for (let i = 0; i < n; i++) D[i] = 1 - quantizeSmooth(L[i], levels, 0.45);
    if (bleed > 0.3) blurPlane(D, w, h, bleed * 0.6);
    const line = edges > 0 ? outlineCoverage(img, { thickness: Math.max(0.8, 2.2 * s), threshold: 0.3, smooth: Math.max(0.8, s), minLength: Math.max(3, Math.round(5 * s)) }) : null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        if (data[j + 3] === 0) continue;
        const X = (x + ax) / s,
          Y = (y + ay) / s;
        // wet bleed: sample the wash with a noisy offset, uneven ink load
        let d = D[i];
        if (bleed > 0.3) {
          const nx = (fbmValue(X * 0.05, Y * 0.05, seed, 2) - 0.5) * bleed * 1.5;
          const ny = (fbmValue(X * 0.05 + 5.3, Y * 0.05 + 1.7, seed + 1, 2) - 0.5) * bleed * 1.5;
          const xx = clamp(Math.round(x + nx), 0, w - 1),
            yy = clamp(Math.round(y + ny), 0, h - 1);
          d = D[yy * w + xx];
        }
        const load = 0.82 + 0.3 * (fbmValue(X * 0.008, Y * 0.008, seed + 2, 2) - 0.5);
        d = clamp(d * load, 0, 1);
        if (line) {
          // dry brush: the outline breaks up where the brush runs out of ink
          const dry = smoothstep(0.25, 0.55, fbmValue(X * 0.06, Y * 0.02, seed + 3, 3));
          d = Math.max(d, line[i] * edges * (0.45 + 0.55 * dry));
        }
        const paperTex = 1 - (fbmValue(X * 0.25, Y * 0.25, seed + 4, 2) - 0.5) * 0.12 * tex;
        for (let c = 0; c < 3; c++) data[j + c] = (paper[c] + (ink[c] - paper[c]) * d) * paperTex;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Poster edges                                                        */
/* ------------------------------------------------------------------ */

export const posterEdges: FilterDef = {
  id: 'poster-edges',
  name: 'Poster Edges',
  category: 'Artistic',
  icon: Palette,
  description: 'Posterized colors with dark ink along the edges (Photoshop’s Poster Edges).',
  keywords: ['posterize', 'comic', 'edges', 'print', 'cartoon'],
  params: [
    pxP('edgeThickness', 'Edge thickness', 0, 10, 2),
    numP('edgeIntensity', 'Edge intensity', 0, 10, 1, { step: 0.1 }),
    numP('posterization', 'Posterization', 0, 6, 2, { step: 1 }),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const s = ctx.scale > 0 ? ctx.scale : 1;
    const th = Math.max(0, num(p.edgeThickness, 2)) * s;
    const ei = clamp(num(p.edgeIntensity, 1), 0, 10);
    const levels = 2 + clamp(Math.round(num(p.posterization, 2)), 0, 6);
    const L = lumaPlane(img);
    blurPlane(L, w, h, Math.max(0.5, 0.5 + th * 0.45));
    const { mag } = sobel(L, w, h);
    const sm = { data: new Uint8ClampedArray(data), width: w, height: h };
    blurImage(sm, Math.max(0.4, 0.6 * s));
    const sd = sm.data;
    const st = 255 / (levels - 1);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] === 0) continue;
      const e = clamp((mag[i] * (2 + th * 0.6) - 0.04) * ei * 3, 0, 1);
      for (let c = 0; c < 3; c++) {
        const q = Math.round(sd[j + c] / st) * st;
        data[j + c] = q * (1 - e);
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Stamp                                                               */
/* ------------------------------------------------------------------ */

export const stamp: FilterDef = {
  id: 'stamp',
  name: 'Stamp',
  category: 'Artistic',
  icon: Stamp,
  description: 'Rubber-stamp print: two-tone threshold with rough edges and patchy, grungy ink.',
  keywords: ['rubber stamp', 'threshold', 'grunge', 'print', 'ink', 'two tone'],
  params: [
    pctP('balance', 'Light/dark balance', 0.5),
    pxP('smoothness', 'Smoothness', 0, 10, 2),
    pctP('roughness', 'Grunge', 0.45),
    colorP('ink', 'Ink', '#1a1a1a'),
    colorP('paper', 'Paper', '#f3efe6'),
    boolP('transparentPaper', 'Transparent paper', false),
    seedP(8),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const bal = clamp(num(p.balance, 0.5), 0, 1);
    const sm = Math.max(0, num(p.smoothness, 2)) * s;
    const rough = clamp(num(p.roughness, 0.45), 0, 1);
    const ink = rgb(p.ink, '#1a1a1a'),
      paper = rgb(p.paper, '#f3efe6');
    const transparent = bool(p.transparentPaper, false);
    const seed = num(p.seed, 8) | 0;
    const L = lumaPlane(img);
    for (let i = 0; i < n; i++) {
      const a = data[i * 4 + 3] / 255;
      L[i] = L[i] * a + (1 - a);
    }
    if (sm > 0.2) blurPlane(L, w, h, sm);
    const aa = 0.5 / Math.max(1, sm + 1); // ~1px soft threshold
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        const a = data[j + 3];
        if (a === 0) continue;
        const X = (x + ax) / s,
          Y = (y + ay) / s;
        const edgeNoise = (fbmValue(X * 0.08, Y * 0.08, seed, 3) - 0.5) * 0.18 * rough;
        let cov = clamp((bal - L[i] + edgeNoise) / (aa * 2) + 0.5, 0, 1);
        if (rough > 0 && cov > 0) {
          // patchy ink: low-frequency voids + fine speckle
          const voids = smoothstep(0.62 - rough * 0.12, 0.75, fbmValue(X * 0.012, Y * 0.012, seed + 1, 4));
          const speck = hash(Math.floor(X), Math.floor(Y), seed + 2) < rough * 0.12 ? 1 : 0;
          cov *= 1 - Math.max(voids * 0.85, speck * 0.9);
        }
        if (transparent) {
          data[j] = ink[0];
          data[j + 1] = ink[1];
          data[j + 2] = ink[2];
          data[j + 3] = a * cov;
        } else for (let c = 0; c < 3; c++) data[j + c] = paper[c] + (ink[c] - paper[c]) * cov;
      }
    }
    return img;
  },
};

export const artisticFilters: FilterDef[] = [cutout, watercolor, charcoal, pencilSketch, inkWash, posterEdges, stamp];
