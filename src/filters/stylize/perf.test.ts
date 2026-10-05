/**
 * The performance rewrites of the creative filters must not change their output: each optimized
 * filter / primitive is compared against its previous implementation (perf.reference.ts, copied
 * from before the rewrite) on random synthetic images with transparency. Everything is
 * bit-identical.
 */
import { describe, expect, it } from 'vitest';
import type { FilterContext, FilterDef } from '../../registry';
import type { ParamValues } from '../../core/types';
import { defaultParams } from '../engine';
import { fxFilterDefs } from './defs';
import * as REF from './perf.reference';
import { blurImage, blurPlane, blurredOne, boxBlurPasses, hashGauss, hashGaussRow, sobel } from './util';
import { detectEdges } from './edges';
import { medianChannel } from './median';
import { screenPlane } from './screen';

/** Deterministic PRNG in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

/**
 * Synthetic RGBA image: smooth color gradients + flat blocks (edges) + per-pixel noise, with
 * fully transparent, semi-transparent and opaque areas (or opaque everywhere).
 */
function makeImage(w: number, h: number, seed: number, opaque = false) {
  const R = rng(seed);
  const d = new Uint8ClampedArray(w * h * 4);
  const fx = 0.02 + R() * 0.1,
    fy = 0.02 + R() * 0.1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = (R() - 0.5) * 40;
      d[i] = 128 + 120 * Math.sin(x * fx + y * fy) + n;
      d[i + 1] = 128 + 120 * Math.sin(x * fy - y * fx + 1) + n;
      d[i + 2] = 128 + 120 * Math.cos((x + y) * fx * 0.7) + n;
      if (((x >> 3) + (y >> 3)) % 5 === 0) {
        d[i] = 250;
        d[i + 1] = 30;
        d[i + 2] = 40; // flat red blocks
      }
      if (((x >> 2) ^ (y >> 2)) % 7 === 3) d[i] = d[i + 1] = d[i + 2] = 20; // dark specks
      let a = 255;
      if (!opaque) {
        if (x < w * 0.15) a = 0;
        else if (x < w * 0.3) a = Math.round(((x - w * 0.15) / (w * 0.15)) * 255);
        else if (R() < 0.04) a = Math.floor(R() * 256);
      }
      d[i + 3] = a;
      if (a === 0 && R() < 0.5) d[i] = d[i + 1] = d[i + 2] = 0;
    }
  return { data: d, width: w, height: h };
}

const ctxOf = (w: number, h: number, extra: Partial<FilterContext> = {}): FilterContext => ({
  docWidth: w,
  docHeight: h,
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  primaryColor: '#000000',
  secondaryColor: '#ffffff',
  ...extra,
});

/** Max per-channel difference and how many channels differ. */
function diff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let max = 0,
    count = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i] - b[i]);
    if (v) count++;
    if (v > max) max = v;
  }
  return { max, count };
}

const NEW = (id: string): FilterDef => {
  const d = fxFilterDefs.find((f) => f.id === id);
  if (!d) throw new Error(`missing ${id}`);
  return d;
};

/** Run the optimized filter and the reference on copies of one image; returns the difference. */
function compare(id: string, ref: FilterDef['apply'], over: ParamValues, img: ReturnType<typeof makeImage>, ctx: FilterContext) {
  const def = NEW(id);
  const p = { ...defaultParams(def.params), ...over };
  const a = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const b = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const ra = (def.apply(a as ImageData, p, ctx) ?? a) as { data: Uint8ClampedArray };
  const rb = (ref(b as ImageData, p, ctx) ?? b) as { data: Uint8ClampedArray };
  return diff(ra.data, rb.data);
}

const SIZES: [number, number][] = [
  [97, 61],
  [160, 90],
  [33, 120],
  [3, 2],
  [1, 1],
  [2, 17],
];

