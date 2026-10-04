/**
 * Procedural painters used by templates for atmosphere that must look a specific way regardless
 * of the asset library (billowing smoke behind a character, soft glows). The field math is pure
 * (typed arrays, no canvas) so it is unit tested; `smokeCanvas` turns a field into pixels.
 */
import { createNoise2D } from '../core/noise';
import { gradientLUT } from '../core/color';
import { createCanvas } from '../core/canvas';

export type SmokeSide = 'left' | 'right' | 'center' | 'bottom' | 'full';

export interface SmokeOptions {
  /** Main smoke color (mid tones). */
  color: string;
  /** Deep shadow tone inside the billows (default: color darkened). */
  shadow?: string;
  /** Lit highlight tone on billow tops (default: color lightened). */
  highlight?: string;
  seed?: number;
  side?: SmokeSide;
  /** 0..1 how far the smoke reaches across the canvas. */
  coverage?: number;
  /** 0..1 overall opacity of the smoke. */
  density?: number;
  /** Billow size multiplier (1 = billows ≈ 1/3 of the canvas height). */
  scale?: number;
  /** 0..1 domain-warp strength (curling). */
  curl?: number;
  /** Normalized center for side 'center' (0..1). */
  cx?: number;
  cy?: number;
}

const ROT_C = Math.cos(0.65);
const ROT_S = Math.sin(0.65);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

/** Placement mask 0..1 at a normalized position (wobble perturbs the edge). */
export function sideMask(side: SmokeSide, nx: number, ny: number, coverage: number, wobble: number, aspect: number, cx = 0.5, cy = 0.55): number {
  const w = wobble * 0.18;
  const reach = 0.15 + coverage * 0.75; // fraction of the canvas covered
  switch (side) {
    case 'right':
      return smoothstep(1 - reach - 0.1, 1 - reach + 0.25, nx + w);
    case 'left':
      return smoothstep(1 - reach - 0.1, 1 - reach + 0.25, 1 - nx + w);
    case 'bottom':
      return smoothstep(1 - reach - 0.1, 1 - reach + 0.3, ny + w);
    case 'center': {
      const dx = (nx - cx) * aspect;
      const dy = ny - cy;
      const d = Math.sqrt(dx * dx + dy * dy) + w * 0.5;
      return 1 - smoothstep(reach * 0.35, reach * 0.35 + 0.35, d);
    }
    default:
      return 0.55 + 0.45 * coverage + w;
  }
}

/**
 * Smoke density field (0..1) of size fw×fh. Billows = domain-warped fBm shaped by the placement
 * mask; deterministic for a given seed.
 */
export function smokeField(fw: number, fh: number, o: SmokeOptions): Float32Array {
  const seed = o.seed ?? 7;
  const n0 = createNoise2D(seed);
  const n1 = createNoise2D(seed + 101);
  const n2 = createNoise2D(seed + 202);
  const side = o.side ?? 'right';
  const coverage = o.coverage ?? 0.6;
  const curl = o.curl ?? 0.5;
  const aspect = fw / Math.max(1, fh);
  // Noise units per field pixel: about 1.8 big billows across the canvas height at scale 1.
  const k = 1.8 / Math.max(0.1, o.scale ?? 1) / Math.max(1, fh);
  const out = new Float32Array(fw * fh);
  const warp = 0.1 + curl * 0.35;
  // Highest octave stays below ~0.12 cycles per field pixel (finer detail would alias to grain).
  const octaves = Math.max(2, Math.min(6, Math.floor(Math.log(0.12 / k) / Math.log(2.1)) + 1));
  for (let j = 0; j < fh; j++) {
    for (let i = 0; i < fw; i++) {
      const x = i * k;
      const y = j * k;
      const qx = n1(x * 0.5, y * 0.5);
      const qy = n2(x * 0.5 + 5.2, y * 0.5 + 1.3);
      const wx = x + warp * qx;
      const wy = y + warp * qy;
      // Fluffy fBm ("render clouds"): big soft body + fading fine puffs.
      let f = 0;
      let amp = 0.5;
      let norm = 0;
      // Warped coordinates for the big billows; plain ones for fine puffs (warping fine
      // octaves stretches them into streaks).
      let px = wx;
      let py = wy;
      let ux = x;
      let uy = y;
      for (let oct = 0; oct < octaves; oct++) {
        const sx = oct < 3 ? px : ux;
        const sy = oct < 3 ? py : uy;
        f += amp * n0(sx + oct * 17.3, sy - oct * 9.1);
        norm += amp;
        amp *= 0.56;
        // next octave: ×2.1 frequency, rotated ~37° so lattice artifacts don't line up
        const nx = (px * ROT_C - py * ROT_S) * 2.1;
        py = (px * ROT_S + py * ROT_C) * 2.1;
        px = nx;
        const mx = (ux * ROT_C - uy * ROT_S) * 2.1;
        uy = (ux * ROT_S + uy * ROT_C) * 2.1;
        ux = mx;
      }
      f /= norm; // ~[-0.7, 0.7]
      const v = 0.5 + f * 0.8; // ~[0, 1]
      const m = sideMask(side, i / fw, j / fh, coverage, qx, aspect, o.cx, o.cy);
      // The mask pushes the threshold: thin wisps at the edge, dense body inside.
      const d = (v - (1 - m) * 0.7 - 0.16) * 1.25;
      out[j * fw + i] = clamp01(d) * clamp01(m * 1.6);
    }
  }
  return out;
}

