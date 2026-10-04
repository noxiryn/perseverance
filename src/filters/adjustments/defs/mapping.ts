/** Mapping adjustments: Gradient Map, Duotone, Split Toning, Color Lookup, Solid Tint. */
import { Blend, Clapperboard, Columns2, Droplets, PaintBucket } from 'lucide-react';
import type { Gradient, ParamValues } from '../../../core/types';
import type { FilterDef } from '../../../registry';
import { LOOK_PRESETS, LUT_SIZE, isKnownLook, lookCube } from '../looks';
import { BAYER4, apply3DLut, applyLuts, clamp01, gradientLutFloat, lum3, luma, rgbOf, sCurve, setLumInto, type Pixels } from '../math';
import { bool, boolP, colorP, gradientP, isGradient, num, numP, pctP, selectP, str } from '../params';

/* ================================================================== */
/* Gradient Map                                                        */
/* ================================================================== */

export const DEFAULT_MAP_GRADIENT: Gradient = {
  kind: 'linear',
  angle: 0,
  scale: 1,
  stops: [
    { offset: 0, color: '#000000' },
    { offset: 1, color: '#ffffff' },
  ],
};

/** LUT resolution: 4 entries per luma level (index = (r·306 + g·601 + b·117) >> 8 ∈ 0..1020). */
const MAP_SIZE = 1021;

/**
 * Map luminosity through a gradient. Stops with alpha blend the mapped color over the original;
 * `dither` adds an ordered (Bayer 4×4) dither to hide banding in smooth gradients.
 */
export function gradientMapPixels(img: Pixels, gradient: Gradient, reverse: boolean, dither: boolean): Pixels {
  const rev = reverse !== !!gradient.reverse;
  const lut = gradientLutFloat(gradient.stops, rev, MAP_SIZE);
  let opaque = true;
  for (let k = 3; k < lut.length; k += 4) if (lut[k] < 0.999) opaque = false;
  const d = img.data;
  const w = img.width;
  const h = img.height;
  if (!dither && opaque) {
    // Fast path: integer luma index straight into a rounded RGB table.
    const t8 = new Uint8ClampedArray(MAP_SIZE * 3);
    for (let k = 0; k < MAP_SIZE; k++) {
      t8[k * 3] = lut[k * 4];
      t8[k * 3 + 1] = lut[k * 4 + 1];
      t8[k * 3 + 2] = lut[k * 4 + 2];
    }
    for (let i = 0, n = d.length; i < n; i += 4) {
      if (d[i + 3] === 0) continue;
      const k = ((d[i] * 306 + d[i + 1] * 601 + d[i + 2] * 117) >> 8) * 3;
      d[i] = t8[k];
      d[i + 1] = t8[k + 1];
      d[i + 2] = t8[k + 2];
    }
    return img;
  }
  for (let y = 0; y < h; y++) {
    let i = y * w * 4;
    const row = (y & 3) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      let t = (r * 306 + g * 601 + b * 117) / 256;
      let n = 0;
      if (dither) {
        n = BAYER4[row + (x & 3)];
        t += n * 4;
      }
      const k = (t <= 0 ? 0 : t >= MAP_SIZE - 1 ? MAP_SIZE - 1 : Math.round(t)) * 4;
      let mr = lut[k] + n,
        mg = lut[k + 1] + n,
        mb = lut[k + 2] + n;
      const ma = lut[k + 3];
      if (ma < 1) {
        mr = r + (mr - r) * ma;
        mg = g + (mg - g) * ma;
        mb = b + (mb - b) * ma;
      }
      d[i] = mr;
      d[i + 1] = mg;
      d[i + 2] = mb;
    }
  }
  return img;
}