describe('fx filters stay identical after the performance rewrite', () => {
  const cases: [string, FilterDef['apply'], ParamValues[]][] = [
    ['film-grain', REF.filmGrain.apply, [{}, { size: 0.4 }, { size: 3.7, color: 0.6, shadows: 0.1, seed: 9 }, { amount: 1, size: 8 }]],
    ['add-noise', REF.addNoise.apply, [{}, { monochrome: false }, { distribution: 'uniform', amount: 40 }, { monochrome: false, distribution: 'uniform', seed: 4 }]],
    [
      'chromatic-aberration',
      REF.chromaticAberration.apply,
      [{}, { angle: 33, amount: 7.3 }, { angle: -120, amount: 17.5 }, { mode: 'radial', amount: 12 }, { mode: 'radial', amount: 3, center: { x: 0.2, y: 0.7 } }, { amount: 0.6 }],
    ],
    [
      'gaussian-blur',
      // previous Gaussian Blur: radius·scale → blurImage
      (img, p, ctx) => {
        const r = Math.max(0, typeof p.radius === 'number' ? p.radius : 4) * (ctx.scale > 0 ? ctx.scale : 1);
        if (r < 0.2 || img.data.every((v, i) => (i & 3) !== 3 || v === 0)) return img;
        return REF.blurImage(img, r);
      },
      [{}, { radius: 0.5 }, { radius: 2.3 }, { radius: 7 }, { radius: 20 }],
    ],
    ['bloom', REF.bloom.apply, [{}, { radius: 12, spill: false }, { radius: 4, threshold: 0.3 }, { radius: 80, saturation: 1.6, intensity: 2.5 }, { radius: 22.7, saturation: 0.3 }]],
    [
      'halftone',
      REF.halftone.apply,
      [{}, { shape: 'cross', angle: 17, size: 5.5, contrast: 40, transparentPaper: true }, { mode: 'color', shape: 'ellipse', mix: 0.6 }, { mode: 'cmyk', size: 9 }],
    ],
    ['cel-shade', REF.celShade.apply, [{}, { levels: 6, smoothness: 0, outlineThickness: 4.5, edgeThreshold: 0.1 }, { outline: false, saturation: -40 }, { levels: 2, smoothness: 1, saturation: 0 }]],
    ['cutout', REF.cutout.apply, [{}, { colors: 12, tones: 2, simplicity: 6, fidelity: 0.2, saturation: 30 }, { simplicity: 0, fidelity: 1 }, { simplicity: 12, tones: 1 }]],
  ];
  for (const [id, ref, params] of cases) {
    it(`${id} is bit-identical`, () => {
      let seed = 1;
      for (const [w, h] of SIZES)
        for (const opaque of [false, true])
          for (const p of params) {
            const img = makeImage(w, h, seed++, opaque);
            for (const ctx of [ctxOf(w, h), ctxOf(w * 2, h * 2, { offsetX: 13, offsetY: 7, scale: 0.5 })]) {
              const r = compare(id, ref, p, img, ctx);
              if (r.max !== 0) throw new Error(`${id} ${w}x${h} opaque=${opaque} ${JSON.stringify(p)}: max ${r.max} (${r.count} ch)`);
            }
          }
    });
  }

  it('vignette is bit-identical (shapes, offsets, preview scales)', () => {
    let seed = 100;
    const params: ParamValues[] = [
      {},
      { roundness: -0.5, feather: 0.8, color: '#ff8020', amount: 0.9 },
      { roundness: 1, size: 0.2, feather: 0 },
      { center: { x: 0.3, y: 0.8 }, amount: 0.25 },
      { size: 1, feather: 1 },
      { roundness: -1, amount: 1, color: '#ffffff' },
      { roundness: 0.35, size: 0, feather: 0.1, amount: 0.37 },
    ];
    for (const [w, h] of SIZES)
      for (const p of params) {
        const img = makeImage(w, h, seed++);
        for (const ctx of [
          ctxOf(w, h),
          ctxOf(w * 3, h * 2, { offsetX: w * 0.7, offsetY: 5, scale: 0.75 }),
          ctxOf(w * 2, h * 2, { offsetX: 3, offsetY: 9, scale: 0.5 }),
          ctxOf(w, h + 1),
        ]) {
          const r = compare('vignette', REF.vignette.apply, p, img, ctx);
          if (r.max !== 0) throw new Error(`vignette ${w}x${h} ${JSON.stringify(p)} ${JSON.stringify(ctx)}: max ${r.max} (${r.count} ch)`);
        }
      }
  });

  it('vignette: region renders between full renders stay identical to the reference', () => {
    // dirty-rect painting renders an adjustment layer per region with a new offset each frame,
    // interleaved with full-document renders (nothing may leak from one call into the next)
    const W = 240,
      H = 135;
    const full = makeImage(W, H, 31, true);
    const R = rng(77);
    const p: ParamValues = { amount: 0.8, size: 0.4, feather: 0.6, roundness: -0.3, color: '#102040' };
    for (let k = 0; k < 30; k++) {
      const rw = 1 + Math.floor(R() * 60),
        rh = 1 + Math.floor(R() * 40);
      const x0 = Math.floor(R() * (W - rw)),
        y0 = Math.floor(R() * (H - rh));
      const region = makeImage(rw, rh, 200 + k);
      const rc = ctxOf(W, H, { offsetX: x0, offsetY: y0 });
      const r = compare('vignette', REF.vignette.apply, p, region, rc);
      if (r.max !== 0) throw new Error(`region ${k} ${rw}x${rh}@${x0},${y0}: max ${r.max}`);
      if (k % 5 === 4) {
        const f = compare('vignette', REF.vignette.apply, p, full, ctxOf(W, H));
        if (f.max !== 0) throw new Error(`full render after region ${k}: max ${f.max}`);
      }
    }
  });

  it('vignette keeps transparent pixels and alpha untouched', () => {
    const img = makeImage(80, 50, 7);
    const def = NEW('vignette');
    const out = { data: new Uint8ClampedArray(img.data), width: 80, height: 50 };
    def.apply(out as ImageData, { ...defaultParams(def.params), amount: 1 }, ctxOf(80, 50));
    for (let j = 0; j < img.data.length; j += 4) {
      expect(out.data[j + 3]).toBe(img.data[j + 3]);
      if (img.data[j + 3] === 0) expect([out.data[j], out.data[j + 1], out.data[j + 2]]).toEqual([img.data[j], img.data[j + 1], img.data[j + 2]]);
    }
  });
});

