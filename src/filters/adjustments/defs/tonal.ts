/** Tonal adjustments: Brightness/Contrast, Levels, Curves, Exposure, Invert, Posterize, Threshold. */
import { Aperture, ChartColumn, ChartSpline, Contrast, Layers3, SquareSplitHorizontal, SunMedium } from 'lucide-react';
import type { CurvesValue, ParamValues } from '../../../core/types';
import type { FilterDef } from '../../../registry';
import { curveLUT, IDENTITY_CURVES } from '../../../ui/controls/curves';
import {
  applyLuts,
  buildLut,
  composeLut,
  identityLut,
  isIdentityLut,
  levelsLut,
  linearToSrgb,
  luma,
  sCurve,
  srgbToLinear,
  type Lut,
  type Pixels,
} from '../math';
import { bool, boolP, curvesP, isCurves, num, numP } from '../params';

/* ================================================================== */
/* Brightness / Contrast                                               */
/* ================================================================== */

/**
 * Photoshop-like Brightness/Contrast.
 *  - Modern mode: brightness is a non-clipping midtone (gamma) shift; contrast is an
 *    endpoint-preserving S-curve (positive) or a linear compression toward mid-gray (negative).
 *  - Legacy mode: linear offset + linear contrast around 50% (clips, punchy).
 */
export function brightnessContrastLut(brightness: number, contrast: number, legacy = false): Lut {
  const b = Math.max(-150, Math.min(150, brightness));
  const c = Math.max(-100, Math.min(100, contrast)) / 100;
  if (b === 0 && c === 0) return identityLut();
  if (legacy) {
    const factor = c >= 0 ? (c >= 0.999 ? 1000 : 1 / (1 - c)) : 1 + c;
    return buildLut((v) => (v + b / 255 - 0.5) * factor + 0.5);
  }
  const midOut = 0.5 + b / 600; // ±150 → 0.25 … 0.75
  const g = Math.log(midOut) / Math.log(0.5);
  const k = 1 + c * 1.6;
  return buildLut((v) => {
    let x = b !== 0 ? Math.pow(v, g) : v;
    if (c > 0) x = sCurve(x, k);
    else if (c < 0) x = 0.5 + (x - 0.5) * (1 + c * 0.55);
    return x;
  });
}

export const brightnessContrast: FilterDef = {
  id: 'brightness-contrast',
  name: 'Brightness/Contrast',
  category: 'Adjustments',
  description: 'Brighten/darken midtones and add or reduce contrast without clipping (Legacy = linear, punchy).',
  keywords: ['brightness', 'contrast', 'lighten', 'darken'],
  icon: SunMedium,
  adjustment: true,
  params: [
    numP('brightness', 'Brightness', -150, 150, 0),
    numP('contrast', 'Contrast', -100, 100, 0),
    boolP('legacy', 'Use Legacy', false, { hint: 'Linear brightness/contrast (clips highlights and shadows), like old Photoshop' }),
  ],
  apply(img, p) {
    const lut = brightnessContrastLut(num(p, 'brightness', 0), num(p, 'contrast', 0), bool(p, 'legacy', false));
    if (!isIdentityLut(lut)) applyLuts(img, lut);
    return img;
  },
};

/* ================================================================== */
/* Levels                                                              */
/* ================================================================== */

export function levelsParams(p: ParamValues) {
  const inBlack = num(p, 'inBlack', 0, 0, 253);
  const inWhite = Math.max(inBlack + 2, num(p, 'inWhite', 255, 2, 255));
  return {
    inBlack,
    inWhite,
    gamma: num(p, 'gamma', 1, 0.1, 9.99),
    outBlack: num(p, 'outBlack', 0, 0, 255),
    outWhite: num(p, 'outWhite', 255, 0, 255),
  };
}

export function levelsLutFromParams(p: ParamValues): Lut {
  const l = levelsParams(p);
  return levelsLut(l.inBlack, l.inWhite, l.gamma, l.outBlack, l.outWhite);
}

export const levels: FilterDef = {
  id: 'levels',
  name: 'Levels',
  category: 'Adjustments',
  description: 'Set the black point, white point and midtone gamma; remap the output range.',
  keywords: ['levels', 'black point', 'white point', 'gamma', 'tonal range'],
  icon: ChartColumn,
  adjustment: true,
  params: [
    numP('inBlack', 'Input Black', 0, 253, 0, { group: 'Input Levels' }),
    numP('gamma', 'Midtones', 0.1, 9.99, 1, { step: 0.01, group: 'Input Levels', hint: 'Gamma: >1 brightens midtones, <1 darkens' }),
    numP('inWhite', 'Input White', 2, 255, 255, { group: 'Input Levels' }),
    numP('outBlack', 'Output Black', 0, 255, 0, { group: 'Output Levels' }),
    numP('outWhite', 'Output White', 0, 255, 255, { group: 'Output Levels' }),
  ],
  apply(img, p) {
    const lut = levelsLutFromParams(p);
    if (!isIdentityLut(lut)) applyLuts(img, lut);
    return img;
  },
};

/* ================================================================== */
/* Curves                                                              */
/* ================================================================== */

