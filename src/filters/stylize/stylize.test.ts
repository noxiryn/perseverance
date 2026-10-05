/**
 * Pure-logic tests for the creative filter library. jsdom has no canvas, so filters run on plain
 * `{ data, width, height }` objects (the filters never construct ImageData themselves).
 */
import { describe, expect, it } from 'vitest';
import type { FilterContext, FilterDef } from '../../registry';
import type { ParamValues } from '../../core/types';
import { defaultParams } from '../engine';
import { fxFilterDefs } from './defs';
import { quantizeSmooth, bandRepresentatives } from './defs/stylize';
import { vignetteAt } from './defs/light';
import { cutoutQuantize, fromOklab, toOklab } from './defs/artistic';
import { separateInks } from './defs/comic';
import { boxIntegral, quantTable } from './defs/retro';
import { blurPlane, boundedDistance, boxBlurInterleaved, boxBlurPlane, coarseField, distanceTransform, insideDistance } from './util';
import { spotLUT } from './screen';

type Img = { data: Uint8ClampedArray; width: number; height: number };

function makeImg(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = fn(x, y);
      data.set(p, (y * w + x) * 4);
    }
  return { data, width: w, height: h };
}

const clone = (img: Img): Img => ({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });

function ctxFor(w: number, h: number, extra: Partial<FilterContext> = {}): FilterContext {
  return { docWidth: w, docHeight: h, offsetX: 0, offsetY: 0, scale: 1, primaryColor: '#000000', secondaryColor: '#ffffff', ...extra };
}

function def(id: string): FilterDef {
  const d = fxFilterDefs.find((f) => f.id === id);
  if (!d) throw new Error(`missing filter ${id}`);
  return d;
}

function run(id: string, img: Img, params: ParamValues = {}, ctx = ctxFor(img.width, img.height)): Img {
  const d = def(id);
  const out = d.apply(img as unknown as ImageData, { ...defaultParams(d.params), ...params }, ctx);
  return out as unknown as Img;
}

const luma = (d: Uint8ClampedArray, j: number) => d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722;

function meanLuma(img: Img, x0 = 0, y0 = 0, x1 = img.width, y1 = img.height): number {
  let s = 0,
    n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      s += luma(img.data, (y * img.width + x) * 4);
      n++;
    }
  return s / n;
}

/** A colorful, partly transparent test image (character-like blob on transparency). */
function sampleImage(w = 48, h = 40): Img {
  return makeImg(w, h, (x, y) => {
    const dx = (x - w / 2) / (w * 0.35),
      dy = (y - h / 2) / (h * 0.4);
    const inside = dx * dx + dy * dy < 1;
    if (!inside) return [0, 0, 0, 0];
    return [Math.round(40 + (x / w) * 200), Math.round(30 + (y / h) * 180), x > w * 0.6 ? 200 : 60, 255];
  });
}

