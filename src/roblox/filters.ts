/**
 * Roblox character filters (category 'Roblox'): rim-light, top-shade, silhouette, toon-roblox.
 * Pixel cores are pure functions over ImageData-compatible buffers (unit-tested in filters.test.ts).
 */
import { Contrast, Moon, Sparkles, UserRound } from 'lucide-react';
import type { ParamDef, ParamValues } from '../core/types';
import type { FilterDef } from '../registry';
import {
  alphaBounds,
  alphaFloat,
  blurFloat,
  clamp01,
  distanceToOutside,
  hasTransparency,
  hexToRgb,
  luma,
  sampleBilinear,
  smoothstep,
  sobel,
  type PixelBuffer,
} from './pixels';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);

/* ------------------------------------------------------------------ */
/* rim-light                                                           */
/* ------------------------------------------------------------------ */

export interface RimLightParams {
  color: string;
  width: number;
  angle: number;
  intensity: number;
  softness: number;
}

/**
 * Directional edge light: pixels whose neighbour in the light direction is transparent (or much
 * darker on fully opaque images) get the rim color screened on top.
 */
export function rimLightCore(img: PixelBuffer, p: RimLightParams, scale = 1): PixelBuffer {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  if (!n || p.intensity <= 0 || p.width <= 0) return img;
  const transparent = hasTransparency(img);
  const lumMix = transparent ? 0.15 : 1;
  const shape = new Float32Array(n);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    const a = d[q + 3] / 255;
    const l = luma(d[q], d[q + 1], d[q + 2]) / 255;
    shape[i] = a * (1 - lumMix + lumMix * l);
  }
  const off = Math.max(0.5, p.width * scale);
  const blurred = Float32Array.from(shape);
  blurFloat(blurred, w, h, Math.max(1, off * clamp01(p.softness) * 0.9));
  const rad = (p.angle * Math.PI) / 180;
  const lx = Math.cos(rad) * off;
  const ly = -Math.sin(rad) * off;
  const [cr, cg, cb] = hexToRgb(p.color);
  const k = clamp01(p.intensity) * 1.25;
  const outside = transparent ? 0 : null;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const s = shape[i];
      if (s <= 0.002) continue;
      const toward = sampleBilinear(blurred, w, h, x + lx, y + ly, outside);
      let rim = s - toward;
      if (rim <= 0) continue;
      rim = smoothstep(0, 0.85, rim) * k;
      if (rim > 1) rim = 1;
      const q = i * 4;
      // screen blend
      d[q] = 255 - ((255 - d[q]) * (255 - cr * rim)) / 255;
      d[q + 1] = 255 - ((255 - d[q + 1]) * (255 - cg * rim)) / 255;
      d[q + 2] = 255 - ((255 - d[q + 2]) * (255 - cb * rim)) / 255;
    }
  }
  return img;
}

/* ------------------------------------------------------------------ */
/* top-shade                                                           */
/* ------------------------------------------------------------------ */

export interface TopShadeParams {
  color: string;
  height: number;
  opacity: number;
  softness: number;
}

