import { describe, expect, it } from 'vitest';
import { opaqueWhereCovered } from './clip';

const px = (...p: number[]) => new Uint8ClampedArray(p);

describe('opaqueWhereCovered (adjustment blend modes)', () => {
  it('keeps the straight colour at alpha 255 wherever the coverage has alpha, clears the rest', () => {
    const src = px(200, 120, 60, 128, 10, 20, 30, 1, 99, 98, 97, 0);
    const out = new Uint8ClampedArray(src.length);
    opaqueWhereCovered(src, src, out);
    expect(Array.from(out)).toEqual([200, 120, 60, 255, 10, 20, 30, 255, 0, 0, 0, 0]);
  });

  it('takes the coverage from another buffer and works in place (filter output vs backdrop)', () => {
    // Filter output whose alpha differs from the backdrop's: the backdrop decides.
    const out = px(55, 135, 195, 128, 1, 2, 3, 77, 4, 5, 6, 200);
    const backdrop = px(200, 120, 60, 255, 0, 0, 0, 0, 7, 8, 9, 255);
    opaqueWhereCovered(out, backdrop, out);
    expect(Array.from(out)).toEqual([55, 135, 195, 255, 0, 0, 0, 0, 4, 5, 6, 255]);
  });
});