describe('filter catalog', () => {
  const REQUIRED: Record<string, string[]> = {
    'gaussian-blur': ['radius'],
    'motion-blur': ['angle', 'distance'],
    'radial-blur': ['mode', 'amount', 'center'],
    'tilt-shift': [],
    sharpen: ['amount'],
    'unsharp-mask': ['amount', 'radius', 'threshold'],
    'high-pass': ['radius'],
    'add-noise': ['amount', 'monochrome', 'seed'],
    'film-grain': ['amount', 'size', 'seed'],
    'dust-scratches': [],
    median: [],
    halftone: ['shape', 'size', 'angle', 'contrast', 'mode', 'ink', 'paper', 'transparentPaper', 'mix'],
    'ink-outline': ['thickness', 'threshold', 'color', 'keepColors'],
    'comic-dots': [],
    dither: ['mode', 'levels', 'dark', 'light'],
    newsprint: [],
    'screen-print': [],
    risograph: [],
    'cel-shade': ['levels', 'smoothness', 'outline', 'outlineThickness', 'outlineColor', 'edgeThreshold', 'saturation'],
    'posterize-edges': [],
    emboss: ['angle', 'height', 'amount'],
    'find-edges': [],
    solarize: [],
    'glowing-edges': [],
    'oil-paint': ['radius'],
    kuwahara: ['radius'],
    pixelate: ['size'],
    mosaic: [],
    crystallize: [],
    'rough-edges': ['amount', 'scale', 'seed'],
    sketch: [],
    wave: [],
    twirl: [],
    pinch: [],
    spherize: [],
    ripple: [],
    'displace-noise': [],
    'polar-coordinates': [],
    shear: [],
    vignette: ['amount', 'size', 'roundness', 'feather', 'color', 'center'],
    bloom: ['threshold', 'radius', 'intensity'],
    glow: ['threshold', 'radius', 'intensity'],
    'light-rays': ['center', 'length', 'intensity'],
    'god-rays': ['center', 'length', 'intensity'],
    'lens-flare': ['position', 'brightness'],
    'color-glow': [],
    'chromatic-aberration': ['amount', 'angle'],
    glitch: ['amount', 'slices', 'seed'],
    scanlines: ['spacing', 'opacity'],
    vhs: [],
    crt: [],
    'jpeg-artifacts': [],
    sepia: [],
    'old-photo': [],
    watercolor: [],
    charcoal: [],
    'pencil-sketch': [],
    'ink-wash': [],
    'poster-edges': [],
    cutout: [],
    stamp: [],
  };

  it('has every required id with the contract param keys, unique ids, icons and categories', () => {
    const ids = fxFilterDefs.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(45);
    for (const [id, keys] of Object.entries(REQUIRED)) {
      const d = def(id);
      const have = d.params.map((p) => p.key);
      for (const k of keys) expect(have, `${id}.${k}`).toContain(k);
      expect(d.icon, `${id} icon`).toBeTruthy();
      expect(d.category).not.toBe('Roblox');
    }
    expect(def('vignette').adjustment).toBe(true);
    expect(fxFilterDefs.filter((f) => f.adjustment).map((f) => f.id)).toEqual(['vignette']);
  });

  it('matches the documented defaults for the key reference filters', () => {
    const d = (id: string) => defaultParams(def(id).params);
    expect(d('halftone')).toMatchObject({ shape: 'dot', size: 8, angle: 45, contrast: 0, mode: 'mono', ink: '#111111', paper: '#f5f1e8', transparentPaper: false, mix: 1 });
    expect(d('cel-shade')).toMatchObject({ levels: 4, smoothness: 0.2, outline: true, outlineThickness: 2, outlineColor: '#000000', edgeThreshold: 0.35, saturation: 10 });
    expect(d('vignette')).toMatchObject({ amount: 0.5, size: 0.6, roundness: 0, feather: 0.5, color: '#000000', center: { x: 0.5, y: 0.5 } });
    expect(d('gaussian-blur')).toMatchObject({ radius: 4 });
    expect(d('unsharp-mask')).toMatchObject({ amount: 1, radius: 2, threshold: 0 });
    expect(d('chromatic-aberration')).toMatchObject({ amount: 6 });
    expect(d('add-noise')).toMatchObject({ amount: 10, monochrome: true });
  });

  it('every filter runs on a small cut-out, keeps the size and is deterministic', () => {
    const base = sampleImage(40, 32);
    for (const d of fxFilterDefs) {
      const a = run(d.id, clone(base));
      const b = run(d.id, clone(base));
      expect(a.width, d.id).toBe(40);
      expect(a.height, d.id).toBe(32);
      expect(a.data.length, d.id).toBe(base.data.length);
      expect(Buffer.from(a.data).equals(Buffer.from(b.data)), `${d.id} deterministic`).toBe(true);
    }
  });

  it('every filter survives an empty (fully transparent) and a 1×1 image', () => {
    for (const d of fxFilterDefs) {
      const empty = makeImg(8, 6, () => [0, 0, 0, 0]);
      const out = run(d.id, empty);
      expect(out.data.length).toBe(8 * 6 * 4);
      const one = makeImg(1, 1, () => [120, 80, 40, 255]);
      expect(() => run(d.id, one), d.id).not.toThrow();
    }
  });
});

