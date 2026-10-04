import { describe, expect, it } from 'vitest';
import type { FilterContext, FilterDef } from '../../registry';
import type { ParamValues } from '../../core/types';
import { defaultParams } from '../engine';
import { TONAL_DEFS, brightnessContrastLut, curvesLuts, exposureLut, levelsLutFromParams, posterizeLut } from './defs/tonal';
import { COLOR_DEFS, blackWhiteGray, BW_DEFAULTS } from './defs/color';
import { MAPPING_DEFS, DEFAULT_MAP_GRADIENT } from './defs/mapping';
import { analysisMask, autoContrastParams, autoToneCurves, autoColorCurves } from './auto';
import { clipRange, computeHistogram, percentile } from './histogram';
import { isIdentityLut, levelsValue, lum3, setLumInto, setSatInto } from './math';
import { STATIC_PRESETS, isCustomName } from './presets';
import { presetSwatchCss } from './swatches';

const ALL: FilterDef[] = [...TONAL_DEFS, ...COLOR_DEFS, ...MAPPING_DEFS];
const byId = (id: string) => {
  const d = ALL.find((f) => f.id === id);
  if (!d) throw new Error(`missing ${id}`);
  return d;
};
const ctx: FilterContext = { docWidth: 8, docHeight: 8, offsetX: 0, offsetY: 0, scale: 1, primaryColor: '#000000', secondaryColor: '#ffffff' };

/** Deterministic test image: 8×8 with varied colors (incl. pure primaries, grays, extremes). */
function testImage(): ImageData {
  const w = 8,
    h = 8;
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) % 256;
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rnd();
    data[i * 4 + 1] = rnd();
    data[i * 4 + 2] = rnd();
    data[i * 4 + 3] = i % 7 === 0 ? 128 : 255;
  }
  const fixed = [
    [0, 0, 0],
    [255, 255, 255],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [128, 128, 128],
  ];
  fixed.forEach((c, k) => data.set([...c, 255], k * 4));
  return { data, width: w, height: h, colorSpace: 'srgb' } as unknown as ImageData;
}

function pixels(...rgba: number[][]): ImageData {
  const data = new Uint8ClampedArray(rgba.flat());
  return { data, width: rgba.length, height: 1, colorSpace: 'srgb' } as unknown as ImageData;
}

function run(id: string, img: ImageData, params: ParamValues = {}): ImageData {
  const def = byId(id);
  return def.apply(img, { ...defaultParams(def.params), ...params }, ctx);
}

const px = (img: ImageData, i: number) => Array.from(img.data.slice(i * 4, i * 4 + 4));

