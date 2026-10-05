/**
 * Backdrop-aware placement for light-only overlays: Screen-type layers (sunburst rays, light rays,
 * sparks…) add light, so on a white or very light canvas they are invisible. Assets that declare a
 * light-backdrop variant (`AssetMeta.onLight`) are placed in Multiply with a dark shade of their
 * color instead (dark rays on a light poster, like the sunburst reference); the variant may also
 * switch off parts that only make sense on dark (e.g. Film Scratches' opaque black film base).
 * Other light-only assets (glows, flares, an asset with a color the user picked) are placed as
 * asked and the caller shows a hint.
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

/** How a light-only overlay is re-placed over a light backdrop (declared per asset). */
export interface LightBackdropVariant {
  /** Color param darkened for the Multiply version (default 'color'). */
  colorKey?: string;
  /** Param overrides for the dark-on-light version (e.g. `{ background: false }`). */
  params?: ParamValues;
  /** Short note for the toast, e.g. 'without the black film base'. */
  note?: string;
}

export interface BackdropAdaptation {
  params: ParamValues;
  blendMode: BlendMode;
  /** True when the placement was changed. */
  changed: boolean;
  /** The asset would stay invisible and is not adapted (the caller may hint). */
  invisible: boolean;
  /** The variant's note (when changed). */
  note?: string;
}

/**
 * Decide how to place an asset over a backdrop of mean luminance `luminance` (0..1). Pure.
 * Only assets with a light-backdrop `variant` are adapted, and only while they use their default
 * color (and default values for the params the variant overrides) — choices the user made are kept.
 */
export function adaptToBackdrop(
  def: Pick<AssetDef, 'params'>,
  params: ParamValues,
  blendMode: BlendMode,
  luminance: number | null,
  variant?: LightBackdropVariant | null,
): BackdropAdaptation {
  const same: BackdropAdaptation = { params, blendMode, changed: false, invisible: false };
  if (luminance === null || luminance < LIGHT_BACKDROP || !LIGHT_ONLY_BLENDS.has(blendMode)) return same;
  if (!variant) return { ...same, invisible: true };
  const colorKey = variant.colorKey ?? 'color';
  const colorDef = def.params.find((p) => p.key === colorKey && p.type === 'color');
  const current = params[colorKey] ?? colorDef?.default;
  if (!colorDef || typeof current !== 'string' || current.toLowerCase() !== String(colorDef.default).toLowerCase()) return { ...same, invisible: true };
  for (const key of Object.keys(variant.params ?? {})) {
    const pd = def.params.find((p) => p.key === key);
    if (pd && key in params && params[key] !== pd.default && params[key] !== variant.params?.[key]) return { ...same, invisible: true };
  }
  return { params: { ...params, ...variant.params, [colorKey]: darkShade(current) }, blendMode: 'multiply', changed: true, invisible: false, note: variant.note };
}

/**
 * Coverage above which a Multiply-adapted layer would darken most of the canvas instead of adding
 * dark detail (an opaque base, full-canvas fog…): such a placement is reverted.
 */
export const MAX_ADAPTED_COVERAGE = 0.45;

/** Mean alpha (0..1) of an RGBA buffer. */
export function meanAlpha(data: Uint8ClampedArray): number {
  let sum = 0;
  for (let q = 3; q < data.length; q += 4) sum += data[q];
  const n = data.length >> 2;
  return n ? sum / (n * 255) : 0;
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