export const gradientMap: FilterDef = {
  id: 'gradient-map',
  name: 'Gradient Map',
  category: 'Color',
  description: 'Recolor the image by mapping its luminosity onto a gradient (amber, crimson, noir looks…).',
  keywords: ['gradient map', 'recolor', 'tone', 'duotone', 'amber', 'orange'],
  icon: Blend,
  adjustment: true,
  params: [
    gradientP('gradient', 'Gradient', DEFAULT_MAP_GRADIENT),
    boolP('reverse', 'Reverse', false),
    boolP('dither', 'Dither', false, { hint: 'Ordered dithering to hide banding' }),
  ],
  apply(img, p) {
    const g = isGradient(p.gradient) ? p.gradient : DEFAULT_MAP_GRADIENT;
    gradientMapPixels(img, g, bool(p, 'reverse', false), bool(p, 'dither', false));
    return img;
  },
};

/* ================================================================== */
/* Duotone                                                             */
/* ================================================================== */

/** 256×3 table: luma (after contrast) → mix(shadow, highlight). */
export function duotoneTable(shadow: string, highlight: string, contrast: number): Uint8ClampedArray {
  const [sr, sg, sb] = rgbOf(shadow);
  const [hr, hg, hb] = rgbOf(highlight);
  const c = Math.max(-100, Math.min(100, contrast)) / 100;
  const t = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    let x = v / 255;
    if (c > 0) x = sCurve(x, 1 + c * 2);
    else if (c < 0) x = 0.5 + (x - 0.5) * (1 + c * 0.7);
    t[v * 3] = sr + (hr - sr) * x;
    t[v * 3 + 1] = sg + (hg - sg) * x;
    t[v * 3 + 2] = sb + (hb - sb) * x;
  }
  return t;
}

export function duotonePixels(img: Pixels, shadow: string, highlight: string, contrast: number): Pixels {
  const t = duotoneTable(shadow, highlight, contrast);
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const k = ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29 + 128) >> 8) * 3;
    d[i] = t[k];
    d[i + 1] = t[k + 1];
    d[i + 2] = t[k + 2];
  }
  return img;
}

export const duotone: FilterDef = {
  id: 'duotone',
  name: 'Duotone',
  category: 'Color',
  description: 'Two-ink print look: shadows in one color, highlights in another.',
  keywords: ['duotone', 'two tone', 'print', 'poster'],
  icon: Droplets,
  adjustment: true,
  params: [colorP('shadow', 'Shadows', '#1a1a1a'), colorP('highlight', 'Highlights', '#f2f2f2'), numP('contrast', 'Contrast', -100, 100, 0)],
  apply(img, p) {
    duotonePixels(img, str(p, 'shadow', '#1a1a1a'), str(p, 'highlight', '#f2f2f2'), num(p, 'contrast', 0));
    return img;
  },
};

/* ================================================================== */
/* Split Toning                                                        */
/* ================================================================== */

/**
 * Per-luma chroma offsets: shadows get the shadow color's chroma, highlights the highlight
 * color's (zero-luma offsets, so brightness is preserved). Balance moves the crossover.
 */
export function splitToningTable(shadowColor: string, highlightColor: string, balance: number, amount: number): Float32Array {
  const chroma = (c: string) => {
    const [r, g, b] = rgbOf(c);
    const l = luma(r, g, b);
    return [r - l, g - l, b - l];
  };
  const cs = chroma(shadowColor);
  const ch = chroma(highlightColor);
  const pivot = 0.5 - (Math.max(-100, Math.min(100, balance)) / 100) * 0.4;
  const amt = Math.max(0, Math.min(1, amount));
  const t = new Float32Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    const u = clamp01((x - (pivot - 0.4)) / 0.8);
    const wh = u * u * (3 - 2 * u);
    const ws = 1 - wh;
    const es = Math.min(1, x * 6);
    const eh = Math.min(1, (1 - x) * 6);
    for (let c = 0; c < 3; c++) t[v * 3 + c] = amt * (ws * es * cs[c] + wh * eh * ch[c]);
  }
  return t;
}