/** Gradient shadow over the top part of the subject (hair shadow over a blank face). */
export function topShadeCore(img: PixelBuffer, p: TopShadeParams): PixelBuffer {
  const { width: w, height: h, data: d } = img;
  if (p.opacity <= 0 || p.height <= 0) return img;
  const b = alphaBounds(img, 10) ?? { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const span = (b.y1 - b.y0 + 1) * clamp01(p.height);
  if (span < 1) return img;
  const fade = Math.max(0.02, clamp01(p.softness));
  const solidEnd = b.y0 + span * (1 - fade);
  const end = b.y0 + span;
  const [cr, cg, cb] = hexToRgb(p.color);
  const op = clamp01(p.opacity);
  const yMax = Math.min(h - 1, Math.ceil(end));
  for (let y = b.y0; y <= yMax; y++) {
    const f = y <= solidEnd ? 1 : 1 - smoothstep(solidEnd, end, y);
    const k = op * f;
    if (k <= 0.001) continue;
    let q = y * w * 4;
    for (let x = 0; x < w; x++, q += 4) {
      if (d[q + 3] === 0) continue;
      // multiply toward the shade color
      d[q] = d[q] * (1 - k) + ((d[q] * cr) / 255) * k;
      d[q + 1] = d[q + 1] * (1 - k) + ((d[q + 1] * cg) / 255) * k;
      d[q + 2] = d[q + 2] * (1 - k) + ((d[q + 2] * cb) / 255) * k;
    }
  }
  return img;
}

/* ------------------------------------------------------------------ */
/* silhouette                                                          */
/* ------------------------------------------------------------------ */

export interface SilhouetteParams {
  color: string;
  keepEdges: number;
}

/** Flat single-color silhouette (alpha preserved), optionally keeping faint interior edges. */
export function silhouetteCore(img: PixelBuffer, p: SilhouetteParams): PixelBuffer {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const [cr, cg, cb] = hexToRgb(p.color);
  const keep = clamp01(p.keepEdges);
  let edges: Float32Array | null = null;
  if (keep > 0) {
    const lum = new Float32Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) lum[i] = (luma(d[q], d[q + 1], d[q + 2]) / 255) * (d[q + 3] / 255);
    edges = sobel(lum, w, h);
  }
  // Interior edges are drawn as a lighter version of the silhouette color.
  const er = cr + (255 - cr) * 0.55,
    eg = cg + (255 - cg) * 0.55,
    eb = cb + (255 - cb) * 0.55;
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    if (d[q + 3] === 0) continue;
    let t = 0;
    if (edges) t = Math.min(1, edges[i] * 2.2) * keep;
    d[q] = cr + (er - cr) * t;
    d[q + 1] = cg + (eg - cg) * t;
    d[q + 2] = cb + (eb - cb) * t;
  }
  return img;
}

/* ------------------------------------------------------------------ */
/* toon-roblox                                                         */
/* ------------------------------------------------------------------ */

export interface ToonParams {
  levels: number;
  outlineWidth: number;
  outlineColor: string;
  shadowColor: string;
  shadowStrength: number;
  shadowThreshold: number;
  saturation: number;
  tint: string;
  tintStrength: number;
  edges: number;
  smooth: number;
}

/**
 * Cel-shaded Roblox look in one pass: hue-preserving luminance posterize (flat 3–4 tone bands),
 * tinted shadows, saturation/tint, interior ink edges and an inner silhouette outline.
 */
