/**
 * The performance rewrites of the adjustment loops must not change their output: every optimized
 * adjustment is compared against its previous implementation (perf.reference.ts, copied from
 * before the rewrite) on synthetic images covering the whole RGB cube, channel ties, runs of
 * identical pixels and transparency, for many random parameter sets plus the values that produce
 * rounding ties (hue ±30/90/150/180°, saturation ±50, lightness only…). The results must be
 * bit-identical; alpha and fully transparent pixels must be untouched. The per-color memo (results
 * kept between calls with the same parameters) must not change anything either.
 */
import { describe, expect, it } from 'vitest';
import type { FilterContext, FilterDef } from '../../registry';
import type { ParamValues } from '../../core/types';
import { defaultParams } from '../engine';
import { COLOR_DEFS } from './defs/color';
import { MAPPING_DEFS, DEFAULT_MAP_GRADIENT } from './defs/mapping';
import { TONAL_DEFS, brightnessContrastLut, curvesLuts, exposureLut, levelsLutFromParams, posterizeLut } from './defs/tonal';
import { isGradient } from './params';
import * as REF from './perf.reference';

const ALL: FilterDef[] = [...COLOR_DEFS, ...MAPPING_DEFS, ...TONAL_DEFS];
const byId = (id: string) => {
  const d = ALL.find((f) => f.id === id);
  if (!d) throw new Error(`missing ${id}`);
  return d;
};
const ctx: FilterContext = { docWidth: 64, docHeight: 64, offsetX: 0, offsetY: 0, scale: 1, primaryColor: '#000000', secondaryColor: '#ffffff' };

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

/**
 * 256×224: (even seeds) 64 rows of a small repeated palette, then a 32³ sampling of the RGB cube
 * (values 0, 8.2, …, 255), then random colors, channel ties (r = g, g = b, r = b, grays), runs of
 * one color and transparency (alpha 0 pixels sometimes repeat their opaque neighbour's RGB).
 */
function makeImage(seed: number) {
  const w = 256,
    h = 224;
  const R = rng(seed);
  const d = new Uint8ClampedArray(w * h * 4);
  const lv = (k: number) => Math.round((k * 255) / 31);
  // even seeds: a small palette repeated at random first (exercises the color cache), then the cube
  const pal = Array.from({ length: 48 }, () => [(R() * 256) | 0, (R() * 256) | 0, (R() * 256) | 0]);
  const palRows = seed % 2 === 0 ? 64 : 0;
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    if (i < palRows * w) {
      const c = pal[(R() * pal.length) | 0];
      [d[j], d[j + 1], d[j + 2]] = c;
    } else if (i - palRows * w < 32768) {
      const i2 = i - palRows * w;
      d[j] = lv(i2 & 31);
      d[j + 1] = lv((i2 >> 5) & 31);
      d[j + 2] = lv(i2 >> 10);
    } else {
      const k = R();
      const a = (R() * 256) | 0,
        b = (R() * 256) | 0,
        c = (R() * 256) | 0;
      if (k < 0.15) d[j] = d[j + 1] = d[j + 2] = a;
      else if (k < 0.25) [d[j], d[j + 1], d[j + 2]] = [a, a, b];
      else if (k < 0.35) [d[j], d[j + 1], d[j + 2]] = [a, b, b];
      else if (k < 0.45) [d[j], d[j + 1], d[j + 2]] = [a, b, a];
      else if (k < 0.65 && i > 0) [d[j], d[j + 1], d[j + 2]] = [d[j - 4], d[j - 3], d[j - 2]]; // run
      else [d[j], d[j + 1], d[j + 2]] = [a, b, c];
    }
    const t = R();
    d[j + 3] = t < 0.1 ? 0 : t < 0.2 ? (R() * 255) | 0 : 255;
  }
  return { data: d, width: w, height: h };
}

/** Random parameter value inside a numeric param's range (sometimes its ends or 0). */
function randomParams(def: FilterDef, R: () => number): ParamValues {
  const p: ParamValues = { ...defaultParams(def.params) };
  for (const pd of def.params) {
    if (pd.type === 'number') {
      const k = R();
      p[pd.key] = k < 0.1 ? pd.min : k < 0.2 ? pd.max : k < 0.3 ? Math.max(pd.min, Math.min(pd.max, 0)) : pd.min + (pd.max - pd.min) * R();
    } else if (pd.type === 'boolean') p[pd.key] = R() < 0.5;
    else if (pd.type === 'select') p[pd.key] = pd.options[Math.floor(R() * pd.options.length)].value;
    else if (pd.type === 'color') p[pd.key] = '#' + Math.floor(R() * 0xffffff).toString(16).padStart(6, '0');
  }
  return p;
}