export function splitToningPixels(img: Pixels, p: ParamValues): Pixels {
  const amount = num(p, 'amount', 0.5, 0, 1);
  if (amount === 0) return img;
  const t = splitToningTable(str(p, 'shadowColor', '#1d6f8a'), str(p, 'highlightColor', '#f2a03d'), num(p, 'balance', 0), amount);
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const k = ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29 + 128) >> 8) * 3;
    d[i] += t[k];
    d[i + 1] += t[k + 1];
    d[i + 2] += t[k + 2];
  }
  return img;
}

export const splitToning: FilterDef = {
  id: 'split-toning',
  name: 'Split Toning',
  category: 'Color',
  description: 'Tint shadows and highlights with different colors (teal & orange, cold & warm…).',
  keywords: ['split toning', 'color grade', 'teal orange', 'cinematic'],
  icon: Columns2,
  adjustment: true,
  params: [
    colorP('shadowColor', 'Shadows', '#1d6f8a'),
    colorP('highlightColor', 'Highlights', '#f2a03d'),
    numP('balance', 'Balance', -100, 100, 0, { hint: 'Positive favors the highlight color' }),
    pctP('amount', 'Amount', 0.5),
  ],
  apply(img, p) {
    splitToningPixels(img, p);
    return img;
  },
};

/* ================================================================== */
/* Color Lookup (parametric looks)                                     */
/* ================================================================== */

export const colorLookup: FilterDef = {
  id: 'color-lookup',
  name: 'Color Lookup',
  category: 'Color',
  description: 'Cinematic color looks (teal & orange, bleach bypass, crimson, noir…) built procedurally.',
  keywords: ['color lookup', 'lut', 'look', 'grade', 'cinematic', 'film'],
  icon: Clapperboard,
  adjustment: true,
  params: [selectP('preset', 'Look', LOOK_PRESETS, 'teal-orange'), pctP('intensity', 'Intensity', 1)],
  apply(img, p) {
    const id = str(p, 'preset', 'teal-orange');
    const intensity = num(p, 'intensity', 1, 0, 1);
    if (!isKnownLook(id) || intensity <= 0) return img;
    apply3DLut(img, lookCube(id), LUT_SIZE, intensity);
    return img;
  },
};

/* ================================================================== */
/* Solid Tint                                                          */
/* ================================================================== */

export const TINT_MODES: [string, string][] = [
  ['color', 'Color'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['soft-light', 'Soft Light'],
  ['hard-light', 'Hard Light'],
  ['hue', 'Hue'],
  ['normal', 'Normal'],
];

const sc = new Float64Array(3);

/** Luminance index for the W3C lum (0.3/0.59/0.11) at 4× precision: 0..1020. */
const LUM_STEPS = 1020;

/** Blend a solid color onto each pixel with a blend mode (W3C formulas), mixed by `amount`. */
export function solidTintPixels(img: Pixels, color: string, mode: string, amount: number): Pixels {
  const a = Math.max(0, Math.min(1, amount));
  if (a === 0) return img;
  const [tr, tg, tb] = rgbOf(color).map((v) => v / 255);
  const tint = [tr, tg, tb];
  if (mode === 'color') return solidTintColor(img, tr, tg, tb, a);
  if (mode === 'hue') return solidTintHue(img, tr, tg, tb, a);
  const sep = (cb: number, cs: number): number => {
    switch (mode) {
      case 'multiply':
        return cb * cs;
      case 'screen':
        return cb + cs - cb * cs;
      case 'overlay':
        return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
      case 'hard-light':
        return cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
      case 'soft-light': {
        if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
        const dd = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
        return cb + (2 * cs - 1) * (dd - cb);
      }
      default:
        return cs;
    }
  };
  // Separable modes only depend on the channel value → 3 LUTs (pre-mixed by amount).
  const luts = [0, 1, 2].map((c) => {
    const l = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) l[v] = v + (sep(v / 255, tint[c]) * 255 - v) * a;
    return l;
  });
  applyLuts(img, luts[0], luts[1], luts[2]);
  return img;
}

/**
 * W3C "color" blend with a constant source: SetLum(tint, Lum(base)). The result only depends on
 * the base luminance, so it is a 1021-entry table indexed by an integer luminance.
 */