describe('registration contract', () => {
  it('has every required id, flagged adjustment, with an icon and a valid category', () => {
    const required = [
      'brightness-contrast',
      'levels',
      'curves',
      'exposure',
      'vibrance',
      'hue-saturation',
      'color-balance',
      'black-white',
      'photo-filter',
      'channel-mixer',
      'gradient-map',
      'selective-color',
      'invert',
      'posterize',
      'threshold',
      'duotone',
      'split-toning',
      'color-lookup',
    ];
    for (const id of required) {
      const d = byId(id);
      expect(d.adjustment).toBe(true);
      expect(d.icon).toBeTruthy();
      expect(['Adjustments', 'Color']).toContain(d.category);
    }
  });

  it('uses the exact param keys and defaults from the architecture catalog', () => {
    const dp = (id: string) => defaultParams(byId(id).params);
    expect(dp('brightness-contrast')).toMatchObject({ brightness: 0, contrast: 0 });
    expect(dp('levels')).toMatchObject({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
    expect(dp('exposure')).toMatchObject({ exposure: 0, offset: 0, gamma: 1 });
    expect(dp('vibrance')).toMatchObject({ vibrance: 0, saturation: 0 });
    expect(dp('hue-saturation')).toMatchObject({ hue: 0, saturation: 0, lightness: 0, colorize: false });
    expect(dp('color-balance')).toMatchObject({ shadowsR: 0, midG: 0, highB: 0, preserveLuminosity: true });
    expect(dp('black-white')).toMatchObject({ ...BW_DEFAULTS, tint: false, tintColor: '#e1c58f' });
    expect(dp('photo-filter')).toMatchObject({ color: '#ec8a00', density: 0.25, preserveLuminosity: true });
    expect(dp('channel-mixer')).toMatchObject({ rr: 100, rg: 0, rb: 0, gr: 0, gg: 100, gb: 0, br: 0, bg: 0, bb: 100, monochrome: false });
    expect(dp('gradient-map')).toMatchObject({ reverse: false, dither: false });
    expect(dp('posterize')).toMatchObject({ levels: 4 });
    expect(dp('threshold')).toMatchObject({ level: 128 });
    expect(dp('duotone')).toMatchObject({ shadow: '#1a1a1a', highlight: '#f2f2f2', contrast: 0 });
    expect(dp('color-lookup')).toMatchObject({ preset: 'teal-orange', intensity: 1 });
    expect(Object.keys(dp('split-toning'))).toEqual(expect.arrayContaining(['shadowColor', 'highlightColor', 'balance', 'amount']));
    expect(dp('selective-color')).toMatchObject({ range: 'reds', redsC: 0, blacksK: 0 });
  });

  it('every preset only uses keys declared by its adjustment', () => {
    for (const [id, presets] of Object.entries(STATIC_PRESETS)) {
      const keys = new Set(byId(id).params.map((p) => p.key));
      for (const p of presets) for (const k of Object.keys(p.params)) expect(keys.has(k), `${id} › ${p.name} › ${k}`).toBe(true);
    }
  });
});

describe('identity parameters leave pixels unchanged', () => {
  const identity: [string, ParamValues][] = [
    ['brightness-contrast', {}],
    ['brightness-contrast', { legacy: true }],
    ['levels', {}],
    ['curves', {}],
    ['exposure', {}],
    ['vibrance', {}],
    ['hue-saturation', {}],
    ['color-balance', {}],
    ['color-balance', { preserveLuminosity: false }],
    ['photo-filter', { density: 0 }],
    ['channel-mixer', {}],
    ['selective-color', {}],
    ['split-toning', { amount: 0 }],
    ['color-lookup', { intensity: 0 }],
    ['solid-tint', { amount: 0 }],
  ];
  for (const [id, params] of identity) {
    it(`${id} ${JSON.stringify(params)}`, () => {
      const a = testImage();
      const before = Array.from(a.data);
      run(id, a, params);
      expect(Array.from(a.data)).toEqual(before);
    });
  }

  it('gradient map black→white leaves grays unchanged', () => {
    const img = pixels([0, 0, 0, 255], [64, 64, 64, 255], [200, 200, 200, 255], [255, 255, 255, 255]);
    const before = Array.from(img.data);
    run('gradient-map', img, { gradient: DEFAULT_MAP_GRADIENT });
    expect(Array.from(img.data)).toEqual(before);
  });

  it('identity LUTs are exact', () => {
    expect(isIdentityLut(brightnessContrastLut(0, 0))).toBe(true);
    expect(isIdentityLut(exposureLut(0, 0, 1))).toBe(true);
    expect(isIdentityLut(levelsLutFromParams({}))).toBe(true);
    const c = curvesLuts(undefined);
    expect(isIdentityLut(c.r) && isIdentityLut(c.g) && isIdentityLut(c.b)).toBe(true);
  });
});

describe('alpha handling', () => {
  it('preserves alpha and skips fully transparent pixels', () => {
    for (const def of ALL) {
      const img = pixels([10, 200, 30, 0], [10, 200, 30, 77]);
      def.apply(img, defaultParams(def.params), ctx);
      expect(px(img, 0), def.id).toEqual([10, 200, 30, 0]);
      expect(img.data[7], def.id).toBe(77);
    }
  });
});

describe('invert / posterize / threshold / levels', () => {
  it('invert twice is the identity', () => {
    const img = testImage();
    const before = Array.from(img.data);
    run('invert', img);
    expect(Array.from(img.data)).not.toEqual(before);
    run('invert', img);
    expect(Array.from(img.data)).toEqual(before);
  });

  it('invert maps v → 255 − v', () => {
    const img = pixels([0, 100, 255, 255]);
    run('invert', img);
    expect(px(img, 0)).toEqual([255, 155, 0, 255]);
  });

  it('posterize uses equal-width bins mapped to evenly spaced levels', () => {
    const two = posterizeLut(2);
    expect(two[0]).toBe(0);
    expect(two[127]).toBe(0);
    expect(two[128]).toBe(255);
    expect(two[255]).toBe(255);
    const four = posterizeLut(4);
    expect([four[0], four[63], four[64], four[127], four[128], four[191], four[192], four[255]]).toEqual([0, 0, 85, 85, 170, 170, 255, 255]);
    const img = pixels([30, 100, 220, 255]);
    run('posterize', img, { levels: 4 });
    expect(px(img, 0)).toEqual([0, 85, 255, 255]);
  });

  it('threshold splits on luminosity', () => {
    const img = pixels([127, 127, 127, 255], [128, 128, 128, 255], [255, 0, 0, 255], [0, 255, 0, 255]);
    run('threshold', img, { level: 128 });
    expect(px(img, 0)).toEqual([0, 0, 0, 255]);
    expect(px(img, 1)).toEqual([255, 255, 255, 255]);
    expect(px(img, 2)).toEqual([0, 0, 0, 255]); // red luma ≈ 76
    expect(px(img, 3)).toEqual([255, 255, 255, 255]); // green luma ≈ 150
  });

  it('levels maps the input range and gamma like Photoshop', () => {
    expect(levelsValue(50, 50, 200, 1, 0, 255)).toBe(0);
    expect(levelsValue(200, 50, 200, 1, 0, 255)).toBe(255);
    expect(levelsValue(125, 50, 200, 1, 0, 255)).toBeCloseTo(127.5, 5);
    expect(levelsValue(0, 50, 200, 1, 0, 255)).toBe(0);
    expect(levelsValue(255, 50, 200, 1, 0, 255)).toBe(255);
    // gamma > 1 brightens midtones
    expect(levelsValue(128, 0, 255, 2, 0, 255)).toBeGreaterThan(170);
    // output range
    expect(levelsValue(0, 0, 255, 1, 20, 230)).toBe(20);
    expect(levelsValue(255, 0, 255, 1, 20, 230)).toBe(230);
    const lut = levelsLutFromParams({ inBlack: 50, inWhite: 200 });
    expect([lut[0], lut[50], lut[125], lut[200], lut[255]]).toEqual([0, 0, 128, 255, 255]);
  });

  it('levels guards inverted input ranges', () => {
    const lut = levelsLutFromParams({ inBlack: 200, inWhite: 100 });
    expect(lut[199]).toBe(0);
    expect(lut[203]).toBe(255);
  });

  it('curves Negative preset inverts', () => {
    const neg = STATIC_PRESETS.curves.find((p) => p.name === 'Negative')!;
    const img = pixels([10, 128, 250, 255]);
    run('curves', img, neg.params);
    expect(px(img, 0)).toEqual([245, 127, 5, 255]);
  });
});

describe('color adjustments', () => {
  it('hue rotation moves primaries around the wheel', () => {
    const img = pixels([255, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255], [128, 128, 128, 255]);
    const a = pixels([255, 0, 0, 255]);
    run('hue-saturation', a, { hue: 120 });
    expect(px(a, 0)).toEqual([0, 255, 0, 255]);
    const b = pixels([255, 0, 0, 255]);
    run('hue-saturation', b, { hue: -120 });
    expect(px(b, 0)).toEqual([0, 0, 255, 255]);
    const c = pixels([255, 0, 0, 255]);
    run('hue-saturation', c, { hue: 180 });
    expect(px(c, 0)).toEqual([0, 255, 255, 255]);
    run('hue-saturation', img, { hue: 90 });
    expect(px(img, 3)).toEqual([128, 128, 128, 255]); // grays have no hue
  });

  it('saturation −100 fully desaturates, lightness ±100 reaches white/black', () => {
    const a = pixels([200, 50, 80, 255]);
    run('hue-saturation', a, { saturation: -100 });
    expect(a.data[0]).toBe(a.data[1]);
    expect(a.data[1]).toBe(a.data[2]);
    const w = pixels([200, 50, 80, 255]);
    run('hue-saturation', w, { lightness: 100 });
    expect(px(w, 0)).toEqual([255, 255, 255, 255]);
    const k = pixels([200, 50, 80, 255]);
    run('hue-saturation', k, { lightness: -100 });
    expect(px(k, 0)).toEqual([0, 0, 0, 255]);
  });

  it('colorize produces a single hue', () => {
    const img = pixels([30, 200, 90, 255], [200, 30, 90, 255]);
    run('hue-saturation', img, { colorize: true, hue: 35, saturation: 0 });
    for (let i = 0; i < 2; i++) {
      const [r, g, b] = px(img, i);
      expect(r).toBeGreaterThanOrEqual(g);
      expect(g).toBeGreaterThanOrEqual(b);
    }
  });

  it('black & white uses the Photoshop weighting', () => {
    expect(blackWhiteGray(255, 0, 0, BW_DEFAULTS)).toBeCloseTo(102, 5);
    expect(blackWhiteGray(0, 0, 255, BW_DEFAULTS)).toBeCloseTo(51, 5);
    expect(blackWhiteGray(255, 255, 0, BW_DEFAULTS)).toBeCloseTo(153, 5);
    expect(blackWhiteGray(90, 90, 90, BW_DEFAULTS)).toBe(90);
    const img = testImage();
    run('black-white', img);
    for (let i = 0; i < 64; i++) {
      const [r, g, b] = px(img, i);
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });

  it('color balance with Preserve Luminosity keeps HSL lightness', () => {
    const img = pixels([100, 120, 140, 255]);
    run('color-balance', img, { midR: 60, midB: -40, preserveLuminosity: true });
    const [r, g, b] = px(img, 0);
    expect(Math.abs((Math.max(r, g, b) + Math.min(r, g, b)) / 2 - 120)).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThan(b);
  });

  it('channel mixer swaps channels and builds monochrome mixes', () => {
    const img = pixels([10, 20, 30, 255]);
    run('channel-mixer', img, { rr: 0, rb: 100, bb: 0, br: 100 });
    expect(px(img, 0)).toEqual([30, 20, 10, 255]);
    const m = pixels([100, 50, 0, 255]);
    run('channel-mixer', m, { monochrome: true, rr: 50, rg: 50, rb: 0 });
    expect(px(m, 0)).toEqual([75, 75, 75, 255]);
  });

  it('selective color: relative leaves pure white alone, absolute tints it', () => {
    const rel = pixels([255, 255, 255, 255]);
    run('selective-color', rel, { whitesY: 50, method: 'relative' });
    expect(px(rel, 0)).toEqual([255, 255, 255, 255]);
    const abs = pixels([255, 255, 255, 255]);
    run('selective-color', abs, { whitesY: 50, method: 'absolute' });
    expect(abs.data[2]).toBeLessThan(255);
    expect(abs.data[0]).toBe(255);
  });

  it('selective color reds: less cyan makes reds redder only', () => {
    const img = pixels([200, 60, 60, 255], [60, 60, 200, 255]);
    run('selective-color', img, { redsC: -100, method: 'absolute' });
    expect(img.data[0]).toBeGreaterThan(200);
    expect(px(img, 1)).toEqual([60, 60, 200, 255]);
  });

  it('vibrance never clips saturated channels', () => {
    const img = pixels([250, 40, 30, 255], [140, 120, 110, 255]);
    run('vibrance', img, { vibrance: 100 });
    expect(img.data[0]).toBeLessThanOrEqual(255);
    // the muted color gains more relative saturation
    const [r, , b] = px(img, 1);
    expect(r - b).toBeGreaterThan(30);
  });
});

describe('mapping adjustments', () => {
  it('gradient map endpoints map black → first stop and white → last stop', () => {
    const gradient = {
      ...DEFAULT_MAP_GRADIENT,
      stops: [
        { offset: 0, color: '#102030' },
        { offset: 0.5, color: '#ff0000' },
        { offset: 1, color: '#f0e0d0' },
      ],
    };
    const img = pixels([0, 0, 0, 255], [255, 255, 255, 255]);
    run('gradient-map', img, { gradient });
    expect(px(img, 0)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(px(img, 1)).toEqual([0xf0, 0xe0, 0xd0, 255]);
    const rev = pixels([0, 0, 0, 255], [255, 255, 255, 255]);
    run('gradient-map', rev, { gradient, reverse: true });
    expect(px(rev, 0)).toEqual([0xf0, 0xe0, 0xd0, 255]);
    expect(px(rev, 1)).toEqual([0x10, 0x20, 0x30, 255]);
  });

  it('gradient map alpha stops blend with the original', () => {
    const gradient = {
      ...DEFAULT_MAP_GRADIENT,
      stops: [
        { offset: 0, color: '#ff000000' },
        { offset: 1, color: '#ff0000ff' },
      ],
    };
    const img = pixels([0, 0, 0, 255], [255, 255, 255, 255]);
    run('gradient-map', img, { gradient });
    expect(px(img, 0)).toEqual([0, 0, 0, 255]); // fully transparent stop → original kept
    expect(px(img, 1)).toEqual([255, 0, 0, 255]);
  });

  it('dithered gradient map stays within one level of the plain result', () => {
    const a = testImage();
    const b = testImage();
    const gradient = {
      ...DEFAULT_MAP_GRADIENT,
      stops: [
        { offset: 0, color: '#200010' },
        { offset: 1, color: '#ffd080' },
      ],
    };
    run('gradient-map', a, { gradient });
    run('gradient-map', b, { gradient, dither: true });
    for (let i = 0; i < a.data.length; i++) expect(Math.abs(a.data[i] - b.data[i])).toBeLessThanOrEqual(3);
  });

  it('duotone maps black/white to the two inks', () => {
    const img = pixels([0, 0, 0, 255], [255, 255, 255, 255]);
    run('duotone', img, { shadow: '#102030', highlight: '#a0b0c0' });
    expect(px(img, 0)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(px(img, 1)).toEqual([0xa0, 0xb0, 0xc0, 255]);
  });

  it('every color lookup look changes the image and stays deterministic', () => {
    const looks = ['teal-orange', 'bleach-bypass', 'crimson', 'cold-steel', 'golden', 'faded-film', 'cross-process', 'noir', 'toxic', 'royal'];
    for (const preset of looks) {
      const a = testImage();
      const before = Array.from(a.data);
      run('color-lookup', a, { preset });
      expect(Array.from(a.data), preset).not.toEqual(before);
      const b = testImage();
      run('color-lookup', b, { preset });
      expect(Array.from(b.data)).toEqual(Array.from(a.data));
    }
  });

  it('noir look is monochrome-ish and solid tint color mode keeps luminosity order', () => {
    const img = pixels([255, 0, 0, 255], [0, 0, 255, 255]);
    run('color-lookup', img, { preset: 'noir' });
    const [r, g, b] = px(img, 0);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(8);
    const t = pixels([20, 20, 20, 255], [230, 230, 230, 255]);
    run('solid-tint', t, { color: '#c4141c', mode: 'color', amount: 1 });
    expect(t.data[0]).toBeLessThan(t.data[4]);
  });

  it('solid tint color/hue fast paths match the W3C reference formulas', () => {
    const ref = (r: number, g: number, b: number, tint: [number, number, number], mode: 'color' | 'hue') => {
      const out = new Float64Array(3);
      const [tr, tg, tb] = tint.map((v) => v / 255);
      const L = lum3(r / 255, g / 255, b / 255);
      if (mode === 'hue') {
        setSatInto(tr, tg, tb, (Math.max(r, g, b) - Math.min(r, g, b)) / 255, out);
        setLumInto(out[0], out[1], out[2], L, out);
      } else setLumInto(tr, tg, tb, L, out);
      return Array.from(out, (v) => Math.round(v * 255));
    };
    const tints: [number, number, number][] = [
      [196, 20, 28],
      [31, 111, 138],
      [240, 160, 64],
      [128, 128, 128],
    ];
    for (const mode of ['color', 'hue'] as const) {
      for (const tint of tints) {
        const img = testImage();
        const src = Array.from(img.data);
        const hex = `#${tint.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        run('solid-tint', img, { color: hex, mode, amount: 1 });
        for (let p = 0; p < img.width * img.height; p++) {
          const [r, g, b, a] = src.slice(p * 4, p * 4 + 4);
          if (a === 0) continue;
          const want = ref(r, g, b, tint, mode);
          for (let c = 0; c < 3; c++) expect(Math.abs(img.data[p * 4 + c] - want[c]), `${mode} ${hex} px${p}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('histogram + auto', () => {
  it('computes per-channel and luminance histograms, ignoring transparent pixels', () => {
    const img = pixels([10, 20, 30, 255], [10, 20, 30, 0], [255, 255, 255, 255]);
    const h = computeHistogram(img);
    expect(h.count).toBe(2);
    expect(h.r[10]).toBe(1);
    expect(h.b[255]).toBe(1);
    expect(h.lum[255]).toBe(1);
    expect(percentile(h.r, 1)).toBe(255);
  });

  it('clipRange trims the requested fraction from both ends', () => {
    const bins = new Uint32Array(256);
    bins[0] = 1;
    for (let i = 50; i <= 200; i++) bins[i] = 100;
    bins[255] = 1;
    expect(clipRange(bins, 0.001)).toEqual([50, 200]);
    expect(clipRange(new Uint32Array(256), 0.001)).toEqual([0, 255]);
  });

  it('analysis mask ignores near-transparent noise so auto contrast still finds the range', () => {
    // A soft red glow: solid-ish core (200,20,30) plus many faint pixels whose colors are
    // un-premultiply quantization noise (0 / 255 extremes).
    const rows: number[][] = [];
    for (let i = 0; i < 400; i++) rows.push([200, 20, 30, 120 + (i % 100)]);
    for (let i = 0; i < 600; i++) rows.push(i % 2 ? [255, 0, 0, 2] : [0, 255, 255, 1]);
    rows.push([0, 0, 0, 0]);
    const img = pixels(...rows);
    expect(autoContrastParams(computeHistogram(img))).toBeNull(); // noise spans 0..255
    const mask = analysisMask(img);
    expect(mask.reduce((a, b) => a + b, 0)).toBe(400);
    expect(autoContrastParams(computeHistogram(img, { mask }))).toEqual({ inBlack: 20, inWhite: 200 });
    // Selection restricts the sample; a faint-only layer falls back to every visible pixel.
    const sel = new Uint8Array(rows.length);
    sel.fill(255, 0, 10);
    expect(analysisMask(img, sel).reduce((a, b) => a + b, 0)).toBe(10);
    const faint = pixels([10, 10, 10, 5], [200, 200, 200, 6], [0, 0, 0, 0]);
    expect(Array.from(analysisMask(faint))).toEqual([1, 1, 0]);
  });

  it('auto contrast and auto tone stretch the used range', () => {
    const rows: number[][] = [];
    for (let v = 60; v <= 190; v++) rows.push([v, Math.min(255, v + 20), Math.max(0, v - 30), 255]);
    const img = pixels(...rows);
    const h = computeHistogram(img);
    const ac = autoContrastParams(h, 0);
    expect(ac).toEqual({ inBlack: 30, inWhite: 210 });
    const at = autoToneCurves(h, 0)!;
    expect(at.r).toEqual([
      [60, 0],
      [190, 255],
    ]);
    expect(at.g).toEqual([
      [80, 0],
      [210, 255],
    ]);
    expect(at.b).toEqual([
      [30, 0],
      [160, 255],
    ]);
    const full = pixels([0, 0, 0, 255], [255, 255, 255, 255]);
    expect(autoContrastParams(computeHistogram(full), 0)).toBeNull();
    expect(autoToneCurves(computeHistogram(full), 0)).toBeNull();
  });

  it('auto color neutralizes a color cast', () => {
    const rows: number[][] = [];
    // A gray ramp with a blue cast (blue lifted, red lowered).
    for (let v = 0; v <= 255; v += 1) rows.push([Math.round(v * 0.8), v, Math.min(255, Math.round(v * 0.85 + 40)), 255]);
    const img = pixels(...rows);
    const curves = autoColorCurves(img, null, 0.001)!;
    expect(curves).not.toBeNull();
    const luts = curvesLuts(curves);
    const mid = rows[128];
    const r = luts.r[mid[0]],
      g = luts.g[mid[1]],
      b = luts.b[mid[2]];
    const before = Math.max(...mid.slice(0, 3)) - Math.min(...mid.slice(0, 3));
    const after = Math.max(r, g, b) - Math.min(r, g, b);
    expect(after).toBeLessThan(before / 2);
  });
});

describe('tone LUT behaviour', () => {
  it('brightness brightens without clipping; contrast keeps the endpoints', () => {
    const b = brightnessContrastLut(100, 0);
    expect(b[128]).toBeGreaterThan(150);
    expect(b[0]).toBe(0);
    expect(b[255]).toBe(255);
    const c = brightnessContrastLut(0, 60);
    expect(c[0]).toBe(0);
    expect(c[255]).toBe(255);
    expect(c[64]).toBeLessThan(64);
    expect(c[192]).toBeGreaterThan(192);
  });

  it('exposure +1 stop doubles linear light', () => {
    const l = exposureLut(1, 0, 1);
    expect(l[0]).toBe(0);
    expect(l[100]).toBeGreaterThan(130);
    expect(l[255]).toBe(255);
  });
});

describe('preset swatches', () => {
  it('builds CSS previews for color-based presets only', () => {
    const gm = presetSwatchCss('gradient-map', { gradient: DEFAULT_MAP_GRADIENT, reverse: true });
    expect(gm).toBe('linear-gradient(90deg, #ffffff 0.0%, #000000 100.0%)');
    expect(presetSwatchCss('duotone', { shadow: '#101010', highlight: '#fafafa' })).toContain('#101010');
    expect(presetSwatchCss('solid-tint', { color: '#c4141c' })).toBe('#c4141c');
    expect(presetSwatchCss('hue-saturation', { colorize: false })).toBeNull();
    expect(presetSwatchCss('hue-saturation', { colorize: true, hue: 0, saturation: 100 })).toMatch(/^linear-gradient/);
    expect(presetSwatchCss('levels', { inBlack: 10 })).toBeNull();
    for (const preset of ['teal-orange', 'noir', 'crimson']) {
      const css = presetSwatchCss('color-lookup', { preset, intensity: 1 });
      expect(css).toMatch(/^linear-gradient\(90deg, #[0-9a-f]{6} 0\.0%/);
    }
    expect(presetSwatchCss('color-lookup', { preset: 'nope' })).toBeNull();
  });
});

describe('layer naming', () => {
  it('detects auto-generated adjustment layer names', () => {
    expect(isCustomName('Levels', 'Levels')).toBe(false);
    expect(isCustomName('Levels 3', 'Levels')).toBe(false);
    expect(isCustomName('Levels copy', 'Levels')).toBe(true);
    expect(isCustomName('Sunset Amber', 'Gradient Map')).toBe(true);
  });
});
