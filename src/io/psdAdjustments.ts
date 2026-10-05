/**
 * Adjustment layers ↔ Photoshop adjustment layers (ag-psd `AdjustmentLayer`). Pure — unit-tested.
 *
 * Native both ways: Brightness/Contrast, Levels, Curves, Exposure, Vibrance, Hue/Saturation
 * (incl. Colorize), Color Balance, Black & White, Photo Filter, Channel Mixer, Gradient Map,
 * Selective Color, Invert, Posterize, Threshold. Everything else (Duotone, Split Toning, Color
 * Lookup, Solid Tint, Vignette and other stylize adjustments, gradient maps with transparent
 * stops) returns null: the exporter bakes those into a pixel layer instead.
 *
 * Units: Photoshop stores the same percentages we use for color balance (−100..100), black & white
 * weights (−200..300 %), channel mixer (−200..200 %) and selective color (−100..100 %); photo
 * filter density is 0..1 in ag-psd (×100 on disk). Hue/Saturation's colorize flag and colorize
 * values are the first fields of the record, which ag-psd exposes as `master.a` (flag in the high
 * byte) and `master.b/c/d` (hue 0..360, saturation 0..100, lightness −100..100).
 */
import type { AdjustmentLayer as PsdAdjustment, ChannelMixerChannel, CMYK, SelectiveColorAdjustment } from 'ag-psd';
import type { CurvePoints, CurvesValue, Gradient, ParamValues } from '../core/types';
import { parseColor } from '../core/color';
import { fromPsdColor, fromPsdGradient, toPsdColor, toPsdGradient } from './psdEffects';

const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r = (v: unknown, d: number) => Math.round(n(v, d));
const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const s = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const IDENTITY: CurvePoints = [
  [0, 0],
  [255, 255],
];

export const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;
const BW_KEYS = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
const BW_DEFAULTS: Record<(typeof BW_KEYS)[number], number> = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 };

const DEFAULT_MAP: Gradient = {
  kind: 'linear',
  angle: 0,
  scale: 1,
  stops: [
    { offset: 0, color: '#000000' },
    { offset: 1, color: '#ffffff' },
  ],
};

/* ---------------- colorize saturation (our slider ⇄ Photoshop's 0..100) ---------------- */

/** Our Colorize saturation slider (−100..100, 0 = Photoshop's default 25 %) → Photoshop percent. */
export function colorizeSatToPsd(sat: number): number {
  const v = clamp(sat, -100, 100) / 100;
  return (v >= 0 ? 0.25 + v * 0.75 : 0.25 * (1 + v)) * 100;
}

/** Photoshop colorize saturation (0..100) → our slider. */
export function colorizeSatFromPsd(pct: number): number {
  const v = clamp(pct, 0, 100) / 100;
  return v >= 0.25 ? ((v - 0.25) / 0.75) * 100 : (v / 0.25 - 1) * 100;
}