function solidTintColor(img: Pixels, tr: number, tg: number, tb: number, a: number): Pixels {
  const table = new Float32Array((LUM_STEPS + 1) * 3);
  for (let k = 0; k <= LUM_STEPS; k++) {
    setLumInto(tr, tg, tb, k / LUM_STEPS, sc);
    table[k * 3] = sc[0] * 255;
    table[k * 3 + 1] = sc[1] * 255;
    table[k * 3 + 2] = sc[2] * 255;
  }
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    // 0.3/0.59/0.11 × 1024 → index 0..1020 (rounded).
    const k = ((r * 307 + g * 604 + b * 113 + 128) >> 8) * 3;
    d[i] = r + (table[k] - r) * a;
    d[i + 1] = g + (table[k + 1] - g) * a;
    d[i + 2] = b + (table[k + 2] - b) * a;
  }
  return img;
}

/**
 * W3C "hue" blend with a constant source: SetLum(SetSat(tint, Sat(base)), Lum(base)), inlined.
 * SetSat(tint, s) = shape·s where shape = (tint − min) / range has one 0 and one 1 component,
 * so after SetLum the min/max channels are known in closed form (no per-pixel sorting).
 */
function solidTintHue(img: Pixels, tr: number, tg: number, tb: number, a: number): Pixels {
  const mx = Math.max(tr, tg, tb);
  const mn = Math.min(tr, tg, tb);
  const range = mx - mn;
  const d = img.data;
  if (range <= 0) {
    // Gray tint: no hue → the result is the base luminance (gray).
    for (let i = 0, n = d.length; i < n; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const L = 0.3 * r + 0.59 * g + 0.11 * b;
      d[i] = r + (L - r) * a;
      d[i + 1] = g + (L - g) * a;
      d[i + 2] = b + (L - b) * a;
    }
    return img;
  }
  const s0 = (tr - mn) / range,
    s1 = (tg - mn) / range,
    s2 = (tb - mn) / range;
  const ls = lum3(s0, s1, s2);
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    const bmx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const bmn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const s = (bmx - bmn) / 255;
    const L = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
    // SetLum: c = shape·s + (L − lum(shape·s)); min channel = L − s·ls, max = L + s − s·ls.
    const off = L - s * ls;
    let c0 = s0 * s + off,
      c1 = s1 * s + off,
      c2 = s2 * s + off;
    const lo = off;
    const hi = s + off;
    if (lo < 0) {
      const k = L / (L - lo || 1);
      c0 = L + (c0 - L) * k;
      c1 = L + (c1 - L) * k;
      c2 = L + (c2 - L) * k;
    } else if (hi > 1) {
      const k = (1 - L) / (hi - L || 1);
      c0 = L + (c0 - L) * k;
      c1 = L + (c1 - L) * k;
      c2 = L + (c2 - L) * k;
    }
    d[i] = r + (c0 * 255 - r) * a;
    d[i + 1] = g + (c1 * 255 - g) * a;
    d[i + 2] = b + (c2 * 255 - b) * a;
  }
  return img;
}

export const solidTint: FilterDef = {
  id: 'solid-tint',
  name: 'Solid Tint',
  category: 'Color',
  description: 'Wash the image with a solid color using a blend mode (red tint, amber wash…).',
  keywords: ['tint', 'color fill', 'wash', 'overlay', 'red tint'],
  icon: PaintBucket,
  adjustment: true,
  params: [colorP('color', 'Color', '#c4141c'), selectP('mode', 'Mode', TINT_MODES, 'color'), pctP('amount', 'Amount', 1)],
  apply(img, p) {
    solidTintPixels(img, str(p, 'color', '#c4141c'), str(p, 'mode', 'color'), num(p, 'amount', 1, 0, 1));
    return img;
  },
};

export const MAPPING_DEFS: FilterDef[] = [gradientMap, duotone, splitToning, colorLookup, solidTint];