describe('halftone', () => {
  it('ink coverage follows the tone (mono 50% gray ≈ half ink)', () => {
    for (const v of [64, 128, 192]) {
      const img = makeImg(96, 96, () => [v, v, v, 255]);
      const out = run('halftone', img, { size: 8, ink: '#000000', paper: '#ffffff' });
      const coverage = 1 - meanLuma(out, 8, 8, 88, 88) / 255;
      expect(Math.abs(coverage - (1 - v / 255))).toBeLessThan(0.05);
    }
  });

  it('only ink and paper (plus anti-aliasing between them) and alpha is preserved', () => {
    const img = sampleImage();
    const out = run('halftone', clone(img), { ink: '#000000', paper: '#ffffff' });
    for (let j = 0; j < out.data.length; j += 4) {
      expect(out.data[j + 3]).toBe(img.data[j + 3]);
      if (out.data[j + 3]) expect(out.data[j]).toBe(out.data[j + 1]);
    }
  });

  it('the screen is anchored to the document (crops line up with the full render)', () => {
    const full = makeImg(64, 32, () => [110, 110, 110, 255]);
    const crop = makeImg(32, 32, () => [110, 110, 110, 255]);
    const a = run('halftone', full, { size: 6, angle: 30 });
    const b = run('halftone', crop, { size: 6, angle: 30 }, ctxFor(64, 32, { offsetX: 32 }));
    let diff = 0;
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) diff += Math.abs(a.data[(y * 64 + x + 32) * 4] - b.data[(y * 32 + x) * 4]);
    expect(diff / (32 * 32)).toBeLessThan(0.5);
  });

  it('transparent paper leaves only ink coverage in alpha', () => {
    const img = makeImg(32, 32, () => [255, 255, 255, 255]);
    const out = run('halftone', img, { transparentPaper: true });
    for (let j = 3; j < out.data.length; j += 4) expect(out.data[j]).toBe(0);
  });

  it('every spot shape LUT maps coverage monotonically', () => {
    for (const s of ['dot', 'line', 'square', 'cross', 'diamond', 'ellipse'] as const) {
      const { lut } = spotLUT(s);
      for (let i = 1; i < lut.length; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
  });
});

describe('cel shade', () => {
  it('hard quantization yields exactly `levels` monotonic tones', () => {
    const vals = new Set<number>();
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const q = quantizeSmooth(i / 1000, 4, 0);
      expect(q).toBeGreaterThanOrEqual(prev);
      prev = q;
      vals.add(Math.round(q * 1000));
    }
    expect(vals.size).toBe(4);
  });

  it('band representatives keep blacks dark', () => {
    const lum = new Float32Array([0.02, 0.03, 0.05, 0.9]);
    const data = new Uint8ClampedArray(16).fill(255);
    const reps = bandRepresentatives(lum, data, 4);
    expect(reps[0]).toBeLessThan(0.07);
  });

  it('keeps hue and alpha, and outlines the silhouette', () => {
    const img = makeImg(40, 40, (x, y) => {
      const inside = x > 8 && x < 32 && y > 8 && y < 32;
      const k = 0.4 + (x / 40) * 0.6;
      return inside ? [Math.round(220 * k), Math.round(40 * k), Math.round(30 * k), 255] : [0, 0, 0, 0];
    });
    const out = run('cel-shade', clone(img), { outlineThickness: 2 });
    for (let j = 0; j < out.data.length; j += 4) {
      expect(out.data[j + 3]).toBe(img.data[j + 3]);
    }
    // interior keeps a red hue
    const j = (20 * 40 + 20) * 4;
    expect(out.data[j]).toBeGreaterThan(out.data[j + 1] * 2);
    // the silhouette edge is drawn in the outline color (black)
    const e = (20 * 40 + 9) * 4;
    expect(luma(out.data, e)).toBeLessThan(30);
  });
});

