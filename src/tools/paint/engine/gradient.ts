/**
 * Gradient tool rendering: a drag line (document space) → gradient pixels in a target's local
 * space. All five Photoshop kinds, high-precision 1024-entry LUT and optional dithering.
 */
import type { GradientKind, GradientStop } from '../../../core/types';
import { parseColor } from '../../../core/color';
import { rng } from '../../../core/noise';

export const LUT_SIZE = 1024;

/** RGBA float LUT (0..255 per channel) with LUT_SIZE entries. */
export function buildLUT(stops: GradientStop[], reverse = false, transparency = true): Float32Array {
  const lut = new Float32Array(LUT_SIZE * 4);
  const sorted = [...stops].sort((a, b) => a.offset - b.offset).map((s) => ({ o: Math.max(0, Math.min(1, s.offset)), c: parseColor(s.color) }));
  if (!sorted.length) return lut;
  for (let i = 0; i < LUT_SIZE; i++) {
    let t = i / (LUT_SIZE - 1);
    if (reverse) t = 1 - t;
    let k = 0;
    while (k < sorted.length - 1 && sorted[k + 1].o < t) k++;
    const s0 = sorted[k];
    const s1 = sorted[Math.min(k + 1, sorted.length - 1)];
    let f = 0;
    if (t <= s0.o) f = 0;
    else if (s1.o > s0.o) f = Math.max(0, Math.min(1, (t - s0.o) / (s1.o - s0.o)));
    else f = 1;
    const a = s0.c,
      b = t <= s0.o ? s0.c : s1.c;
    const o = i * 4;
    lut[o] = a.r + (b.r - a.r) * f;
    lut[o + 1] = a.g + (b.g - a.g) * f;
    lut[o + 2] = a.b + (b.b - a.b) * f;
    lut[o + 3] = transparency ? (a.a + (b.a - a.a) * f) * 255 : 255;
  }
  return lut;
}

/** Gradient parameter t (0..1) at a document point for a drag from s to e. */
export function gradientT(kind: GradientKind, px: number, py: number, sx: number, sy: number, ex: number, ey: number): number {
  const dx = ex - sx;
  const dy = ey - sy;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return 0;
  const qx = px - sx;
  const qy = py - sy;
  let t: number;
  switch (kind) {
    case 'linear':
      t = (qx * dx + qy * dy) / l2;
      break;
    case 'reflected':
      t = Math.abs((qx * dx + qy * dy) / l2);
      break;
    case 'radial':
      t = Math.sqrt((qx * qx + qy * qy) / l2);
      break;
    case 'angle': {
      const a = Math.atan2(dy, dx) - Math.atan2(qy, qx);
      t = a / (Math.PI * 2);
      t -= Math.floor(t);
      return t;
    }
    case 'diamond': {
      const l = Math.sqrt(l2);
      const u = Math.abs(qx * dx + qy * dy) / l;
      const v = Math.abs(-qx * dy + qy * dx) / l;
      t = (u + v) / l;
      break;
    }
    default:
      t = 0;
  }
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

let noiseTable: Float32Array | null = null;
function ditherNoise(): Float32Array {
  if (noiseTable) return noiseTable;
  const r = rng(0x5eed);
  noiseTable = new Float32Array(64 * 64);
  for (let i = 0; i < noiseTable.length; i++) noiseTable[i] = r() - 0.5;
  return noiseTable;
}

export interface GradientRender {
  kind: GradientKind;
  start: { x: number; y: number };
  end: { x: number; y: number };
  lut: Float32Array;
  dither: boolean;
}

/**
 * Fill `out` (an RGBA buffer of outW×outH) with the gradient. Output pixel (i, j) represents
 * local pixel (ox + (i + 0.5) / scale, oy + (j + 0.5) / scale), mapped to document space by
 * `toDoc` (null = identity).
 */
export function renderGradientPixels(
  out: Uint8ClampedArray,
  outW: number,
  outH: number,
  ox: number,
  oy: number,
  scale: number,
  toDoc: { a: number; b: number; c: number; d: number; e: number; f: number } | null,
  g: GradientRender,
) {
  const { kind, lut, dither } = g;
  const sx = g.start.x,
    sy = g.start.y,
    ex = g.end.x,
    ey = g.end.y;
  const m = toDoc ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const noise = dither ? ditherNoise() : null;
  const maxI = LUT_SIZE - 1;
  const dx = ex - sx,
    dy = ey - sy;
  const l2 = dx * dx + dy * dy || 1;
  const fastLinear = kind === 'linear' || kind === 'reflected';
  for (let j = 0; j < outH; j++) {
    const ly = oy + (j + 0.5) / scale;
    for (let i = 0; i < outW; i++) {
      const lx = ox + (i + 0.5) / scale;
      const px = m.a * lx + m.c * ly + m.e;
      const py = m.b * lx + m.d * ly + m.f;
      let t: number;
      if (fastLinear) {
        t = ((px - sx) * dx + (py - sy) * dy) / l2;
        if (kind === 'reflected') t = Math.abs(t);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      } else t = gradientT(kind, px, py, sx, sy, ex, ey);
      const fi = t * maxI;
      const i0 = fi | 0;
      const i1 = i0 < maxI ? i0 + 1 : i0;
      const f = fi - i0;
      const a0 = i0 * 4,
        a1 = i1 * 4;
      const o = (j * outW + i) * 4;
      const n = noise ? noise[((j & 63) << 6) | (i & 63)] : 0;
      out[o] = lut[a0] + (lut[a1] - lut[a0]) * f + n;
      out[o + 1] = lut[a0 + 1] + (lut[a1 + 1] - lut[a0 + 1]) * f + n;
      out[o + 2] = lut[a0 + 2] + (lut[a1 + 2] - lut[a0 + 2]) * f + n;
      out[o + 3] = lut[a0 + 3] + (lut[a1 + 3] - lut[a0 + 3]) * f + (noise ? n : 0);
    }
  }
}
