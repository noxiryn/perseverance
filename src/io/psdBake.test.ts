import { describe, expect, it } from 'vitest';
import { SOFT_EDGE_LEVELS, SOFT_EDGE_MIN_PIXELS, alphaChannel, finishBakedPixels, finishClippedBake } from './psdBake';

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
function bakeOne(ba: number, f: [number, number, number]): Px {
  const data = new Uint8ClampedArray([f[0], f[1], f[2], ba]);
  finishBakedPixels(data, alphaChannel(data), 1);
  return [data[0], data[1], data[2], data[3] / 255];
}

/** Run finishClippedBake on one pixel: stack G (alpha 0..255), filtered colour `f`, coverage, share. */
function clipBakeOne(g: [number, number, number, number], f: [number, number, number], cover: number, share: number | null): Px {
  const data = new Uint8ClampedArray([f[0], f[1], f[2], g[3]]);
  finishClippedBake(data, new Uint8ClampedArray(g), new Uint8Array([cover]), share === null ? null : new Uint8Array([share]), 1);
  return [data[0], data[1], data[2], data[3] / 255];
}

/**
 * A clip stack, premultiplied [r·a, g·a, b·a, a] (a in 0..1) after the coverage A (0..1):
 *  - ours: the adjustment mixes F into the stack G (keeping G's alpha), then the coverage applies;
 *  - baked: the baked pixel P, limited to the share s, source-over onto G at strength m, then the
 *    coverage (what the compositor — and Photoshop's clipping — do with a clipped pixel layer).
 */
function clipOurs(G: Px, F: [number, number, number], m: number, A: number): Px {
  const c = (i: number) => A * G[3] * ((1 - m) * G[i] + m * F[i]);
  return [c(0), c(1), c(2), A * G[3]];
}
function clipBaked(G: Px, P: Px, m: number, A: number, s: number): Px {
  const k = m * s * P[3];
  const c = (i: number) => A * (k * P[i] + (1 - k) * G[3] * G[i]);
  return [c(0), c(1), c(2), A * (k + (1 - k) * G[3])];
}