const num = (p: ParamValues, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
const bool = (p: ParamValues, k: string, d: boolean) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : d);
const str = (p: ParamValues, k: string, d: string) => (typeof p[k] === 'string' && p[k] ? (p[k] as string) : d);

/** Previous implementation of each adjustment (same parameter handling as the FilterDef). */
const REFS: Record<string, (img: { data: Uint8ClampedArray; width: number; height: number }, p: ParamValues) => void> = {
  'hue-saturation': (img, p) => REF.hueSaturationPixels(img, p),
  vibrance: (img, p) => REF.vibrancePixels(img, num(p, 'vibrance', 0), num(p, 'saturation', 0)),
  'color-balance': (img, p) => REF.colorBalancePixels(img, p),
  'black-white': (img, p) => REF.blackWhitePixels(img, p),
  'photo-filter': (img, p) => REF.photoFilterPixels(img, str(p, 'color', '#ec8a00'), Math.max(0, Math.min(1, num(p, 'density', 0.25))), bool(p, 'preserveLuminosity', true)),
  'channel-mixer': (img, p) => REF.channelMixerPixels(img, p),
  'selective-color': (img, p) => REF.selectiveColorPixels(img, p),
  'gradient-map': (img, p) => REF.gradientMapPixels(img, isGradient(p.gradient) ? p.gradient : DEFAULT_MAP_GRADIENT, bool(p, 'reverse', false), bool(p, 'dither', false)),
  'split-toning': (img, p) => REF.splitToningPixels(img, p),
  duotone: (img, p) => REF.duotonePixels(img, str(p, 'shadow', '#1a1a1a'), str(p, 'highlight', '#f2f2f2'), num(p, 'contrast', 0)),
  'solid-tint': (img, p) => REF.solidTintPixels(img, str(p, 'color', '#c4141c'), str(p, 'mode', 'color'), Math.max(0, Math.min(1, num(p, 'amount', 1)))),
  curves: (img, p) => {
    const l = curvesLuts(p.curves);
    REF.applyLuts(img, l.r, l.g, l.b);
  },
  levels: (img, p) => REF.applyLuts(img, levelsLutFromParams(p)),
  exposure: (img, p) => REF.applyLuts(img, exposureLut(Math.max(-5, Math.min(5, num(p, 'exposure', 0))), Math.max(-0.5, Math.min(0.5, num(p, 'offset', 0))), Math.max(0.01, Math.min(9.99, num(p, 'gamma', 1))))),
  'brightness-contrast': (img, p) => REF.applyLuts(img, brightnessContrastLut(num(p, 'brightness', 0), num(p, 'contrast', 0), bool(p, 'legacy', false))),
  posterize: (img, p) => REF.applyLuts(img, posterizeLut(Math.max(2, Math.min(32, num(p, 'levels', 4))))),
};

/** Parameter sets that produce rounding ties or special paths (on top of the random ones). */
const EXTRA: Record<string, ParamValues[]> = {
  'hue-saturation': [
    { hue: 0, saturation: 50 },
    { hue: 0, saturation: -50 },
    { hue: 30 },
    { hue: -30 },
    { hue: 90 },
    { hue: -90 },
    { hue: 150 },
    { hue: -150 },
    { hue: 180 },
    { hue: -180 },
    { hue: 30, saturation: 50 },
    { hue: 0, saturation: 0, lightness: 35 },
    { hue: 0, saturation: 0, lightness: -50 },
    { hue: 0, saturation: 50, lightness: -20 },
    { hue: 45, saturation: -30, lightness: 10 },
    { hue: 17.3, saturation: 100, lightness: -100 },
    { hue: -60, saturation: -100 },
  ],
  vibrance: [{ vibrance: 50, saturation: 10 }, { vibrance: 100 }, { vibrance: -50 }, { vibrance: 30, saturation: -40 }, { saturation: 60 }, { vibrance: -100, saturation: 100 }, { vibrance: 77.7, saturation: -12.3 }],
  'color-balance': [
    { midR: 30, midB: -20, highB: 20 },
    { shadowsR: -50, highG: 40, preserveLuminosity: false },
    { midR: 100, midG: -100, shadowsB: 77 },
  ],
  'selective-color': [
    { redsC: 20, redsM: -30, neutralsY: -10, blacksK: 20 },
    { whitesC: 50, bluesY: -40, method: 'absolute' },
    { greensK: 30, cyansM: 60, magentasY: -70, yellowsC: 15 },
  ],
};