describe('cutout', () => {
  it('keeps a small but distinct color region and flattens gradients into tones', () => {
    const w = 120,
      h = 80;
    const img = makeImg(w, h, (x, y) => {
      if (x > 90 && x < 104 && y > 50 && y < 64) return [205, 40, 40, 255];
      const t = y / h;
      return [Math.round(30 + 200 * t), Math.round(60 + 120 * t), Math.round(140 - 60 * t), 255];
    });
    const n = w * h;
    const lab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) toOklab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2], lab, i * 3);
    const q = cutoutQuantize(lab, img.data, n, 6, 3);
    const redLabel = q.lbl[57 * w + 97];
    const [r, g] = fromOklab(q.pal[redLabel * 3], q.pal[redLabel * 3 + 1], q.pal[redLabel * 3 + 2]);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(90);
    const used = new Set(q.lbl);
    expect(used.size).toBeLessThanOrEqual(18);
  });

  it('OKLab round-trips', () => {
    const o = new Float32Array(3);
    toOklab(200, 120, 40, o, 0);
    const back = fromOklab(o[0], o[1], o[2]);
    expect(back.map(Math.round)).toEqual([200, 120, 40]);
  });
});

describe('vignette', () => {
  const o = { docW: 200, docH: 100, cx: 100, cy: 50, size: 0.6, roundness: 0, feather: 0.5 };
  it('is clear in the center and dark in the corners', () => {
    expect(vignetteAt(100, 50, o)).toBe(0);
    expect(vignetteAt(0, 0, o)).toBeGreaterThan(0.95);
  });

  it('is anchored to the document whatever layer it is applied to', () => {
    const full = makeImg(80, 60, () => [200, 200, 200, 255]);
    const part = makeImg(30, 20, () => [200, 200, 200, 255]);
    const a = run('vignette', full, { amount: 0.8 }, ctxFor(80, 60));
    const b = run('vignette', part, { amount: 0.8 }, ctxFor(80, 60, { offsetX: 50, offsetY: 40 }));
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 30; x++) expect(b.data[(y * 30 + x) * 4]).toBe(a.data[((y + 40) * 80 + x + 50) * 4]);
  });

  it('respects the preview scale (same result at half resolution)', () => {
    const full = makeImg(80, 60, () => [220, 220, 220, 255]);
    const half = makeImg(40, 30, () => [220, 220, 220, 255]);
    const a = run('vignette', full, {}, ctxFor(80, 60));
    const b = run('vignette', half, {}, ctxFor(80, 60, { scale: 0.5 }));
    expect(Math.abs(b.data[(5 * 40 + 5) * 4] - a.data[(11 * 80 + 11) * 4])).toBeLessThan(6);
  });
});

describe('blur & alpha', () => {
  it('gaussian blur is premultiplied: no dark fringe around a white cut-out', () => {
    const img = makeImg(40, 40, (x, y) => (x > 12 && x < 28 && y > 12 && y < 28 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const out = run('gaussian-blur', clone(img), { radius: 4 });
    let grew = false;
    for (let j = 0; j < out.data.length; j += 4) {
      if (out.data[j + 3] > 8) expect(out.data[j]).toBeGreaterThan(240);
      if (out.data[j + 3] > 0 && img.data[j + 3] === 0) grew = true;
    }
    expect(grew).toBe(true);
  });

  it('rough edges only erode alpha, deterministically per seed', () => {
    const img = makeImg(64, 64, (x, y) => (x > 6 && x < 58 && y > 6 && y < 58 ? [180, 90, 30, 255] : [0, 0, 0, 0]));
    const a = run('rough-edges', clone(img), { amount: 8, scale: 12, seed: 3 });
    const b = run('rough-edges', clone(img), { amount: 8, scale: 12, seed: 3 });
    const c = run('rough-edges', clone(img), { amount: 8, scale: 12, seed: 4 });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(c.data))).toBe(false);
    let eroded = 0;
    for (let j = 0; j < a.data.length; j += 4) {
      expect(a.data[j + 3]).toBeLessThanOrEqual(img.data[j + 3]);
      if (a.data[j + 3] < img.data[j + 3]) eroded++;
      if (a.data[j + 3] > 0) expect(a.data[j]).toBe(180);
    }
    expect(eroded).toBeGreaterThan(50);
    // the center stays solid
    expect(a.data[(32 * 64 + 32) * 4 + 3]).toBe(255);
  });
});

