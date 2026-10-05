import { describe, expect, it } from 'vitest';
import { opaqueWhereCovered, splitAtShape } from './clip';

/** RGBA pixels from [r, g, b, a] tuples. */
const px = (...p: number[][]) => new Uint8ClampedArray(p.flat());

describe('layer effects: normalized core', () => {
  it('makes the content opaque inside its shape, in place', () => {
    const c = px([128, 128, 128, 128], [10, 20, 30, 255], [99, 99, 99, 0]);
    opaqueWhereCovered(c, c, c);
    expect(Array.from(c)).toEqual([128, 128, 128, 255, 10, 20, 30, 255, 0, 0, 0, 0]);
  });

  it('splits a core at the shape: normalized part inside, the rest beyond', () => {
    const core = px(
      [200, 0, 0, 64], // inside a 50% shape pixel: normalized to ~50%, nothing beyond
      [0, 200, 0, 204], // above a 50% shape pixel (emboss over a soft edge): opaque, 76 beyond
      [0, 0, 200, 255], // outside the shape: all beyond
      [5, 5, 5, 255], // inside an opaque shape pixel: unchanged
      [0, 0, 0, 0], // empty
    );
    const shape = px([1, 1, 1, 128], [1, 1, 1, 128], [0, 0, 0, 0], [1, 1, 1, 255], [1, 1, 1, 255]);
    const ext = new Uint8ClampedArray(core.length).fill(7);
    expect(splitAtShape(core, shape, ext)).toBe(true);
    expect(Array.from(core)).toEqual([200, 0, 0, 128, 0, 200, 0, 255, 0, 0, 0, 0, 5, 5, 5, 255, 0, 0, 0, 0]);
    expect(Array.from(ext)).toEqual([0, 0, 0, 0, 0, 200, 0, 76, 0, 0, 200, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('keeps the coverage: normalized part × shape alpha + part beyond = core alpha', () => {
    for (let ak = 0; ak < 256; ak += 5)
      for (let as = 0; as < 256; as += 5) {
        const core = px([9, 9, 9, ak]);
        const ext = new Uint8ClampedArray(4);
        const beyond = splitAtShape(core, px([0, 0, 0, as]), ext);
        expect(beyond).toBe(ak > as);
        // ±1: the normalized alpha is rounded to 8 bits.
        expect(Math.abs((core[3] * as) / 255 + ext[3] - ak)).toBeLessThanOrEqual(1);
        expect(core[3] <= 255 && ext[3] <= ak).toBe(true);
      }
  });

  it('reports no part beyond when the core stays inside the shape', () => {
    const core = px([1, 2, 3, 100], [4, 5, 6, 0]);
    const ext = new Uint8ClampedArray(core.length);
    expect(splitAtShape(core, px([0, 0, 0, 200], [0, 0, 0, 0]), ext)).toBe(false);
    expect(Array.from(ext)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
