import { describe, expect, it } from 'vitest';
import { unknockAlpha } from './pixelMath';

const px = (...rgba: number[][]) => Uint8ClampedArray.from(rgba.flat());

describe('unknockAlpha', () => {
  it('restores alpha removed by a partly transparent cover', () => {
    // A 200-alpha piece under a 50% cover was knocked out to 100.
    const pieces = px([10, 20, 30, 100]);
    unknockAlpha(pieces, px([0, 0, 0, 128]));
    expect(pieces[3]).toBeGreaterThanOrEqual(198);
    expect(pieces[3]).toBeLessThanOrEqual(202);
    expect([...pieces.slice(0, 3)]).toEqual([10, 20, 30]);
  });

  it('leaves pixels without cover, under an opaque cover, and empty pixels unchanged', () => {
    const pieces = px([1, 2, 3, 77], [4, 5, 6, 0], [7, 8, 9, 0]);
    unknockAlpha(pieces, px([0, 0, 0, 0], [0, 0, 0, 255], [0, 0, 0, 100]));
    expect([...pieces]).toEqual([1, 2, 3, 77, 4, 5, 6, 0, 7, 8, 9, 0]);
  });

  it('never exceeds full opacity', () => {
    const pieces = px([0, 0, 0, 250]);
    unknockAlpha(pieces, px([0, 0, 0, 200]));
    expect(pieces[3]).toBe(255);
  });
});