describe('stylize & retro', () => {
  it('pixelate produces uniform document-aligned blocks', () => {
    const img = makeImg(32, 32, (x, y) => [x * 8, y * 8, 100, 255]);
    const out = run('pixelate', img, { size: 8 });
    for (let by = 0; by < 4; by++)
      for (let bx = 0; bx < 4; bx++) {
        const ref = out.data[(by * 8 * 32 + bx * 8) * 4];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(out.data[((by * 8 + y) * 32 + bx * 8 + x) * 4]).toBe(ref);
      }
  });

  it('dither (two colors) outputs only dark/light and preserves the mean tone', () => {
    for (const mode of ['bayer4', 'bayer8', 'floyd', 'atkinson']) {
      const img = makeImg(64, 64, () => [96, 96, 96, 255]);
      const out = run('dither', img, { mode, palette: 'duotone', dark: '#000000', light: '#ffffff', levels: 2 });
      for (let j = 0; j < out.data.length; j += 4) expect([0, 255]).toContain(out.data[j]);
      expect(Math.abs(meanLuma(out) - 96)).toBeLessThan(14);
    }
  });

  it('chromatic aberration shifts red and blue in opposite directions', () => {
    const img = makeImg(40, 10, (x) => (x >= 20 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = run('chromatic-aberration', img, { amount: 4, angle: 0, mode: 'linear' });
    // red samples from the left (x - dx): at x = 21 it still sees black; blue sees white early
    const j = (5 * 40 + 21) * 4;
    expect(out.data[j]).toBeLessThan(40);
    const k = (5 * 40 + 17) * 4;
    expect(out.data[k + 2]).toBeGreaterThan(200);
    expect(out.data[k + 1]).toBeLessThan(40);
  });

  it('glitch is seeded', () => {
    const img = sampleImage(60, 40);
    const a = run('glitch', clone(img), { seed: 1, amount: 1 });
    const b = run('glitch', clone(img), { seed: 2, amount: 1 });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(false);
  });

  it('scanline coverage integrates exactly', () => {
    expect(boxIntegral(10, 4, 0.5)).toBe(2 * 2 + 2);
    expect(boxIntegral(0, 4, 0.5)).toBe(0);
  });

  it('jpeg quant tables scale with quality', () => {
    const lo = quantTable([16, ...new Array(63).fill(50)], 10, 8);
    const hi = quantTable([16, ...new Array(63).fill(50)], 90, 8);
    expect(lo[0]).toBeGreaterThan(hi[0]);
    expect(hi[0]).toBeGreaterThanOrEqual(1);
  });

  it('ink separation: paper → no ink, pure ink → full coverage', () => {
    const paper = [245, 240, 230];
    const inks = [
      [230, 40, 120],
      [20, 90, 180],
    ];
    const r = new Float32Array([245, 230, 20]),
      g = new Float32Array([240, 40, 90]),
      b = new Float32Array([230, 120, 180]);
    const [c1, c2] = separateInks(r, g, b, 3, paper, inks, 0.001);
    expect(c1[0]).toBeLessThan(0.02);
    expect(c2[0]).toBeLessThan(0.02);
    expect(c1[1]).toBeGreaterThan(0.9);
    expect(c2[2]).toBeGreaterThan(0.9);
  });
});

describe('distance helpers', () => {
  it('bounded distance equals the exact transform within its radius', () => {
    const w = 50,
      h = 40;
    const seed = new Uint8Array(w * h);
    for (let x = 5; x < 45; x++) seed[20 * w + x] = 1;
    seed[5 * w + 7] = 1;
    for (let y = 30; y < 38; y++) for (let x = 30; x < 40; x++) seed[y * w + x] = 1;
    const exact = distanceTransform(seed, w, h);
    const bounded = boundedDistance(seed, w, h, 4);
    for (let i = 0; i < w * h; i++) {
      if (exact[i] <= 4) expect(bounded[i]).toBeCloseTo(exact[i], 4);
      else expect(bounded[i]).toBeGreaterThan(4);
    }
  });

  it('bounded inside distance matches the exact one near the silhouette', () => {
    const img = makeImg(30, 30, (x, y) => ((x - 15) ** 2 + (y - 15) ** 2 < 100 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    const exact = insideDistance(img, true);
    const bounded = insideDistance(img, true, 3);
    for (let i = 0; i < 900; i++) if (exact[i] <= 3) expect(bounded[i]).toBeCloseTo(exact[i], 4);
  });
});

describe('fast planes', () => {
  it('box blur matches a naive clamped box blur (wide, narrow, interleaved) and preserves constants', () => {
    const naive = (src: Float32Array, w: number, h: number, ch: number, r: number, passes: number) => {
      let ref = Float32Array.from(src);
      const at = (b: Float32Array, x: number, y: number, c: number) => b[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * ch + c];
      for (let p = 0; p < passes; p++) {
        const hp = new Float32Array(ref.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) { let s0 = 0; for (let k = -r; k <= r; k++) s0 += at(ref, x + k, y, c); hp[(y * w + x) * ch + c] = s0 / (2 * r + 1); }
        const vp = new Float32Array(ref.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) { let s0 = 0; for (let k = -r; k <= r; k++) s0 += at(hp, x, y + k, c); vp[(y * w + x) * ch + c] = s0 / (2 * r + 1); }
        ref = vp;
      }
      return ref;
    };
    for (const [w, h, ch, r] of [[37, 23, 1, 3], [5, 9, 1, 4], [2, 3, 1, 1], [1, 6, 1, 2], [19, 7, 4, 2], [6, 6, 4, 5]]) {
      const a = new Float32Array(w * h * ch);
      for (let i = 0; i < a.length; i++) a[i] = ((i * 7919) % 101) / 100;
      const ref = naive(a, w, h, ch, r, 2);
      boxBlurInterleaved(a, w, h, ch, r, 2);
      for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(ref[i], 4);
    }
    const c = new Float32Array(37 * 23).fill(0.7);
    boxBlurPlane(c, 37, 23, 5, 3);
    for (let i = 0; i < c.length; i++) expect(c[i]).toBeCloseTo(0.7, 5);
  });

  it('small-sigma blurPlane is an exact clamped gaussian', () => {
    for (const [w, h, sigma] of [[31, 17, 1], [4, 5, 1.6], [40, 3, 0.7]]) {
      const a = new Float32Array(w * h);
      for (let i = 0; i < a.length; i++) a[i] = ((i * 4421) % 97) / 96;
      const r = Math.max(1, Math.ceil(sigma * 3));
      const k: number[] = [];
      for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
      const ks = k.reduce((x, y) => x + y, 0);
      const at = (b: Float32Array, x: number, y: number) => b[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
      const hp = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s0 = 0; for (let i = -r; i <= r; i++) s0 += at(a, x + i, y) * k[i + r]; hp[y * w + x] = s0 / ks; }
      const ref = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s0 = 0; for (let i = -r; i <= r; i++) s0 += at(hp, x, y + i) * k[i + r]; ref[y * w + x] = s0 / ks; }
      blurPlane(a, w, h, sigma);
      for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(ref[i], 4);
    }
  });

  it('gaussian blur keeps a flat opaque image flat', () => {
    const img = makeImg(30, 20, () => [100, 150, 200, 255]);
    const out = run('gaussian-blur', img, { radius: 6 });
    for (let j = 0; j < out.data.length; j += 4) {
      expect(Math.abs(out.data[j] - 100)).toBeLessThanOrEqual(1);
      expect(Math.abs(out.data[j + 2] - 200)).toBeLessThanOrEqual(1);
      expect(out.data[j + 3]).toBe(255);
    }
  });

  it('coarseField reproduces linear fields exactly', () => {
    const f = coarseField(30, 20, 6, (x, y) => x * 2 + y * 0.5);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) expect(f[y * 30 + x]).toBeCloseTo(x * 2 + y * 0.5, 4);
  });
});
