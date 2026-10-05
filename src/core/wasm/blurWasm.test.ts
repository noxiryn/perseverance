/**
 * The WebAssembly kernels (scripts/gen-wasm.mjs) must be bit-identical to the JavaScript loops
 * they replace. Node has WebAssembly, so every helper is run twice on copies of the same random
 * input — forced JavaScript (setBlurBackend('js')) and WebAssembly — and the outputs are compared
 * bit for bit (float32 bit patterns, bytes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blurBackend, blurBackendInfo, setBlurBackend, setWasmShrinkBytes, wasm, wasmAlloc, wasmHeap, wasmMark, wasmRelease } from './runtime';
import { blurChannel, boxBlurImageData } from '../blur';
import { blurImage, blurPlane, boxBlurPasses, multiresBlurGrid, type BoxPass } from '../../filters/stylize/util';
import { medianChannel } from '../../filters/stylize/median';
import { bloom } from '../../filters/stylize/defs/light';
import { defaultParams } from '../../filters/engine';
import type { FilterContext } from '../../registry';
import type { ParamValues } from '../types';

const here = dirname(fileURLToPath(import.meta.url));

/** Deterministic PRNG in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

/** Run fn with forced JavaScript, then with WebAssembly. */
function both<T>(fn: () => T): [T, T] {
  setBlurBackend('js');
  const js = fn();
  setBlurBackend('auto');
  expect(blurBackend()).toBe('wasm');
  const wa = fn();
  return [js, wa];
}

/** Index of the first float whose bit pattern differs, or −1. */
function firstDiff(a: Float32Array | Uint8Array | Uint8ClampedArray, b: Float32Array | Uint8Array | Uint8ClampedArray): number {
  if (a.length !== b.length) return -2;
  const x = a instanceof Float32Array ? new Uint32Array(a.buffer, a.byteOffset, a.length) : a;
  const y = b instanceof Float32Array ? new Uint32Array(b.buffer, b.byteOffset, b.length) : b;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i;
  return -1;
}

/** Float plane with smooth parts, noise, exact zeros / ones and a few big values. */
function floats(n: number, R: () => number, scale = 1): Float32Array {
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = R();
    f[i] = u < 0.08 ? 0 : u < 0.12 ? scale : u < 0.13 ? scale * 1000 * R() : (Math.sin(i * 0.37) * 0.5 + 0.5) * scale * 0.6 + R() * scale * 0.4;
  }
  return f;
}

/** RGBA bytes: gradients, noise, flat blocks, transparent / semi-transparent / opaque areas. */
function image(w: number, h: number, R: () => number, opaque: boolean) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = (R() - 0.5) * 50;
      d[i] = 128 + 120 * Math.sin(x * 0.05 + y * 0.02) + n;
      d[i + 1] = 128 + 120 * Math.sin(x * 0.013 - y * 0.07 + 1) + n;
      d[i + 2] = ((x >> 2) + (y >> 2)) % 5 === 0 ? 250 : 128 + 120 * Math.cos((x + y) * 0.03) + n;
      let a = 255;
      if (!opaque) {
        const u = R();
        a = x < w * 0.2 ? 0 : x < w * 0.45 ? Math.round(((x - w * 0.2) / (w * 0.25)) * 255) : u < 0.06 ? Math.floor(R() * 256) : u < 0.08 ? 0 : 255;
      }
      d[i + 3] = a;
    }
  return { data: d, width: w, height: h };
}

const SIZES: [number, number][] = [
  [1, 1],
  [1, 5],
  [5, 1],
  [2, 2],
  [3, 1],
  [2, 3],
  [3, 3],
  [7, 4],
  [13, 9],
  [16, 16],
  [33, 17],
  [97, 61],
  [17, 120],
  [3840, 3],
];

afterEach(() => {
  setBlurBackend('auto');
  setWasmShrinkBytes(192 << 20);
});

