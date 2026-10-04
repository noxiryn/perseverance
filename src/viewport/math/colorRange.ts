/**
 * Color Range selection weights (pure, typed arrays). Sampled colors with positive/negative
 * samples, plus preset ranges (hue families and tonal ranges) like Photoshop's Select ▸ Color Range.
 */
import { colorRangeAlpha } from './mask';

export type ColorRangePreset =
  | 'sampled'
  | 'reds'
  | 'yellows'
  | 'greens'
  | 'cyans'
  | 'blues'
  | 'magentas'
  | 'highlights'
  | 'midtones'
  | 'shadows'
  | 'skin';

export interface ColorRangeParams {
  preset: ColorRangePreset;
  samples: { r: number; g: number; b: number }[];
  negatives: { r: number; g: number; b: number }[];
  /** 0..200 (sampled colors / hue softness). */
  fuzziness: number;
  invert: boolean;
}

const HUE_CENTER: Partial<Record<ColorRangePreset, number>> = {
  reds: 0,
  yellows: 60,
  greens: 120,
  cyans: 180,
  blues: 240,
  magentas: 300,
};

function hueSatLum(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 510;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / 255;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

/** Selection strength 0..255 per pixel. `rgba` is RGBA bytes of `count` pixels. */
export function colorRangeWeights(rgba: ArrayLike<number>, count: number, p: ColorRangeParams): Uint8ClampedArray {
  let out: Uint8ClampedArray;
  if (p.preset === 'sampled') {
    out = p.samples.length ? colorRangeAlpha(rgba, count, p.samples, p.fuzziness, false) : new Uint8ClampedArray(count);
    if (p.negatives.length) {
      const neg = colorRangeAlpha(rgba, count, p.negatives, p.fuzziness, false);
      for (let i = 0; i < count; i++) out[i] = Math.round((out[i] * (255 - neg[i])) / 255);
    }
  } else {
    out = new Uint8ClampedArray(count);
    const center = HUE_CENTER[p.preset];
    for (let i = 0, j = 0; i < count; i++, j += 4) {
      const r = rgba[j],
        g = rgba[j + 1],
        b = rgba[j + 2],
        a = rgba[j + 3] / 255;
      let w = 0;
      if (center !== undefined) {
        const [h, s] = hueSatLum(r, g, b);
        let dh = Math.abs(h - center);
        if (dh > 180) dh = 360 - dh;
        // full within ±15°, fading to 0 at ±45°; weighted by saturation
        const hw = dh <= 15 ? 1 : dh >= 45 ? 0 : 1 - (dh - 15) / 30;
        w = hw * Math.min(1, s * 2.5);
      } else if (p.preset === 'skin') {
        const [h, s, l] = hueSatLum(r, g, b);
        const dh = Math.abs(h - 25);
        const hw = dh <= 12 ? 1 : dh >= 35 ? 0 : 1 - (dh - 12) / 23;
        const sw = s < 0.1 ? s / 0.1 : s > 0.75 ? Math.max(0, 1 - (s - 0.75) / 0.25) : 1;
        const lw = l < 0.15 ? l / 0.15 : l > 0.92 ? Math.max(0, 1 - (l - 0.92) / 0.08) : 1;
        w = hw * sw * lw;
      } else {
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        if (p.preset === 'highlights') w = lum >= 0.75 ? 1 : lum <= 0.55 ? 0 : (lum - 0.55) / 0.2;
        else if (p.preset === 'shadows') w = lum <= 0.25 ? 1 : lum >= 0.45 ? 0 : 1 - (lum - 0.25) / 0.2;
        else {
          const d = Math.abs(lum - 0.5);
          w = d <= 0.15 ? 1 : d >= 0.3 ? 0 : 1 - (d - 0.15) / 0.15;
        }
      }
      out[i] = Math.round(w * a * 255);
    }
  }
  if (p.invert) for (let i = 0; i < count; i++) out[i] = 255 - out[i];
  return out;
}