const close = (a: Px, b: Px) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('baked PSD adjustments', () => {
  it('clipped: the filtered stack at full alpha re-composites exactly over an opaque stack, at any coverage', () => {
    const F: [number, number, number] = [30, 160, 220];
    const G: Px = [200, 40, 90, 1];
    // Soft base edges (coverage < 1), whatever is drawn below the stack (behind-stage effects).
    for (const A of [255, 200, 128, 40, 1]) {
      const baked = clipBakeOne([200, 40, 90, 255], F, A, null);
      expect(baked[3]).toBe(1);
      for (const m of [1, 0.7, 0.25]) close(clipBaked(G, baked, m, A / 255, 1), clipOurs(G, F, m, A / 255));
    }
    // No coverage, or an empty stack: nothing baked (and nothing to show).
    expect(clipBakeOne([200, 40, 90, 255], F, 0, null)[3]).toBe(0);
    expect(clipBakeOne([0, 0, 0, 0], F, 255, null)[3]).toBe(0);
    // Photoshop keeps the stack's coverage when compositing a clipped layer (the older model).
    for (const m of [1, 0.4]) close(psClipped(G, clipBakeOne([200, 40, 90, 255], F, 255, null), m), ours(G, [...F, 1], m));
  });

  it('clipped: the documented error formula matches a per-pixel simulation', () => {
    const F: [number, number, number] = [30, 160, 220];
    for (const ag of [255, 200, 128, 30]) {
      for (const A of [255, 140]) {
        for (const sh of [255, 180, 60]) {
          for (const m of [1, 0.5]) {
            const G: Px = [200, 40, 90, ag / 255];
            const P = clipBakeOne([200, 40, 90, ag], F, A, sh);
            const a = clipOurs(G, F, m, A / 255);
            const b = clipBaked(G, P, m, A / 255, sh / 255);
            const s = sh / 255;
            const g = ag / 255;
            for (let i = 0; i < 3; i++) expect(Math.abs(b[i] - a[i])).toBeCloseTo((A / 255) * m * Math.abs((s - g) * F[i] + g * (1 - s) * G[i]), 6);
            expect(b[3] - a[3]).toBeCloseTo((A / 255) * m * s * (1 - g), 9);
          }
        }
      }
    }
  });

  it('unclipped: exact over opaque pixels, denser over semi-transparent ones', () => {
    const filtered: [number, number, number] = [30, 160, 220];
    const opaque: Px = [200, 40, 90, 1];
    close(psOver(opaque, bakeOne(255, filtered), 0.6), ours(opaque, [...filtered, 1], 0.6));
    const soft: Px = [200, 40, 90, 0.5];
    const baked = bakeOne(128, filtered);
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
    const run = (d: Uint8ClampedArray, opacity = 1) => finishBakedPixels(d, alphaChannel(d), opacity);
    expect(run(make(0))).toBe(false); // opaque backdrop
    expect(run(make(SOFT_EDGE_MIN_PIXELS - 1))).toBe(false); // a few stray pixels
    expect(run(make(SOFT_EDGE_MIN_PIXELS))).toBe(true);
    expect(run(make(200, 2))).toBe(false); // nearly transparent: under the error threshold
    expect(run(make(200), 0.05)).toBe(false); // a faint layer can't be far off
    const zero = make(200, 0);
    expect(run(zero)).toBe(false); // fully transparent pixels are exact too
  });

  it('flags a clipped bake only where the stack is not opaque or the share is partial, over enough pixels', () => {
    const n = 256;
    /** Stack of n pixels: the first `k` get alpha `ag`, the rest are opaque. */
    const stack = (k: number, ag: number, rgb: [number, number, number] = [200, 40, 90]) => {
      const d = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) d.set([...rgb, i < k ? ag : 255], i * 4);
      return d;
    };
    const filtered = (G: Uint8ClampedArray, rgb: [number, number, number] = [30, 160, 220]) => {
      const d = new Uint8ClampedArray(G.length);
      for (let i = 0; i < n; i++) d.set([...rgb, G[i * 4 + 3]], i * 4);
      return d;
    };
    const cover = (v: number) => new Uint8Array(n).fill(v);
    const run = (G: Uint8ClampedArray, A: Uint8Array, share: Uint8Array | null = null, m = 1) => finishClippedBake(filtered(G), G, A, share, m);
    // Opaque stack: exact at any coverage (soft base edges, behind-stage effects below).
    expect(run(stack(0, 255), cover(255))).toBe(false);
    expect(run(stack(0, 255), cover(90))).toBe(false);
    // A base at 50% Fill: Photoshop shows the baked layer denser.
    expect(run(stack(n, 128), cover(255))).toBe(true);
    expect(run(stack(n, 128), cover(255), null, 0.05)).toBe(false); // faint: under SOFT_EDGE_LEVELS
    expect(run(stack(SOFT_EDGE_MIN_PIXELS - 1, 128), cover(255))).toBe(false); // a few stray pixels
    expect(run(stack(n, 128), cover(10))).toBe(false); // barely covered: the error is scaled by the coverage
    expect(run(stack(n, 0), cover(255))).toBe(false); // empty stack (0% Fill, nothing clipped): nothing baked
    // An above-stage effect reaching beyond the content (share < 1): off by m·(1 − s)·|G − F|…
    expect(run(stack(0, 255), cover(255), cover(128))).toBe(true);
    // …which vanishes when the filter leaves the colour alone there.
    const G = stack(0, 255, [30, 160, 220]);
    expect(finishClippedBake(filtered(G), G, cover(255), cover(128), 1)).toBe(false);
    // Below the threshold: 255 · m · (1 − s) · |ΔC| ≤ SOFT_EDGE_LEVELS.
    const tiny = stack(0, 255, [30 + SOFT_EDGE_LEVELS, 160, 220]);
    expect(finishClippedBake(filtered(tiny), tiny, cover(255), cover(0), 1)).toBe(false);
  });
});