/** Per-channel LUTs for a CurvesValue (channel curve first, then the composite RGB curve). */
export function curvesLuts(value: unknown): { r: Lut; g: Lut; b: Lut } {
  const c: CurvesValue = isCurves(value) ? value : IDENTITY_CURVES;
  const safe = (pts: CurvesValue['rgb']) =>
    curveLUT(pts.filter((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])));
  const master = safe(c.rgb);
  return { r: composeLut(safe(c.r), master), g: composeLut(safe(c.g), master), b: composeLut(safe(c.b), master) };
}

export const curves: FilterDef = {
  id: 'curves',
  name: 'Curves',
  category: 'Adjustments',
  description: 'Precise tonal control with a composite curve and per-channel RGB curves.',
  keywords: ['curves', 's-curve', 'contrast', 'tone curve', 'rgb'],
  icon: ChartSpline,
  adjustment: true,
  params: [curvesP('curves', 'Curves', IDENTITY_CURVES)],
  apply(img, p) {
    const { r, g, b } = curvesLuts(p.curves);
    if (isIdentityLut(r) && isIdentityLut(g) && isIdentityLut(b)) return img;
    applyLuts(img, r, g, b);
    return img;
  },
};

/* ================================================================== */
/* Exposure                                                            */
/* ================================================================== */

/** Exposure in linear light: lin·2^exposure + offset, then a gamma power, back to sRGB. */
export function exposureLut(exposure: number, offset: number, gamma: number): Lut {
  if (exposure === 0 && offset === 0 && gamma === 1) return identityLut();
  const mul = Math.pow(2, exposure);
  const invG = 1 / Math.max(0.01, gamma);
  return buildLut((v) => {
    let lin = srgbToLinear(v) * mul + offset;
    lin = lin <= 0 ? 0 : Math.pow(lin, invG);
    return linearToSrgb(Math.min(1, lin));
  });
}

export const exposure: FilterDef = {
  id: 'exposure',
  name: 'Exposure',
  category: 'Adjustments',
  description: 'Photographic exposure in linear light (stops), shadow offset and gamma correction.',
  keywords: ['exposure', 'stops', 'offset', 'gamma'],
  icon: Aperture,
  adjustment: true,
  params: [
    numP('exposure', 'Exposure', -5, 5, 0, { step: 0.01 }),
    numP('offset', 'Offset', -0.5, 0.5, 0, { step: 0.001 }),
    numP('gamma', 'Gamma Correction', 0.01, 9.99, 1, { step: 0.01 }),
  ],
  apply(img, p) {
    const lut = exposureLut(num(p, 'exposure', 0, -5, 5), num(p, 'offset', 0, -0.5, 0.5), num(p, 'gamma', 1, 0.01, 9.99));
    if (!isIdentityLut(lut)) applyLuts(img, lut);
    return img;
  },
};

/* ================================================================== */
/* Invert / Posterize / Threshold                                      */
/* ================================================================== */

export function invertPixels(img: Pixels): Pixels {
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  return img;
}

export const invert: FilterDef = {
  id: 'invert',
  name: 'Invert',
  category: 'Adjustments',
  description: 'Invert every color channel (negative).',
  keywords: ['invert', 'negative'],
  icon: Contrast,
  adjustment: true,
  params: [],
  apply(img) {
    invertPixels(img);
    return img;
  },
};

/** Equal-width bins mapped to evenly spaced output levels (Photoshop Posterize). */
export function posterizeLut(levelsCount: number): Lut {
  const n = Math.max(2, Math.min(255, Math.round(levelsCount)));
  const l = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const bin = Math.min(n - 1, Math.floor((i * n) / 256));
    l[i] = Math.round((bin * 255) / (n - 1));
  }
  return l;
}

export const posterize: FilterDef = {
  id: 'posterize',
  name: 'Posterize',
  category: 'Adjustments',
  description: 'Reduce each channel to a number of flat tonal levels (cel-shaded / screen-print look).',
  keywords: ['posterize', 'levels', 'cel', 'flat', 'toon'],
  icon: Layers3,
  adjustment: true,
  params: [numP('levels', 'Levels', 2, 32, 4, { step: 1 })],
  apply(img, p) {
    applyLuts(img, posterizeLut(num(p, 'levels', 4, 2, 32)));
    return img;
  },
};

export function thresholdPixels(img: Pixels, level: number): Pixels {
  const t = Math.max(1, Math.min(255, level));
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const v = Math.round(luma(d[i], d[i + 1], d[i + 2])) >= t ? 255 : 0;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  return img;
}

export const threshold: FilterDef = {
  id: 'threshold',
  name: 'Threshold',
  category: 'Adjustments',
  description: 'Pure black & white: pixels brighter than the level become white, the rest black.',
  keywords: ['threshold', 'black and white', 'stencil', 'ink'],
  icon: SquareSplitHorizontal,
  adjustment: true,
  params: [numP('level', 'Threshold Level', 1, 255, 128, { step: 1 })],
  apply(img, p) {
    thresholdPixels(img, num(p, 'level', 128, 1, 255));
    return img;
  },
};

export const TONAL_DEFS: FilterDef[] = [brightnessContrast, levels, curves, exposure, invert, posterize, threshold];