describe('WebAssembly blur kernels', () => {
  it('instantiate in Node and are used by default', () => {
    expect(wasm()).not.toBeNull();
    expect(blurBackend()).toBe('wasm');
    expect(blurBackendInfo().state).toBe('ready');
    setBlurBackend('js');
    expect(blurBackend()).toBe('js');
    expect(wasm()).toBeNull();
  });

  it('the generated module matches scripts/gen-wasm.mjs (source of truth)', async () => {
    const genPath = join(here, '..', '..', '..', 'scripts', 'gen-wasm.mjs');
    const gen = await import(/* @vite-ignore */ genPath);
    const expected: string = gen.generatedSource();
    // Compare modulo line endings: a Windows checkout (core.autocrlf=true, the Git for Windows
    // default on the CI runner) writes the file with CRLF; only the content must match.
    const current = readFileSync(join(here, 'blurWasm.generated.ts'), 'utf8');
    expect(gen.normalizeEol(current)).toBe(expected);
    expect(gen.normalizeEol('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('box passes: 1–6 channels, plain / extended boxes, radius 0, 1, > width, 4K rows', () => {
    const R = rng(1);
    const radii: BoxPass[][] = [
      [{ r: 0, alpha: 0.3 }],
      [{ r: 1, alpha: 0 }],
      [
        { r: 1, alpha: 0 },
        { r: 1, alpha: 0 },
        { r: 1, alpha: 0.42 },
      ],
      [
        { r: 2, alpha: 0.5 },
        { r: 3, alpha: 0 },
        { r: 2, alpha: 0.5 },
      ],
      [{ r: 7, alpha: 0.1 }],
      [
        { r: 40, alpha: 0 },
        { r: 0, alpha: 0 }, // a no-op pass is skipped by both paths
        { r: 41, alpha: 0.9 },
      ],
      [{ r: 4.6, alpha: 1e-7 }], // fractional radius (floored), negligible end taps (plain box)
    ];
    let cases = 0;
    for (const [w, h] of SIZES)
      for (const ch of [1, 2, 3, 4, 5, 6]) {
        if (w * h * ch > 60000 && ch !== 4 && ch !== 1) continue;
        for (const list of radii) {
          const src = floats(w * h * ch, R, ch === 4 ? 255 : 1);
          const [a, b] = both(() => boxBlurPasses(Float32Array.from(src), w, h, ch, list));
          const at = firstDiff(a, b);
          if (at !== -1) throw new Error(`${w}x${h} ch${ch} ${JSON.stringify(list)}: element ${at} js ${a[at]} wasm ${b[at]}`);
          cases++;
        }
      }
    expect(cases).toBeGreaterThan(400);
  });

  it('blurPlane (exact small gaussian, box passes, reduced resolution)', () => {
    const R = rng(2);
    for (const [w, h] of SIZES)
      for (const sigma of [0.3, 0.9, 1, 1.1, 1.7, 2.64, 4, 5.99, 6, 9, 17, 60]) {
        const src = floats(w * h, R);
        const [a, b] = both(() => blurPlane(Float32Array.from(src), w, h, sigma));
        const at = firstDiff(a, b);
        if (at !== -1) throw new Error(`blurPlane ${w}x${h} σ${sigma}: element ${at}`);
      }
  });

  it('blurImage (premultiplied, opaque RGB, small σ, reduced resolution) on odd sizes', () => {
    const R = rng(3);
    for (const [w, h] of [...SIZES, [200, 17] as [number, number], [130, 90] as [number, number]])
      for (const sigma of [0.3, 0.9, 1, 1.7, 2.64, 4, 5.99, 6, 7.5, 17, 25, 40, 120])
        for (const opaque of [false, true]) {
          if (w * h > 20000 && sigma < 1) continue;
          const im = image(w, h, R, opaque);
          const [a, b] = both(() => blurImage({ data: new Uint8ClampedArray(im.data), width: w, height: h }, sigma).data);
          const at = firstDiff(a, b);
          if (at !== -1) throw new Error(`blurImage ${w}x${h} σ${sigma} opaque=${opaque}: byte ${at} js ${a[at]} wasm ${b[at]}`);
        }
  }, 60000);

  it('exact small-σ gaussian (3, 5 and 7 taps; planes and RGBA) incl. tiny and odd sizes', () => {
    const R = rng(8);
    // σ ≤ 1/3 → 3 taps, ≤ 2/3 → 5 taps, < 1 → 7 taps
    const sigmas = [0.16, 0.25, 0.3333, 0.34, 0.5, 0.6666, 0.67, 0.8, 0.999];
    for (const [w, h] of [...SIZES, [6, 2] as [number, number], [2, 9] as [number, number], [8, 8] as [number, number], [1920, 4] as [number, number]])
      for (const sigma of sigmas) {
        const src = floats(w * h, R);
        const [a, b] = both(() => blurPlane(Float32Array.from(src), w, h, sigma));
        let at = firstDiff(a, b);
        if (at !== -1) throw new Error(`blurPlane ${w}x${h} σ${sigma}: element ${at} js ${a[at]} wasm ${b[at]}`);
        for (const opaque of [false, true]) {
          const im = image(w, h, R, opaque);
          const [c, d] = both(() => blurImage({ data: new Uint8ClampedArray(im.data), width: w, height: h }, sigma + 0.05).data);
          at = firstDiff(c, d);
          if (at !== -1) throw new Error(`blurImage ${w}x${h} σ${sigma + 0.05} opaque=${opaque}: byte ${at} js ${c[at]} wasm ${d[at]}`);
        }
        // the grid blur of the reduced-resolution path (small σ on the grid: gaussSmallPlane / RGBA)
        for (const ch of [1, 4]) {
          const g = floats(w * h * ch, R, 255);
          const [e, f] = both(() => {
            const out = Float32Array.from(g);
            multiresBlurGrid(out, w, h, ch, sigma * 4, 4); // σ_grid = sqrt(16σ² − 4) / 4
            return out;
          });
          at = firstDiff(e, f);
          if (at !== -1) throw new Error(`multiresBlurGrid ${w}x${h}x${ch} σ${sigma * 4}: element ${at} js ${e[at]} wasm ${f[at]}`);
        }
      }
  });

  it('small-σ gaussian of a grid that is a view of WebAssembly memory survives memory growth', () => {
    const R = rng(9);
    const w = 700,
      h = 90;
    setWasmShrinkBytes(1 << 30);
    for (const ch of [1, 4]) {
      const src = floats(w * h * ch, R, 255);
      setBlurBackend('js');
      const expected = Float32Array.from(src);
      multiresBlurGrid(expected, w, h, ch, 3.4, 4); // grid σ ≈ 0.6 → 5 taps
      setBlurBackend('auto');
      const mark = wasmMark();
      try {
        const have = blurBackendInfo().memoryBytes;
        const filler = wasmAlloc(Math.max(0, have - wasmMark() - src.byteLength - 64));
        expect(filler).toBeGreaterThan(0);
        const p = wasmAlloc(src.byteLength);
        expect(p).toBeGreaterThan(0);
        wasmHeap().f32.set(src, p >>> 2);
        multiresBlurGrid(wasmHeap().f32.subarray(p >>> 2, (p >>> 2) + src.length), w, h, ch, 3.4, 4);
        expect(blurBackendInfo().memoryBytes).toBeGreaterThan(have); // the scratch rows grew it
        expect(firstDiff(expected, wasmHeap().f32.slice(p >>> 2, (p >>> 2) + src.length))).toBe(-1);
      } finally {
        wasmRelease(mark);
      }
    }
  });

  it('core boxBlurImageData (u8 passes) and blurChannel (float passes)', () => {
    const R = rng(4);
    const cases: [number, number, number[]][] = [
      ...SIZES.map(([w, h]) => [w, h, [0.4, 1, 2, 3, 5.5, 9, 30, 400]] as [number, number, number[]]),
      [3840, 24, [1, 7, 60]],
      [641, 357, [2, 25]],
    ];
    for (const [w, h, radii] of cases)
      for (const radius of radii) {
        const im = image(w, h, R, R() < 0.5);
        const [a, b] = both(() => boxBlurImageData({ data: new Uint8ClampedArray(im.data), width: w, height: h, colorSpace: 'srgb' } as unknown as ImageData, radius).data);
        const at = firstDiff(a, b);
        if (at !== -1) throw new Error(`boxBlurImageData ${w}x${h} r${radius}: byte ${at} js ${a[at]} wasm ${b[at]}`);
        const src = floats(w * h, R);
        const [c, d] = both(() => blurChannel(Float32Array.from(src), w, h, radius));
        const at2 = firstDiff(c, d);
        if (at2 !== -1) throw new Error(`blurChannel ${w}x${h} r${radius}: element ${at2} js ${c[at2]} wasm ${d[at2]}`);
      }
  });

  it('bloom (bright pass, grid blurs, row sums and screen) on full-size and reduced grids', () => {
    const R = rng(10);
    const ctx = (w: number, h: number): FilterContext => ({ docWidth: w, docHeight: h, offsetX: 0, offsetY: 0, scale: 1, primaryColor: '#000000', secondaryColor: '#ffffff' });
    const variants: ParamValues[] = [
      {},
      { radius: 4, threshold: 0.3 }, // small scales blur at full size (direct rows)
      { radius: 12, spill: false },
      { radius: 22.7, saturation: 0.3 },
      { radius: 80, saturation: 1.6, intensity: 2.5 },
      { radius: 1, threshold: 0, intensity: 3 },
      { radius: 300, threshold: 1 },
    ];
    let cases = 0;
    for (const [w, h] of [[1, 1], [3, 2], [15, 40], [16, 16], [97, 61], [200, 17], [333, 190]] as [number, number][])
      for (const v of variants)
        for (const opaque of [false, true]) {
          const im = image(w, h, R, opaque);
          const p = { ...defaultParams(bloom.params), ...v };
          const [a, b] = both(() => (bloom.apply({ data: new Uint8ClampedArray(im.data), width: w, height: h } as unknown as ImageData, p, ctx(w, h)) as ImageData).data);
          const at = firstDiff(a, b);
          if (at !== -1) throw new Error(`bloom ${w}x${h} ${JSON.stringify(v)} opaque=${opaque}: byte ${at} js ${a[at]} wasm ${b[at]}`);
          cases++;
        }
    // a bigger image: many pixels per cell (float32 cell sums of rounded values)
    for (const v of [{}, { radius: 9, threshold: 0.4, saturation: 1.3 }] as ParamValues[]) {
      const im = image(640, 360, R, false);
      const p = { ...defaultParams(bloom.params), ...v };
      const [a, b] = both(() => (bloom.apply({ data: new Uint8ClampedArray(im.data), width: 640, height: 360 } as unknown as ImageData, p, ctx(640, 360)) as ImageData).data);
      const at = firstDiff(a, b);
      if (at !== -1) throw new Error(`bloom 640x360 ${JSON.stringify(v)}: byte ${at} js ${a[at]} wasm ${b[at]}`);
      cases++;
    }
    expect(cases).toBe(100);
  }, 60000);

  it('separable median networks (3/5/7 taps) incl. clamped edges and narrow planes', () => {
    const R = rng(5);
    for (const [w, h] of [...SIZES, [6, 40] as [number, number], [31, 7] as [number, number], [3840, 5] as [number, number]])
      for (const r of [1, 2, 3]) {
        const p = new Uint8Array(w * h).map(() => (R() < 0.3 ? 128 : R() * 256));
        const [a, b] = both(() => medianChannel(p, w, h, r, true));
        const at = firstDiff(a, b);
        if (at !== -1) throw new Error(`median ${w}x${h} r${r}: ${at} js ${a[at]} wasm ${b[at]}`);
      }
  });

  it('grows memory for big images, reuses it, and frees the stack after every call', () => {
    const R = rng(6);
    const start = wasmMark();
    const w = 4096,
      h = 640; // blurChannel needs 2 × 10 MB of WebAssembly memory (starts at 1 MB)
    const src = floats(w * h, R);
    const [a, b] = both(() => blurChannel(Float32Array.from(src), w, h, 6));
    expect(firstDiff(a, b)).toBe(-1);
    const grown = blurBackendInfo().memoryBytes;
    expect(grown).toBeGreaterThan(2 * w * h * 4);
    expect(wasmMark()).toBe(start);
    // a second call of the same size reuses the memory
    blurChannel(Float32Array.from(src), w, h, 6);
    expect(blurBackendInfo().memoryBytes).toBe(grown);
    expect(wasmMark()).toBe(start);
    // past the shrink threshold the instance is recreated (memory handed back): right after the
    // call with no idle delay …
    setWasmShrinkBytes(4 << 20, 0);
    blurChannel(Float32Array.from(src), w, h, 6);
    expect(blurBackendInfo().memoryBytes).toBeLessThan(grown);
    // … or, by default, once no operation has used it for 2 s (a burst of calls keeps reusing it)
    vi.useFakeTimers();
    try {
      setWasmShrinkBytes(4 << 20, 2000);
      blurChannel(Float32Array.from(src), w, h, 6);
      const big = blurBackendInfo().memoryBytes;
      expect(big).toBeGreaterThan(4 << 20);
      vi.advanceTimersByTime(1500);
      blurChannel(Float32Array.from(src), w, h, 6); // restarts the wait, reuses the memory
      expect(blurBackendInfo().memoryBytes).toBe(big);
      vi.advanceTimersByTime(1500);
      expect(blurBackendInfo().memoryBytes).toBe(big);
      vi.advanceTimersByTime(600);
      expect(blurBackendInfo().memoryBytes).toBeLessThan(4 << 20);
      // operations that don't need the big memory don't postpone handing it back
      blurChannel(Float32Array.from(src), w, h, 6);
      expect(blurBackendInfo().memoryBytes).toBe(big);
      vi.advanceTimersByTime(1500);
      blurChannel(new Float32Array(64 * 64).fill(0.5), 64, 64, 3);
      vi.advanceTimersByTime(600);
      expect(blurBackendInfo().memoryBytes).toBeLessThan(4 << 20);
    } finally {
      vi.useRealTimers();
    }
    const im = image(1500, 900, R, false);
    const [c, d] = both(() => blurImage({ data: new Uint8ClampedArray(im.data), width: 1500, height: 900 }, 4).data);
    expect(firstDiff(c, d)).toBe(-1);
    expect(wasmMark()).toBe(start);
  }, 60000);

  it('a refused allocation changes nothing (callers then fall back to JavaScript)', () => {
    const mark = wasmMark();
    const bytes = blurBackendInfo().memoryBytes;
    expect(wasmAlloc(2 ** 31)).toBe(0);
    expect(wasmAlloc(NaN)).toBe(0);
    expect(wasmMark()).toBe(mark);
    expect(blurBackendInfo().memoryBytes).toBe(bytes);
  });

  it('box passes over a view of WebAssembly memory survive memory growth during the call', () => {
    const R = rng(7);
    const w = 1000,
      h = 50,
      ch = 4;
    const src = floats(w * h * ch, R, 255);
    setBlurBackend('js');
    const list = [
      { r: 30, alpha: 0.2 },
      { r: 30, alpha: 0 },
      { r: 31, alpha: 0.7 },
    ];
    const expected = boxBlurPasses(Float32Array.from(src), w, h, ch, list);
    setBlurBackend('auto');
    setWasmShrinkBytes(1 << 30);
    const mark = wasmMark();
    try {
      // the grid sits at the very end of the current memory, so the rings must grow it
      const have = blurBackendInfo().memoryBytes;
      const filler = wasmAlloc(Math.max(0, have - wasmMark() - src.byteLength - 64));
      expect(filler).toBeGreaterThan(0);
      const p = wasmAlloc(src.byteLength);
      expect(p).toBeGreaterThan(0);
      wasmHeap().f32.set(src, p >>> 2);
      const view = wasmHeap().f32.subarray(p >>> 2, (p >>> 2) + src.length);
      boxBlurPasses(view, w, h, ch, list);
      expect(blurBackendInfo().memoryBytes).toBeGreaterThan(have); // it did grow (the view is detached now)
      const got = wasmHeap().f32.slice(p >>> 2, (p >>> 2) + src.length);
      expect(firstDiff(expected, got)).toBe(-1);
    } finally {
      wasmRelease(mark);
    }
  });
});
