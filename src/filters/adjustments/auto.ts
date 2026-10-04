/**
 * Auto Tone / Auto Contrast / Auto Color parameter computation (pure, testable).
 *  - Auto Contrast = "Enhance Monochromatic Contrast": one black/white point for all channels
 *    (colors are preserved) → Levels params.
 *  - Auto Tone = "Enhance Per Channel Contrast": each channel stretched separately → Curves.
 *  - Auto Color = "Find Dark & Light Colors" + "Snap Neutral Midtones" → Curves.
 */
import type { CurvePoints, CurvesValue } from '../../core/types';
import { clipRange, computeHistogram, sumChannels, type Histogram } from './histogram';
import type { Pixels } from './math';

export const AUTO_CLIP = 0.001; // 0.1% — Photoshop's default shadow/highlight clipping

const line = (lo: number, hi: number): CurvePoints =>
  lo <= 0 && hi >= 255
    ? [
        [0, 0],
        [255, 255],
      ]
    : [
        [Math.round(lo), 0],
        [Math.round(hi), 255],
      ];

const IDENT: CurvePoints = [
  [0, 0],
  [255, 255],
];

export function isIdentityCurves(c: CurvesValue): boolean {
  const id = (p: CurvePoints) => p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 255 && p[1][1] === 255;
  return id(c.rgb) && id(c.r) && id(c.g) && id(c.b);
}

/** Levels params for Auto Contrast, or null when the image already spans the full range. */
export function autoContrastParams(h: Histogram, clip = AUTO_CLIP): { inBlack: number; inWhite: number } | null {
  if (!h.count) return null;
  const [lo, hi] = clipRange(sumChannels(h.r, h.g, h.b), clip);
  if (hi - lo < 2) return null; // flat image: nothing meaningful to stretch
  const inBlack = Math.min(253, lo);
  const inWhite = Math.max(inBlack + 2, hi);
  if (inBlack <= 0 && inWhite >= 255) return null;
  return { inBlack, inWhite };
}

/** Curves for Auto Tone (per-channel stretch), or null when nothing changes. */
export function autoToneCurves(h: Histogram, clip = AUTO_CLIP): CurvesValue | null {
  if (!h.count) return null;
  const ch = (c: Uint32Array) => {
    const [lo, hi] = clipRange(c, clip);
    return hi - lo < 2 ? IDENT : line(lo, hi);
  };
  const out: CurvesValue = { rgb: IDENT, r: ch(h.r), g: ch(h.g), b: ch(h.b) };
  return isIdentityCurves(out) ? null : out;
}

/**
 * Curves for Auto Color. Black/white points come from the average color of the darkest and
 * lightest pixels (neutralizes casts in shadows and highlights); then each channel's midtone
 * is pulled so near-neutral midtones become gray.
 */
export function autoColorCurves(img: Pixels, mask: ArrayLike<number> | null = null, clip = AUTO_CLIP): CurvesValue | null {
  const d = img.data;
  const n = img.width * img.height;
  const h = computeHistogram(img, { mask });
  if (h.count < 4) return null;
  // Luma thresholds: average a slightly larger tail than the clip for a stable color estimate.
  const tail = Math.max(clip, 0.005);
  const [lumLo, lumHi] = clipRange(h.lum, tail);
  if (lumHi - lumLo < 8) return null;
  const dark = [0, 0, 0];
  const light = [0, 0, 0];
  let nd = 0;
  let nl = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (d[i + 3] === 0 || (mask && !(mask[p] > 0))) continue;
    const l = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    if (l <= lumLo) {
      dark[0] += d[i];
      dark[1] += d[i + 1];
      dark[2] += d[i + 2];
      nd++;
    } else if (l >= lumHi) {
      light[0] += d[i];
      light[1] += d[i + 1];
      light[2] += d[i + 2];
      nl++;
    }
  }
  if (!nd || !nl) return null;
  const lo = dark.map((v) => v / nd);
  const hi = light.map((v) => v / nl);
  // Per channel: never stretch more than the channel's own clipped range allows.
  const chans = [h.r, h.g, h.b];
  for (let c = 0; c < 3; c++) {
    const [clo, chi] = clipRange(chans[c], clip);
    lo[c] = Math.max(clo, Math.min(lo[c], chi - 16));
    hi[c] = Math.min(chi, Math.max(hi[c], lo[c] + 16));
    if (hi[c] - lo[c] < 16) {
      lo[c] = 0;
      hi[c] = 255;
    }
  }
  // Snap neutral midtones: average near-neutral mid pixels after the stretch.
  const mid = [0, 0, 0];
  let nm = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (d[i + 3] === 0 || (mask && !(mask[p] > 0))) continue;
    const s0 = ((d[i] - lo[0]) / (hi[0] - lo[0])) * 255;
    const s1 = ((d[i + 1] - lo[1]) / (hi[1] - lo[1])) * 255;
    const s2 = ((d[i + 2] - lo[2]) / (hi[2] - lo[2])) * 255;
    const l = 0.299 * s0 + 0.587 * s1 + 0.114 * s2;
    if (l < 60 || l > 196) continue;
    if (Math.max(s0, s1, s2) - Math.min(s0, s1, s2) > 36) continue;
    mid[0] += s0;
    mid[1] += s1;
    mid[2] += s2;
    nm++;
  }
  const curves: CurvesValue = { rgb: IDENT, r: IDENT, g: IDENT, b: IDENT };
  const keys = ['r', 'g', 'b'] as const;
  const useMid = nm >= Math.max(16, h.count * 0.005);
  const m = useMid ? mid.map((v) => v / nm) : null;
  const target = m ? (m[0] + m[1] + m[2]) / 3 : 0;
  for (let c = 0; c < 3; c++) {
    const a = Math.round(lo[c]);
    const b = Math.round(hi[c]);
    const pts: CurvePoints = a <= 0 && b >= 255 ? [[0, 0]] : [[a, 0]];
    if (m && Math.abs(m[c] - target) > 1.5) {
      const corr = Math.max(-40, Math.min(40, target - m[c]));
      const x = Math.round(a + (m[c] / 255) * (b - a));
      const y = Math.round(Math.max(8, Math.min(247, m[c] + corr)));
      if (x > a + 4 && x < b - 4) pts.push([x, y]);
    }
    pts.push(a <= 0 && b >= 255 ? [255, 255] : [b, 255]);
    curves[keys[c]] = pts;
  }
  return isIdentityCurves(curves) ? null : curves;
}