/** Any hue in degrees → −180..180 (our Hue slider). */
function hueSigned(h: number): number {
  const x = ((h % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
}

const isGradient = (v: unknown): v is Gradient => !!v && typeof v === 'object' && Array.isArray((v as Gradient).stops) && (v as Gradient).stops.length > 0;

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/**
 * Native Photoshop adjustment for one of our adjustment filters, or null when Photoshop has no
 * equivalent. `p` must already be merged with the filter's defaults (resolveParams).
 */
export function toPsdAdjustment(filterId: string, p: ParamValues): PsdAdjustment | null {
  switch (filterId) {
    case 'brightness-contrast':
      return { type: 'brightness/contrast', brightness: r(p.brightness, 0), contrast: r(p.contrast, 0), useLegacy: false };
    case 'levels':
      return {
        type: 'levels',
        rgb: {
          shadowInput: r(p.inBlack, 0),
          highlightInput: r(p.inWhite, 255),
          shadowOutput: r(p.outBlack, 0),
          highlightOutput: r(p.outWhite, 255),
          midtoneInput: n(p.gamma, 1),
        },
      };
    case 'curves': {
      const c = (p.curves as CurvesValue | undefined) ?? { rgb: IDENTITY, r: IDENTITY, g: IDENTITY, b: IDENTITY };
      const ch = (pts: CurvePoints | undefined) => (pts?.length ? pts : IDENTITY).map(([x, y]) => ({ input: Math.round(x), output: Math.round(y) }));
      return { type: 'curves', rgb: ch(c.rgb), red: ch(c.r), green: ch(c.g), blue: ch(c.b) };
    }
    case 'exposure':
      return { type: 'exposure', exposure: n(p.exposure, 0), offset: n(p.offset, 0), gamma: n(p.gamma, 1) };
    case 'vibrance':
      return { type: 'vibrance', vibrance: r(p.vibrance, 0), saturation: r(p.saturation, 0) };
    case 'hue-saturation': {
      if (b(p.colorize, false)) {
        const hue = n(p.hue, 0);
        return {
          type: 'hue/saturation',
          master: {
            a: 1 << 8, // colorize flag (first byte of the record)
            b: Math.round(((hue % 360) + 360) % 360),
            c: Math.round(colorizeSatToPsd(n(p.saturation, 0))),
            d: r(p.lightness, 0),
            hue: 0,
            saturation: 0,
            lightness: 0,
          },
        };
      }
      return { type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, hue: r(p.hue, 0), saturation: r(p.saturation, 0), lightness: r(p.lightness, 0) } };
    }
    case 'color-balance': {
      const range = (prefix: string) => ({ cyanRed: r(p[`${prefix}R`], 0), magentaGreen: r(p[`${prefix}G`], 0), yellowBlue: r(p[`${prefix}B`], 0) });
      return {
        type: 'color balance',
        shadows: range('shadows'),
        midtones: range('mid'),
        highlights: range('high'),
        preserveLuminosity: b(p.preserveLuminosity, true),
      };
    }
    case 'black-white':
      return {
        type: 'black & white',
        reds: r(p.reds, BW_DEFAULTS.reds),
        yellows: r(p.yellows, BW_DEFAULTS.yellows),
        greens: r(p.greens, BW_DEFAULTS.greens),
        cyans: r(p.cyans, BW_DEFAULTS.cyans),
        blues: r(p.blues, BW_DEFAULTS.blues),
        magentas: r(p.magentas, BW_DEFAULTS.magentas),
        useTint: b(p.tint, false),
        tintColor: toPsdColor(p.tintColor, '#e1c58f'),
      };
    case 'photo-filter':
      return { type: 'photo filter', color: toPsdColor(p.color, '#ec8a00'), density: clamp(n(p.density, 0.25), 0, 1), preserveLuminosity: b(p.preserveLuminosity, true) };
    case 'channel-mixer': {
      const ch = (rk: string, gk: string, bk: string, dr: number, dg: number, db: number): ChannelMixerChannel => ({
        red: r(p[rk], dr),
        green: r(p[gk], dg),
        blue: r(p[bk], db),
        constant: 0,
      });
      const red = ch('rr', 'rg', 'rb', 100, 0, 0);
      return {
        type: 'channel mixer',
        monochrome: b(p.monochrome, false),
        red,
        green: ch('gr', 'gg', 'gb', 0, 100, 0),
        blue: ch('br', 'bg', 'bb', 0, 0, 100),
        // Monochrome mixes gray from the red-output keys (same as our filter).
        gray: { ...red },
      };
    }
    case 'gradient-map': {
      const g = isGradient(p.gradient) ? p.gradient : DEFAULT_MAP;
      // Photoshop's gradient map has no "blend with the original" for transparent stops.
      if (g.stops.some((st) => parseColor(st.color).a < 0.999)) return null;
      const pg = toPsdGradient(g);
      return {
        type: 'gradient map',
        gradientType: 'solid',
        name: 'Custom',
        // ag-psd scales stop locations by the smoothness field, so it must stay 1 (100 %).
        // Photoshop then eases between stops slightly; the stop colors themselves are exact.
        smoothness: 1,
        colorStops: pg.colorStops,
        opacityStops: pg.opacityStops,
        reverse: b(p.reverse, false) !== !!g.reverse,
        dither: b(p.dither, false),
      };
    }
    case 'selective-color': {
      const out: SelectiveColorAdjustment = { type: 'selective color', mode: s(p.method, 'relative') === 'absolute' ? 'absolute' : 'relative' };
      for (const range of SELECTIVE_RANGES) {
        const cmyk: CMYK = { c: r(p[`${range}C`], 0), m: r(p[`${range}M`], 0), y: r(p[`${range}Y`], 0), k: r(p[`${range}K`], 0) };
        out[range] = cmyk;
      }
      return out;
    }
    case 'invert':
      return { type: 'invert' };
    case 'posterize':
      return { type: 'posterize', levels: r(p.levels, 4) };
    case 'threshold':
      return { type: 'threshold', level: r(p.level, 128) };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export interface ImportedAdjustment {
  filterId: string;
  params: ParamValues;
  name: string;
}

/** Our adjustment filter + params for a Photoshop adjustment layer, or null when unsupported. */
export function fromPsdAdjustment(a: PsdAdjustment): ImportedAdjustment | null {
  switch (a.type) {
    case 'brightness/contrast':
      return { filterId: 'brightness-contrast', name: 'Brightness/Contrast', params: { brightness: a.brightness ?? 0, contrast: a.contrast ?? 0 } };
    case 'levels': {
      const c = a.rgb;
      return {
        filterId: 'levels',
        name: 'Levels',
        params: c ? { inBlack: c.shadowInput, inWhite: c.highlightInput, outBlack: c.shadowOutput, outWhite: c.highlightOutput, gamma: c.midtoneInput || 1 } : {},
      };
    }
    case 'curves': {
      const ch = (c?: { input: number; output: number }[]): CurvePoints =>
        c && c.length >= 2 ? c.map((pt) => [pt.input, pt.output] as [number, number]).sort((x, y) => x[0] - y[0]) : IDENTITY;
      return { filterId: 'curves', name: 'Curves', params: { curves: { rgb: ch(a.rgb), r: ch(a.red), g: ch(a.green), b: ch(a.blue) } } };
    }
    case 'exposure':
      return { filterId: 'exposure', name: 'Exposure', params: { exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 } };
    case 'vibrance':
      return { filterId: 'vibrance', name: 'Vibrance', params: { vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 } };
    case 'hue/saturation': {
      const m = a.master;
      if (m && (m.a & 0xff00) !== 0) {
        return {
          filterId: 'hue-saturation',
          name: 'Hue/Saturation',
          params: { colorize: true, hue: hueSigned(n(m.b, 0)), saturation: Math.round(colorizeSatFromPsd(n(m.c, 25)) * 100) / 100, lightness: clamp(n(m.d, 0), -100, 100) },
        };
      }
      return { filterId: 'hue-saturation', name: 'Hue/Saturation', params: { hue: m?.hue ?? 0, saturation: m?.saturation ?? 0, lightness: m?.lightness ?? 0, colorize: false } };
    }
    case 'color balance': {
      const params: ParamValues = { preserveLuminosity: a.preserveLuminosity ?? true };
      const put = (prefix: string, v: { cyanRed: number; magentaGreen: number; yellowBlue: number } | undefined) => {
        params[`${prefix}R`] = clamp(n(v?.cyanRed, 0), -100, 100);
        params[`${prefix}G`] = clamp(n(v?.magentaGreen, 0), -100, 100);
        params[`${prefix}B`] = clamp(n(v?.yellowBlue, 0), -100, 100);
      };
      put('shadows', a.shadows);
      put('mid', a.midtones);
      put('high', a.highlights);
      return { filterId: 'color-balance', name: 'Color Balance', params };
    }
    case 'black & white': {
      const params: ParamValues = { tint: !!a.useTint, tintColor: fromPsdColor(a.tintColor, '#e1c58f') };
      for (const k of BW_KEYS) params[k] = clamp(n(a[k], BW_DEFAULTS[k]), -200, 300);
      return { filterId: 'black-white', name: 'Black & White', params };
    }
    case 'photo filter':
      return {
        filterId: 'photo-filter',
        name: 'Photo Filter',
        params: { color: fromPsdColor(a.color, '#ec8a00'), density: clamp(n(a.density, 0.25), 0, 1), preserveLuminosity: a.preserveLuminosity ?? true },
      };
    case 'channel mixer': {
      const mono = !!a.monochrome;
      const red = mono ? a.gray : a.red;
      const v = (c: ChannelMixerChannel | undefined, k: keyof ChannelMixerChannel, d: number) => clamp(n(c?.[k], d), -200, 200);
      return {
        filterId: 'channel-mixer',
        name: 'Channel Mixer',
        params: {
          monochrome: mono,
          rr: v(red, 'red', mono ? 40 : 100),
          rg: v(red, 'green', mono ? 40 : 0),
          rb: v(red, 'blue', mono ? 20 : 0),
          gr: v(a.green, 'red', 0),
          gg: v(a.green, 'green', 100),
          gb: v(a.green, 'blue', 0),
          br: v(a.blue, 'red', 0),
          bg: v(a.blue, 'green', 0),
          bb: v(a.blue, 'blue', 100),
        },
      };
    }
    case 'gradient map': {
      if (a.gradientType === 'noise' || !a.colorStops?.length) return null;
      const g = fromPsdGradient({ type: 'solid', colorStops: a.colorStops, opacityStops: a.opacityStops }, 'linear', 0, 1, false);
      // Photoshop ignores opacity stops in gradient maps: keep the colors opaque.
      const stops = g.stops.map((st) => ({ ...st, color: st.color.length > 7 ? st.color.slice(0, 7) : st.color }));
      return { filterId: 'gradient-map', name: 'Gradient Map', params: { gradient: { ...g, stops }, reverse: !!a.reverse, dither: !!a.dither } };
    }
    case 'selective color': {
      const params: ParamValues = { method: a.mode === 'absolute' ? 'absolute' : 'relative' };
      for (const range of SELECTIVE_RANGES) {
        const c = a[range];
        params[`${range}C`] = clamp(n(c?.c, 0), -100, 100);
        params[`${range}M`] = clamp(n(c?.m, 0), -100, 100);
        params[`${range}Y`] = clamp(n(c?.y, 0), -100, 100);
        params[`${range}K`] = clamp(n(c?.k, 0), -100, 100);
      }
      return { filterId: 'selective-color', name: 'Selective Color', params };
    }
    case 'invert':
      return { filterId: 'invert', name: 'Invert', params: {} };
    case 'posterize':
      return { filterId: 'posterize', name: 'Posterize', params: { levels: a.levels ?? 4 } };
    case 'threshold':
      return { filterId: 'threshold', name: 'Threshold', params: { level: a.level ?? 128 } };
    default:
      return null;
  }
}
