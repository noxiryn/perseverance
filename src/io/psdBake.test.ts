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
 * Our clip stack (src/render/clip.ts) over an opaque base pixel at fill `fill`: the base alone shows
 * at alpha `fill`; a clipped layer P is drawn over it (source-over, strength m), an adjustment `adj`
 * mixes in by m and keeps alpha.
 */
function clipStack(base: [number, number, number], fill: number, p: Px | null, adj: ((c: number[]) => number[]) | null, m: number): Px {
  let c: number[] = [...base];
  let a = fill;
  if (p) {
    const k = p[3] * m;
    const na = k + a * (1 - k);
    c = c.map((v, i) => (p[i] * k + v * a * (1 - k)) / na);
    a = na;
  }
  if (adj) {
    const f = adj(c);
    c = c.map((v, i) => v * (1 - m) + f[i] * m);
  }
  return [c[0], c[1], c[2], a];
}

/** Run finishBakedPixels on one pixel: backdrop alpha `ba` (0..255), filtered colour `f`. */
function bakeOne(ba: number, f: [number, number, number], clipFill: number | null): Px {
  const data = new Uint8ClampedArray([f[0], f[1], f[2], ba]);
  finishBakedPixels(data, alphaChannel(data), clipFill, 1);
  return [data[0], data[1], data[2], data[3] / 255];
}

const close = (a: Px, b: Px) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('baked PSD adjustments', () => {
  it('clipped: full alpha wherever the backdrop has coverage reproduces our mix exactly in Photoshop', () => {
    for (const ba of [255, 200, 128, 40, 1]) {
      const backdrop: Px = [200, 40, 90, ba / 255];
      const filtered: [number, number, number] = [30, 160, 220];
      const baked = bakeOne(ba, filtered, 1);
      expect(baked[3]).toBe(1);
      for (const m of [1, 0.7, 0.25]) close(psClipped(backdrop, baked, m), ours(backdrop, [...filtered, ba / 255], m));
    }
    // No coverage below → nothing to show.
    expect(bakeOne(0, [10, 20, 30], 1)[3]).toBe(0);
  });

  it('clipped to a base below 100% fill: denser by up to 255·m·(1 − fill) levels, and flagged', () => {
    const base: [number, number, number] = [200, 40, 90];
    const inv = (c: number[]) => c.map((v) => 255 - v);
    for (const fill of [0.5, 0.2]) {
      for (const m of [1, 0.5]) {
        const want = clipStack(base, fill, null, inv, m);
        const baked = bakeOne(Math.round(fill * 255), inv(base) as [number, number, number], fill);
        expect(baked[3]).toBe(1);
        const re = clipStack(base, fill, baked, null, m);
        expect(re[3] - want[3]).toBeCloseTo(m * (1 - fill), 6);
      }
    }
    const n = 4096;
    const make = (covered: number) => {
      const d = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < covered; i++) d[i * 4 + 3] = 128;
      return d;
    };
    const run = (d: Uint8ClampedArray, fill: number, opacity = 1) => finishBakedPixels(d, alphaChannel(d), fill, opacity);
    expect(run(make(n), 1)).toBe(false); // 100% fill: exact
    expect(run(make(n), 0.99)).toBe(false); // under the error threshold
    expect(run(make(n), 0.5)).toBe(true);
    expect(run(make(n), 0.5, 0.02)).toBe(false); // a faint layer can't be far off
    expect(run(make(SOFT_EDGE_MIN_PIXELS - 1), 0)).toBe(false); // a few stray pixels
    expect(run(make(0), 0)).toBe(false); // nothing below to adjust: an empty layer is exact
  });

  it('unclipped: exact over opaque pixels, denser over semi-transparent ones', () => {
    const filtered: [number, number, number] = [30, 160, 220];
    const opaque: Px = [200, 40, 90, 1];
    close(psOver(opaque, bakeOne(255, filtered, null), 0.6), ours(opaque, [...filtered, 1], 0.6));
    const soft: Px = [200, 40, 90, 0.5];
    const baked = bakeOne(128, filtered, null);
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
    const run = (d: Uint8ClampedArray, clipFill: number | null = null, opacity = 1) => finishBakedPixels(d, alphaChannel(d), clipFill, opacity);
    expect(run(make(0))).toBe(false); // opaque backdrop
    expect(run(make(SOFT_EDGE_MIN_PIXELS - 1))).toBe(false); // a few stray pixels
    expect(run(make(SOFT_EDGE_MIN_PIXELS))).toBe(true);
    expect(run(make(200, 2))).toBe(false); // nearly transparent: under the error threshold
    expect(run(make(200), null, 0.05)).toBe(false); // a faint layer can't be far off
    expect(run(make(200), 1)).toBe(false); // clipped bakes over a base at 100% fill are exact
    const zero = make(200, 0);
    expect(run(zero)).toBe(false); // fully transparent pixels are exact too
  });
});
