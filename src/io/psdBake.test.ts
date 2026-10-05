import { describe, expect, it } from 'vitest';
import { SOFT_EDGE_MIN_PIXELS, alphaChannel, clippedBakeApprox, finishBakedPixels } from './psdBake';

type Px = [number, number, number, number]; // r, g, b (0..255, straight), a (0..1)

/** Our renderer: mix(backdrop, filtered, m), keeping the backdrop's alpha (premultiplied lerp). */
function ours(b: Px, f: Px, m: number): Px {
  const a = b[3] * (1 - m) + f[3] * m;
  const c = (i: number) => (a ? (b[i] * b[3] * (1 - m) + f[i] * f[3] * m) / a : 0);
  return [c(0), c(1), c(2), a];
}

/** Photoshop, layer P clipped to a stack with coverage b: composites onto it, keeps b's alpha. */
function psClipped(b: Px, p: Px, m: number): Px {
  const k = p[3] * m;
  return [b[0] * (1 - k) + p[0] * k, b[1] * (1 - k) + p[1] * k, b[2] * (1 - k) + p[2] * k, b[3]];
}

/** Photoshop, normal layer P over b (source-over). */
function psOver(b: Px, p: Px, m: number): Px {
  const k = p[3] * m;
  const a = k + b[3] * (1 - k);
  const c = (i: number) => (a ? (p[i] * k + b[i] * b[3] * (1 - k)) / a : 0);
  return [c(0), c(1), c(2), a];
}

/** Run finishBakedPixels on one pixel: backdrop alpha `ba` (0..255), filtered colour `f`. */
function bakeOne(ba: number, f: [number, number, number], clipped: boolean): Px {
  const data = new Uint8ClampedArray([f[0], f[1], f[2], ba]);
  finishBakedPixels(data, alphaChannel(data), clipped, 1);
  return [data[0], data[1], data[2], data[3] / 255];
}

const close = (a: Px, b: Px) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('baked PSD adjustments', () => {
  it('clipped: full alpha wherever the backdrop has coverage reproduces our mix exactly in Photoshop', () => {
    for (const ba of [255, 200, 128, 40, 1]) {
      const backdrop: Px = [200, 40, 90, ba / 255];
      const filtered: [number, number, number] = [30, 160, 220];
      const baked = bakeOne(ba, filtered, true);
      expect(baked[3]).toBe(1);
      for (const m of [1, 0.7, 0.25]) close(psClipped(backdrop, baked, m), ours(backdrop, [...filtered, ba / 255], m));
    }
    // No coverage below → nothing to show.
    expect(bakeOne(0, [10, 20, 30], true)[3]).toBe(0);
  });

  it('unclipped: exact over opaque pixels, denser over semi-transparent ones', () => {
    const filtered: [number, number, number] = [30, 160, 220];
    const opaque: Px = [200, 40, 90, 1];
    close(psOver(opaque, bakeOne(255, filtered, false), 0.6), ours(opaque, [...filtered, 1], 0.6));
    const soft: Px = [200, 40, 90, 0.5];
    const baked = bakeOne(128, filtered, false);
    expect(baked[3]).toBeCloseTo(128 / 255, 6); // the bake keeps the backdrop's alpha…
    expect(psOver(soft, baked, 1)[3]).toBeGreaterThan(0.7); // …so Photoshop's result is denser (ours: 0.5)
  });

  it('flags an unclipped bake as approximate only over enough soft pixels', () => {
    const n = 4096;
    const make = (soft: number, alpha = 128) => {
      const d = new Uint8ClampedArray(n * 4).fill(255);
      for (let i = 0; i < soft; i++) d[i * 4 + 3] = alpha;
      return d;
    };
    const run = (d: Uint8ClampedArray, clipped = false, opacity = 1) => finishBakedPixels(d, alphaChannel(d), clipped, opacity);
    expect(run(make(0))).toBe(false); // opaque backdrop
    expect(run(make(SOFT_EDGE_MIN_PIXELS - 1))).toBe(false); // a few stray pixels
    expect(run(make(SOFT_EDGE_MIN_PIXELS))).toBe(true);
    expect(run(make(200, 2))).toBe(false); // nearly transparent: under the error threshold
    expect(run(make(200), false, 0.05)).toBe(false); // a faint layer can't be far off
    expect(run(make(200), true)).toBe(false); // clipped bakes are exact
    const zero = make(200, 0);
    expect(run(zero)).toBe(false); // fully transparent pixels are exact too
  });

  it('flags a clipped bake when the clip stack is below its base shape (base at a lower Fill)', () => {
    const n = 64;
    const shape = new Uint8Array(n).fill(255);
    const full = new Uint8Array(n).fill(255);
    const half = new Uint8Array(n).fill(128);
    expect(clippedBakeApprox(full, shape, 1)).toBe(false); // stack covers the shape: exact
    expect(clippedBakeApprox(half, shape, 1)).toBe(true); // Fill 50%: Photoshop shows it denser
    expect(clippedBakeApprox(half, shape, 0.05)).toBe(false); // faint: off by < SOFT_EDGE_LEVELS
    expect(clippedBakeApprox(half.subarray(0, SOFT_EDGE_MIN_PIXELS - 1), shape, 1)).toBe(false); // a few stray pixels
    expect(clippedBakeApprox(new Uint8Array(n), shape, 1)).toBe(false); // empty stack: nothing baked there
    // Photoshop, baked layer (full alpha, strength m) clipped to a stack at alpha a inside shape s:
    // the result alpha s·(a/s + m·(1 − a/s)) exceeds ours (a) by m·(s − a).
    const s = 1,
      a = 0.5,
      m = 0.6;
    expect(s * (a / s + m * (1 - a / s)) - a).toBeCloseTo(m * (s - a), 9);
  });
});