/**
 * Shade a density field into RGBA pixels (written to `data`, length fw*fh*4). Billows are lit
 * from the top-left: tops pick up the highlight tone, folds sink into the shadow tone.
 */
export function shadeSmoke(field: Float32Array, fw: number, fh: number, o: SmokeOptions, data: Uint8ClampedArray) {
  const lut = gradientLUT([
    { offset: 0, color: o.shadow ?? darken(o.color, 0.75) },
    { offset: 0.5, color: o.color },
    { offset: 0.88, color: o.highlight ?? lighten(o.color, 0.22) },
    { offset: 1, color: lighten(o.highlight ?? lighten(o.color, 0.22), 0.25) },
  ]);
  const density = o.density ?? 0.85;
  // Gradient footprint ~1% of the field so lighting follows billows, not fine noise.
  const r = Math.max(1, Math.round(Math.min(fw, fh) * 0.012));
  for (let j = 0; j < fh; j++) {
    for (let i = 0; i < fw; i++) {
      const idx = j * fw + i;
      const d = field[idx];
      const p = idx * 4;
      if (d <= 0.003) {
        data[p + 3] = 0;
        continue;
      }
      const xr = Math.min(fw - 1, i + r);
      const xl = Math.max(0, i - r);
      const yb = Math.min(fh - 1, j + r);
      const yt = Math.max(0, j - r);
      const gx = (field[j * fw + xr] - field[j * fw + xl]) / (xr - xl || 1);
      const gy = (field[yb * fw + i] - field[yt * fw + i]) / (yb - yt || 1);
      // light from the top-left: surfaces facing up-left catch the highlight
      const lit = Math.max(-1, Math.min(1, -(gx * 0.6 + gy * 0.8) * r * 4));
      const t = clamp01(0.1 + d * 0.85 + lit * 0.05);
      const li = Math.round(t * 255) * 4;
      data[p] = lut[li];
      data[p + 1] = lut[li + 1];
      data[p + 2] = lut[li + 2];
      data[p + 3] = Math.round(clamp01(Math.pow(d, 0.75) * density) * 255);
    }
  }
}

/** Render smoke into a new canvas of width×height (computed at reduced resolution, upscaled smoothly). */
export function smokeCanvas(width: number, height: number, o: SmokeOptions): HTMLCanvasElement {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const f = Math.min(1, 480 / Math.max(W, H));
  const fw = Math.max(8, Math.round(W * f));
  const fh = Math.max(8, Math.round(H * f));
  const field = smokeField(fw, fh, o);
  const small = createCanvas(fw, fh);
  const sctx = small.getContext('2d');
  const out = createCanvas(W, H);
  const ctx = out.getContext('2d');
  if (!sctx || !ctx) return out;
  const img = sctx.createImageData(fw, fh);
  shadeSmoke(field, fw, fh, o, img.data);
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // A touch of blur hides the upscale and gives the volume a soft, photographic falloff.
  ctx.filter = `blur(${Math.max(0.6, (1 / f) * 1.1).toFixed(2)}px)`;
  ctx.drawImage(small, 0, 0, W, H);
  ctx.filter = 'none';
  return out;
}

/* ---------------- small color helpers (hex in, hex out) ---------------- */

function hexToRgb(hex: string): [number, number, number] {
  let s = hex.replace('#', '').trim();
  if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Mix a color towards black by k (0..1). */
export function darken(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * (1 - k), g * (1 - k), b * (1 - k));
}

/** Mix a color towards white by k (0..1). */
export function lighten(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k);
}