export function toonRobloxCore(img: PixelBuffer, p: ToonParams, scale = 1): PixelBuffer {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  if (!n) return img;
  const levels = Math.max(2, Math.min(16, Math.round(p.levels)));

  // Optional smoothing of the color channels before banding (reduces speckle in the bands).
  const smoothR = p.smooth * 3 * scale;
  let src: Float32Array[] | null = null;
  if (smoothR >= 1) {
    const r = new Float32Array(n),
      g = new Float32Array(n),
      b = new Float32Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      r[i] = d[q];
      g[i] = d[q + 1];
      b[i] = d[q + 2];
    }
    blurFloat(r, w, h, smoothR);
    blurFloat(g, w, h, smoothR);
    blurFloat(b, w, h, smoothR);
    src = [r, g, b];
  }

  // Interior edges from the original luminance.
  let edgeMap: Float32Array | null = null;
  if (p.edges > 0) {
    const lum = new Float32Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) lum[i] = (luma(d[q], d[q + 1], d[q + 2]) / 255) * (d[q + 3] / 255);
    if (scale > 1.5) blurFloat(lum, w, h, scale);
    edgeMap = sobel(lum, w, h);
  }

  const [sr, sg, sb] = hexToRgb(p.shadowColor);
  const [tr, tg, tb] = hexToRgb(p.tint);
  const shadowK = clamp01(p.shadowStrength);
  const thr = clamp01(p.shadowThreshold);
  const sat = 1 + Math.max(-100, Math.min(100, p.saturation)) / 100;
  const tintK = clamp01(p.tintStrength);
  const edgeK = clamp01(p.edges);
  const [or, og, ob] = hexToRgb(p.outlineColor);

  for (let i = 0, q = 0; i < n; i++, q += 4) {
    if (d[q + 3] === 0) continue;
    let r = src ? src[0][i] : d[q];
    let g = src ? src[1][i] : d[q + 1];
    let b = src ? src[2][i] : d[q + 2];
    const L = luma(r, g, b) / 255;
    // band index with a slight bias so mid-tones fall into readable bands
    const band = Math.min(levels - 1, Math.floor(L * levels));
    const Lq = levels === 1 ? L : (band + 0.5) / levels;
    const ratio = L > 0.004 ? Lq / L : 0;
    if (L > 0.004) {
      r *= ratio;
      g *= ratio;
      b *= ratio;
      // Keep saturated colors from blowing out: renormalize the max channel.
      const mx = Math.max(r, g, b);
      if (mx > 255) {
        const f = 255 / mx;
        const add = (Lq * 255 - luma(r * f, g * f, b * f)) * 0.8;
        r = r * f + add;
        g = g * f + add;
        b = b * f + add;
      }
    } else {
      r = g = b = Lq * 255;
    }
    // shadow tint for the dark bands
    if (shadowK > 0 && Lq < thr) {
      const k = shadowK * (1 - Lq / Math.max(0.001, thr) * 0.5);
      r = r * (1 - k) + ((r * sr) / 255 + sr * 0.15) * k;
      g = g * (1 - k) + ((g * sg) / 255 + sg * 0.15) * k;
      b = b * (1 - k) + ((b * sb) / 255 + sb * 0.15) * k;
    }
    // saturation
    if (sat !== 1) {
      const l2 = luma(r, g, b);
      r = l2 + (r - l2) * sat;
      g = l2 + (g - l2) * sat;
      b = l2 + (b - l2) * sat;
    }
    // tint (colorize toward tint color by luminance)
    if (tintK > 0) {
      const l3 = luma(r, g, b) / 255;
      r = r * (1 - tintK) + tr * l3 * tintK;
      g = g * (1 - tintK) + tg * l3 * tintK;
      b = b * (1 - tintK) + tb * l3 * tintK;
    }
    // interior ink edges
    if (edgeMap) {
      const e = smoothstep(0.12, 0.45, edgeMap[i]) * edgeK;
      if (e > 0) {
        r = r * (1 - e) + or * e;
        g = g * (1 - e) + og * e;
        b = b * (1 - e) + ob * e;
      }
    }
    d[q] = r;
    d[q + 1] = g;
    d[q + 2] = b;
  }

  // Inner silhouette outline (inside the alpha edge so it never gets clipped by the layer box).
  const ow = p.outlineWidth * scale;
  if (ow > 0.05 && hasTransparency(img)) {
    const inside = new Uint8Array(n);
    for (let i = 0, q = 3; i < n; i++, q += 4) inside[i] = d[q] >= 128 ? 1 : 0;
    const dist = distanceToOutside(inside, w, h, false);
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      if (d[q + 3] === 0) continue;
      const dv = inside[i] ? dist[i] : 0.5;
      const t = 1 - smoothstep(ow - 0.5, ow + 0.5, dv);
      if (t <= 0) continue;
      d[q] = d[q] * (1 - t) + or * t;
      d[q + 1] = d[q + 1] * (1 - t) + og * t;
      d[q + 2] = d[q + 2] * (1 - t) + ob * t;
    }
  }
  return img;
}

/* ------------------------------------------------------------------ */
/* Filter definitions                                                  */
/* ------------------------------------------------------------------ */

