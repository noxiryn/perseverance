import { describe, expect, it } from 'vitest';
import { normalizeCore } from './clip';

const px = (...v: number[]) => new Uint8ClampedArray(v);

describe('normalizeCore', () => {
  it('makes the core opaque wherever it covers the content (no shape: the core is the content)', () => {
    const core = px(200, 100, 50, 128, 9, 9, 9, 0, 10, 20, 30, 255);
    expect(normalizeCore(core, null, null)).toBe(false);
    expect([...core]).toEqual([200, 100, 50, 255, 0, 0, 0, 0, 10, 20, 30, 255]);
  });

  it('scales the normalized alpha by k (a core that is the content at that fill)', () => {
    const core = px(200, 100, 50, 128, 1, 2, 3, 0);
    normalizeCore(core, null, null, 0.5);
    expect([...core]).toEqual([200, 100, 50, 128, 0, 0, 0, 0]);
    const empty = px(200, 100, 50, 128);
    normalizeCore(empty, null, null, 0);
    expect(empty[3]).toBe(0);
  });

  it('divides the core by the shape and moves coverage beyond it to ext', () => {
    // 1: core = half the shape; 2: core beyond the shape (centre stroke over a soft edge);
    // 3: core outside the content (shape empty); 4: nothing.
    const core = px(10, 20, 30, 64, 40, 50, 60, 200, 70, 80, 90, 100, 1, 1, 1, 0);
    const shape = px(0, 0, 0, 128, 0, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 50);
    const ext = new Uint8ClampedArray(16);
    expect(normalizeCore(core, shape, ext)).toBe(true);
    expect([...core]).toEqual([10, 20, 30, 128, 40, 50, 60, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...ext]).toEqual([0, 0, 0, 0, 40, 50, 60, 72, 70, 80, 90, 100, 0, 0, 0, 0]);
  });

  it('reports no excess when the core stays within the shape', () => {
    const core = px(10, 20, 30, 128);
    const ext = new Uint8ClampedArray(4);
    expect(normalizeCore(core, px(0, 0, 0, 128), ext)).toBe(false);
    expect([...core]).toEqual([10, 20, 30, 255]);
    expect([...ext]).toEqual([0, 0, 0, 0]);
  });
});
