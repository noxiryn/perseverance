/**
 * Backdrop-aware placement for light-only assets: Screen-type layers (sunburst rays, light rays,
 * glows…) add light, so on a white or very light canvas they are invisible. When such an asset
 * is placed over a light backdrop with its default color, it is placed in Multiply with a dark
 * shade of that color instead (dark rays on a light poster, like the sunburst reference).
 */
import type { BlendMode, ParamValues } from '../../core/types';
import type { AssetDef } from '../../registry';
import { hslToRgb, parseColor, rgbToHsl, toHex } from '../../core/color';

/** Blend modes that can only lighten what is below. */
export const LIGHT_ONLY_BLENDS: ReadonlySet<BlendMode> = new Set<BlendMode>(['screen', 'lighten', 'color-dodge', 'linear-dodge']);

/** Mean backdrop luminance (0..1) above which light-only layers are considered invisible. */
export const LIGHT_BACKDROP = 0.72;

/** A dark shade of `color` with the same hue (for multiply-blended rays on light backgrounds). */
export function darkShade(color: string): string {
  const c = parseColor(color);
  const [h, s] = rgbToHsl(c.r, c.g, c.b);
  const [r, g, b] = hslToRgb(h, Math.min(s, 0.75), 0.2);
  return toHex({ r, g, b });
}

export interface BackdropAdaptation {
  params: ParamValues;
  blendMode: BlendMode;
  /** True when the placement was changed. */
  changed: boolean;
  /** The asset would stay invisible but has no color to adapt (the caller may hint). */
  invisible: boolean;
}

/**
 * Decide how to place an asset over a backdrop of mean luminance `luminance` (0..1). Pure.
 * Only assets that use their default color are recolored — a color the user picked is kept.
 */
export function adaptToBackdrop(def: Pick<AssetDef, 'params'>, params: ParamValues, blendMode: BlendMode, luminance: number | null): BackdropAdaptation {
  const same: BackdropAdaptation = { params, blendMode, changed: false, invisible: false };
  if (luminance === null || luminance < LIGHT_BACKDROP || !LIGHT_ONLY_BLENDS.has(blendMode)) return same;
  const colorDef = def.params.find((p) => p.key === 'color' && p.type === 'color');
  const current = params.color ?? colorDef?.default;
  if (!colorDef || typeof current !== 'string' || current.toLowerCase() !== String(colorDef.default).toLowerCase()) return { ...same, invisible: true };
  return { params: { ...params, color: darkShade(current) }, blendMode: 'multiply', changed: true, invisible: false };
}

/** Mean luminance (0..1) of an RGBA buffer region, alpha-weighted over `fallback` for transparency. */
export function meanLuminance(data: Uint8ClampedArray, fallback = 1): number {
  let sum = 0,
    n = 0;
  for (let q = 0; q < data.length; q += 4) {
    const a = data[q + 3] / 255;
    const l = (0.2126 * data[q] + 0.7152 * data[q + 1] + 0.0722 * data[q + 2]) / 255;
    sum += l * a + fallback * (1 - a);
    n++;
  }
  return n ? sum / n : fallback;
}