export const rimLightParams: ParamDef[] = [
  { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
  { key: 'width', label: 'Width', type: 'number', min: 0, max: 60, step: 1, default: 12, unit: 'px' },
  { key: 'angle', label: 'Angle', type: 'angle', default: 135, hint: 'Direction the light comes from' },
  { key: 'intensity', label: 'Intensity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8, displayScale: 100, unit: '%' },
  { key: 'softness', label: 'Softness', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, displayScale: 100, unit: '%' },
];

export const topShadeParams: ParamDef[] = [
  { key: 'color', label: 'Color', type: 'color', default: '#000000' },
  { key: 'height', label: 'Height', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, displayScale: 100, unit: '%' },
  { key: 'opacity', label: 'Opacity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, displayScale: 100, unit: '%' },
  { key: 'softness', label: 'Fade', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, displayScale: 100, unit: '%' },
];

export const silhouetteParams: ParamDef[] = [
  { key: 'color', label: 'Color', type: 'color', default: '#0b0b0b' },
  { key: 'keepEdges', label: 'Keep Edges', type: 'number', min: 0, max: 1, step: 0.01, default: 0, displayScale: 100, unit: '%' },
];

export const toonParams: ParamDef[] = [
  { key: 'levels', label: 'Tones', type: 'number', min: 2, max: 8, step: 1, default: 4, group: 'Shading' },
  { key: 'smooth', label: 'Smooth', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25, displayScale: 100, unit: '%', group: 'Shading' },
  { key: 'shadowColor', label: 'Shadow', type: 'color', default: '#1b1530', group: 'Shading' },
  { key: 'shadowStrength', label: 'Shadow Amt', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, displayScale: 100, unit: '%', group: 'Shading' },
  { key: 'shadowThreshold', label: 'Shadow Lvl', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, displayScale: 100, unit: '%', group: 'Shading' },
  { key: 'saturation', label: 'Saturation', type: 'number', min: -100, max: 100, step: 1, default: 0, group: 'Color' },
  { key: 'tint', label: 'Tint', type: 'color', default: '#ffffff', group: 'Color' },
  { key: 'tintStrength', label: 'Tint Amt', type: 'number', min: 0, max: 1, step: 0.01, default: 0, displayScale: 100, unit: '%', group: 'Color' },
  { key: 'outlineWidth', label: 'Outline', type: 'number', min: 0, max: 12, step: 0.5, default: 3, unit: 'px', group: 'Ink' },
  { key: 'outlineColor', label: 'Ink Color', type: 'color', default: '#000000', group: 'Ink' },
  { key: 'edges', label: 'Inner Lines', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25, displayScale: 100, unit: '%', group: 'Ink' },
];

function readRim(v: ParamValues): RimLightParams {
  return {
    color: str(v.color, '#ffffff'),
    width: num(v.width, 12),
    angle: num(v.angle, 135),
    intensity: num(v.intensity, 0.8),
    softness: num(v.softness, 0.5),
  };
}

export function readToon(v: ParamValues): ToonParams {
  return {
    levels: num(v.levels, 4),
    outlineWidth: num(v.outlineWidth, 3),
    outlineColor: str(v.outlineColor, '#000000'),
    shadowColor: str(v.shadowColor, '#1b1530'),
    shadowStrength: num(v.shadowStrength, 0.45),
    shadowThreshold: num(v.shadowThreshold, 0.45),
    saturation: num(v.saturation, 0),
    tint: str(v.tint, '#ffffff'),
    tintStrength: num(v.tintStrength, 0),
    edges: num(v.edges, 0.25),
    smooth: num(v.smooth, 0.25),
  };
}

export const robloxFilters: FilterDef[] = [
  {
    id: 'rim-light',
    name: 'Rim Light',
    category: 'Roblox',
    description: 'Directional edge light from the subject outline — crimson/neon back-light looks.',
    keywords: ['rim', 'edge', 'back light', 'glow', 'roblox'],
    icon: Sparkles,
    params: rimLightParams,
    apply(img, params, ctx) {
      return rimLightCore(img, readRim(params), ctx.scale) as ImageData;
    },
  },
  {
    id: 'top-shade',
    name: 'Top Shade',
    category: 'Roblox',
    description: 'Gradient shadow over the top of the character (hair shadow over a blank face).',
    keywords: ['shadow', 'hair', 'face', 'gradient', 'roblox'],
    icon: Moon,
    params: topShadeParams,
    apply(img, params) {
      return topShadeCore(img, {
        color: str(params.color, '#000000'),
        height: num(params.height, 0.35),
        opacity: num(params.opacity, 0.6),
        softness: num(params.softness, 0.7),
      }) as ImageData;
    },
  },
  {
    id: 'silhouette',
    name: 'Silhouette',
    category: 'Roblox',
    description: 'Turn the character into a flat silhouette (noir thumbnails).',
    keywords: ['silhouette', 'shadow', 'flat', 'noir', 'roblox'],
    icon: UserRound,
    params: silhouetteParams,
    apply(img, params) {
      return silhouetteCore(img, { color: str(params.color, '#0b0b0b'), keepEdges: num(params.keepEdges, 0) }) as ImageData;
    },
  },
  {
    id: 'toon-roblox',
    name: 'Toon Roblox',
    category: 'Roblox',
    description: 'Posterized cel shading + ink outline + tinted shadows in one filter.',
    keywords: ['toon', 'cel', 'posterize', 'outline', 'anime', 'roblox'],
    icon: Contrast,
    params: toonParams,
    apply(img, params, ctx) {
      return toonRobloxCore(img, readToon(params), ctx.scale) as ImageData;
    },
  },
];
