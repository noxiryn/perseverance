import { describe, expect, it } from 'vitest';
import { SOFT_EDGE_MIN_PIXELS, alphaChannel, finishBakedPixels } from './psdBake';

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

/**
 * Run finishBakedPixels on one pixel: backdrop alpha `ba` (0..255), filtered colour `f`; clipped
 * bakes over a stack covering its whole shape (shape alpha = backdrop alpha).
 */
function bakeOne(ba: number, f: [number, number, number], clipped: boolean): Px {
  const data = new Uint8ClampedArray([f[0], f[1], f[2], ba]);
  const alpha = alphaChannel(data);
  finishBakedPixels(data, alpha, 1, clipped ? alpha : null);
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
    const run = (d: Uint8ClampedArray, clipped = false, opacity = 1) => {
      const alpha = alphaChannel(d);
      return finishBakedPixels(d, alpha, opacity, clipped ? alpha : null);
    };
    expect(run(make(0))).toBe(false); // opaque backdrop
    expect(run(make(SOFT_EDGE_MIN_PIXELS - 1))).toBe(false); // a few stray pixels
    expect(run(make(SOFT_EDGE_MIN_PIXELS))).toBe(true);
    expect(run(make(200, 2))).toBe(false); // nearly transparent: under the error threshold
    expect(run(make(200), false, 0.05)).toBe(false); // a faint layer can't be far off
    expect(run(make(200), true)).toBe(false); // clipped bakes over a full-coverage stack are exact
    const zero = make(200, 0);
    expect(run(zero)).toBe(false); // fully transparent pixels are exact too
  });

  it('clipped: a stack thinner than its base shape (base below 100% fill) cannot be reproduced', () => {
    // Base at 50% fill, opaque shape: our clipped adjustment keeps the stack's 50% alpha…
    const backdrop: Px = [200, 40, 90, 0.5];
    const filtered: [number, number, number] = [30, 160, 220];
    expect(ours(backdrop, [...filtered, 0.5], 1)[3]).toBeCloseTo(0.5, 6);
    // …while the baked layer, clipped onto it, fills the shape up (the base's fill doesn't limit it).
    expect(psOver(backdrop, bakeOne(128, filtered, true), 1)[3]).toBeCloseTo(1, 6);
  });

  it('flags a clipped bake whose stack does not match its base shape', () => {
    const n = 4096;
    const pixels = (alpha: number) => {
      const d = new Uint8ClampedArray(n * 4).fill(200);
      for (let i = 0; i < n; i++) d[i * 4 + 3] = alpha;
      return d;
    };
    const shapeOf = (alpha: number, count = n) => {
      const s = new Uint8Array(n).fill(255);
      s.fill(alpha, 0, count);
      return s;
    };
    const run = (d: Uint8ClampedArray, shape: Uint8Array, opacity = 1) => finishBakedPixels(d, alphaChannel(d), opacity, shape);
    // Stack covers its shape (full fill): exact, also with ±1 rounding between the two renders.
    expect(run(pixels(255), shapeOf(255))).toBe(false);
    expect(run(pixels(254), shapeOf(255))).toBe(false);
    // Base at 50% fill: the stack is half as dense as its shape.
    expect(run(pixels(128), shapeOf(255))).toBe(true);
    // …but a faint adjustment can't be far off, and only enough such pixels count.
    expect(run(pixels(128), shapeOf(255), 0.05)).toBe(false);
    expect(run(pixels(128), shapeOf(128, n - SOFT_EDGE_MIN_PIXELS + 1))).toBe(false);
    expect(run(pixels(128), shapeOf(128, n - SOFT_EDGE_MIN_PIXELS))).toBe(true);
    // Coverage beyond the shape (a centre stroke on the base): clipped pixel layers don't paint there.
    expect(run(pixels(255), shapeOf(0))).toBe(true);
    // Nothing to bake where the stack is empty (0% fill base): exact.
    const empty = pixels(0);
    expect(run(empty, shapeOf(255))).toBe(false);
    expect(Array.from(alphaChannel(empty)).every((a) => a === 0)).toBe(true);
    // Whatever the verdict, clipped bakes are written at full alpha where the stack has coverage.
    const d = pixels(128);
    run(d, shapeOf(255));
    expect(Array.from(alphaChannel(d)).every((a) => a === 255)).toBe(true);
  });
});