describe('shared primitives stay bit-identical', () => {
  const sigmas = [0.3, 0.7, 0.9, 1, 1.1, 1.7, 2.64, 4, 5.99, 6, 9, 17];
  const sizes: [number, number][] = [
    [1, 1],
    [1, 7],
    [7, 1],
    [5, 4],
    [13, 9],
    [64, 37],
    [3, 40],
    [40, 3],
  ];

  it('blurPlane / blurImage (straight and opaque) / boxBlurPasses', () => {
    const R = rng(5);
    for (const [w, h] of sizes)
      for (const sg of sigmas) {
        const pl = new Float32Array(w * h).map(() => (R() < 0.1 ? 0 : R()));
        expect(blurPlane(Float32Array.from(pl), w, h, sg)).toEqual(REF.blurPlane(Float32Array.from(pl), w, h, sg));
        for (const opaque of [false, true]) {
          const im = makeImage(w, h, Math.floor(R() * 1e6), opaque);
          const a = { data: new Uint8ClampedArray(im.data), width: w, height: h };
          const b = { data: new Uint8ClampedArray(im.data), width: w, height: h };
          blurImage(a, sg);
          REF.blurImage(b, sg);
          expect(diff(a.data, b.data).max, `blurImage ${w}x${h} σ${sg} opaque=${opaque}`).toBe(0);
        }
      }
    for (const [w, h] of sizes)
      for (const ch of [1, 2, 3, 4])
        for (const [r, al] of [
          [0, 0.3],
          [1, 0],
          [2, 0.5],
          [7, 0.1],
        ]) {
          const f = new Float32Array(w * h * ch).map(() => R());
          const list = [
            { r, alpha: al },
            { r: r + 1, alpha: 0 },
            { r, alpha: al },
          ];
          expect(boxBlurPasses(Float32Array.from(f), w, h, ch, list)).toEqual(REF.boxBlurPasses(Float32Array.from(f), w, h, ch, list));
        }
  });

  it('blurredOne equals blurring a plane of ones', () => {
    for (const [w, h] of [...sizes, [200, 150] as [number, number]])
      for (const sg of sigmas) {
        const p = new Float32Array(w * h).fill(1);
        REF.blurPlane(p, w, h, sg);
        for (let i = 0; i < p.length; i++) if (p[i] !== blurredOne(w, h, sg)) throw new Error(`${w}x${h} σ${sg}`);
      }
  });

  it('separable median, sobel, edge detection, screening, gaussian hash rows', () => {
    const R = rng(11);
    for (const [w, h] of [...sizes, [300, 7] as [number, number]])
      for (const r of [1, 2, 3, 4.6, 7, 12, 13]) {
        const p = new Uint8Array(w * h).map(() => (R() < 0.5 ? R() * 256 : 128));
        expect(medianChannel(p, w, h, r, true)).toEqual(REF.medianChannel(p, w, h, r, true));
        expect(medianChannel(p, w, h, r, false)).toEqual(REF.medianChannel(p, w, h, r, false));
      }
    for (const [w, h] of [...sizes, [97, 61] as [number, number]]) {
      const pl = new Float32Array(w * h).map(() => R());
      const a = sobel(pl, w, h),
        b = REF.sobel(pl, w, h);
      expect(a.gx).toEqual(b.gx);
      expect(a.gy).toEqual(b.gy);
      expect(a.mag).toEqual(b.mag);
      expect(detectEdges(pl, w, h, 0.2, 3)).toEqual(REF.detectEdges(pl, w, h, 0.2, 3));
      const dark = new Float32Array(w * h).map(() => R());
      for (const shape of ['dot', 'line', 'square', 'cross', 'diamond', 'ellipse'] as const) {
        const sp = { cell: 3 + R() * 9, angle: R() * 180 - 90, shape, ax: R() * 20, ay: R() * 20, contrast: 1 + R() };
        const o1 = new Float32Array(w * h),
          o2 = new Float32Array(w * h);
        const e1 = [new Float32Array(w * h)],
          e2 = [new Float32Array(w * h)];
        screenPlane(dark, w, h, sp, o1, [pl], e1);
        REF.screenPlane(dark, w, h, sp, o2, [pl], e2);
        expect(o1).toEqual(o2);
        expect(e1[0]).toEqual(e2[0]);
      }
    }
    const row = new Float64Array(50);
    for (const [y, seed] of [
      [0, 1],
      [-7, 8],
      [123456, -3],
    ]) {
      hashGaussRow(row, -20, 50, y, seed);
      for (let k = 0; k < 50; k++) expect(row[k]).toBe(hashGauss(-20 + k, y, seed));
    }
  });
});
