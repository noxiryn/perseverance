/**
 * Small CSS previews for color-based adjustment presets (shown next to preset names in the
 * Adjustments panel): gradient strips for Gradient Map / Duotone / Split Toning, a solid chip
 * for tints and filters, the colorize hue for Hue/Saturation and a sampled palette for Color
 * Lookup looks. Pure (returns CSS strings) so it is unit-testable without a DOM.
 */
import type { ParamValues } from '../../core/types';
import { LUT_SIZE, isKnownLook, lookCube } from './looks';
import { colorizeSaturation } from './defs/color';
import { apply3DLut, clamp01, hslToRgbInto } from './math';
import { bool, isGradient, num, str } from './params';

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(255, v)))
    .toString(16)
    .padStart(2, '0');
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** Representative colors (shadow, skin, red, foliage, sky, highlight) to show how a look grades. */
const LOOK_SAMPLES: [number, number, number][] = [
  [24, 24, 28],
  [92, 70, 60],
  [214, 160, 128],
  [196, 32, 40],
  [70, 130, 60],
  [80, 140, 210],
  [235, 232, 225],
];

const lookCache = new Map<string, string>();

/** Hard-stop strip of the sample colors passed through a Color Lookup look. */
export function lookPaletteCss(preset: string, intensity = 1): string | null {
  if (!isKnownLook(preset)) return null;
  const key = `${preset}|${intensity.toFixed(2)}`;
  const hit = lookCache.get(key);
  if (hit) return hit;
  const data = new Uint8ClampedArray(LOOK_SAMPLES.length * 4);
  LOOK_SAMPLES.forEach(([r, g, b], i) => data.set([r, g, b, 255], i * 4));
  apply3DLut({ data, width: LOOK_SAMPLES.length, height: 1 }, lookCube(preset), LUT_SIZE, clamp01(intensity));
  const n = LOOK_SAMPLES.length;
  const stops: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = rgbHex(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    stops.push(`${c} ${((i / n) * 100).toFixed(1)}%`, `${c} ${(((i + 1) / n) * 100).toFixed(1)}%`);
  }
  const css = `linear-gradient(90deg, ${stops.join(', ')})`;
  lookCache.set(key, css);
  return css;
}

/** CSS background for a preset of `filterId`, or null when the preset has no meaningful color. */
export function presetSwatchCss(filterId: string, params: ParamValues): string | null {
  switch (filterId) {
    case 'gradient-map': {
      const g = params.gradient;
      if (!isGradient(g)) return null;
      const reverse = bool(params, 'reverse', false) !== !!g.reverse;
      const stops = [...g.stops]
        .map((s) => ({ offset: reverse ? 1 - s.offset : s.offset, color: s.color }))
        .sort((a, b) => a.offset - b.offset)
        .map((s) => `${s.color} ${(clamp01(s.offset) * 100).toFixed(1)}%`);
      return stops.length === 1 ? stops[0].split(' ')[0] : `linear-gradient(90deg, ${stops.join(', ')})`;
    }
    case 'duotone':
      return `linear-gradient(90deg, ${str(params, 'shadow', '#1a1a1a')}, ${str(params, 'highlight', '#f2f2f2')})`;
    case 'split-toning':
      return `linear-gradient(90deg, ${str(params, 'shadowColor', '#1d6f8a')}, #808080, ${str(params, 'highlightColor', '#f2a03d')})`;
    case 'solid-tint':
      return str(params, 'color', '#c4141c');
    case 'photo-filter':
      return str(params, 'color', '#ec8a00');
    case 'black-white':
      return bool(params, 'tint', false) ? `linear-gradient(90deg, #111111, ${str(params, 'tintColor', '#e1c58f')}, #f4f4f4)` : null;
    case 'hue-saturation': {
      if (!bool(params, 'colorize', false)) return null;
      const out = new Float64Array(3);
      const h = (num(params, 'hue', 0) + 360) % 360;
      const s = colorizeSaturation(num(params, 'saturation', 0, -100, 100));
      const stops = [0.15, 0.5, 0.85].map((l) => {
        hslToRgbInto(h, s, l, out);
        return rgbHex(out[0], out[1], out[2]);
      });
      return `linear-gradient(90deg, ${stops.join(', ')})`;
    }
    case 'color-lookup':
      return lookPaletteCss(str(params, 'preset', 'teal-orange'), num(params, 'intensity', 1, 0, 1));
    default:
      return null;
  }
}