/** Every 8-bit color once (4096×4096, opaque) — the per-color adjustments are checked on all of them. */
let cube: Uint8ClampedArray | null = null;
function rgbCube() {
  if (!cube) {
    cube = new Uint8ClampedArray(1 << 26);
    for (let i = 0, j = 0; i < 1 << 24; i++, j += 4) {
      cube[j] = i & 255;
      cube[j + 1] = (i >> 8) & 255;
      cube[j + 2] = i >> 16;
      cube[j + 3] = 255;
    }
  }
  return cube;
}

/** Apply the optimized adjustment and the reference to copies of `img`; check bit-identity. */
function check(id: string, p: ParamValues, img: { data: Uint8ClampedArray; width: number; height: number }) {
  const def = byId(id);
  const a = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const b = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  def.apply(a as ImageData, p, ctx);
  REFS[id](b, p);
  let changed = 0;
  for (let j = 0; j < a.data.length; j += 4) {
    if (a.data[j + 3] !== img.data[j + 3]) throw new Error(`${id}: alpha of pixel ${j / 4} changed`);
    if (img.data[j + 3] === 0) {
      if (a.data[j] !== img.data[j] || a.data[j + 1] !== img.data[j + 1] || a.data[j + 2] !== img.data[j + 2]) throw new Error(`${id}: transparent pixel ${j / 4} changed`);
      continue;
    }
    for (let c = 0; c < 3; c++) {
      if (a.data[j + c] !== b.data[j + c]) {
        if (!changed) {
          const q = j / 4;
          const src = [img.data[j], img.data[j + 1], img.data[j + 2]];
          throw new Error(`${id} ${JSON.stringify(p)}: pixel ${q} ${JSON.stringify(src)} → ${[a.data[j], a.data[j + 1], a.data[j + 2]]} (reference ${[b.data[j], b.data[j + 1], b.data[j + 2]]})`);
        }
        changed++;
      }
    }
  }
  return changed;
}

describe('adjustments stay bit-identical after the performance rewrite', () => {
  for (const id of Object.keys(REFS)) {
    it(id, () => {
      const def = byId(id);
      const R = rng(id.length * 7919 + 17);
      for (let k = 0; k < 10; k++) {
        const img = makeImage(k + 1);
        let p = k === 0 ? defaultParams(def.params) : randomParams(def, R);
        if (id === 'hue-saturation' && k === 1) p = { ...p, hue: 0, saturation: 0, lightness: 35, colorize: false };
        if (id === 'gradient-map' && k % 3 === 1)
          p = {
            ...p,
            dither: k % 2 === 1,
            gradient: {
              kind: 'linear',
              angle: 0,
              scale: 1,
              stops: [
                { offset: 0, color: '#10204080' },
                { offset: 0.6, color: '#c03020' },
                { offset: 1, color: '#ffe0a0' },
              ],
            },
          };
        expect(check(id, p, img)).toBe(0);
        // second call with the same params: served (partly) from the per-color memo
        expect(check(id, p, makeImage(k + 2))).toBe(0);
      }
      for (const [k, over] of (EXTRA[id] ?? []).entries()) expect(check(id, { ...defaultParams(def.params), colorize: false, ...over }, makeImage(20 + k))).toBe(0);
    });
  }

  for (const id of Object.keys(EXTRA))
    it(`${id}: every 8-bit color, tie-producing parameters`, () => {
      const img = { data: rgbCube(), width: 4096, height: 4096 };
      const def = byId(id);
      const picks = id === 'hue-saturation' ? [0, 2, 7] : [0];
      for (const k of picks) expect(check(id, { ...defaultParams(def.params), colorize: false, ...EXTRA[id][k] }, img)).toBe(0);
    }, 120000);

  it('the color memo is per parameter set: interleaved parameter sets and images stay identical', () => {
    const sets: [string, ParamValues][] = [
      ['hue-saturation', { hue: 30, saturation: 20 }],
      ['hue-saturation', { hue: -45, lightness: 10 }],
      ['vibrance', { vibrance: 60 }],
      ['selective-color', { redsC: 30, neutralsK: 10 }],
      ['color-balance', { midR: 40 }],
      ['hue-saturation', { hue: 30, saturation: 20.0001 }],
    ];
    for (let round = 0; round < 3; round++)
      for (const [k, [id, over]] of sets.entries()) {
        const def = byId(id);
        expect(check(id, { ...defaultParams(def.params), ...over }, makeImage(50 + ((round * 7 + k) % 5)))).toBe(0);
      }
  });
});
