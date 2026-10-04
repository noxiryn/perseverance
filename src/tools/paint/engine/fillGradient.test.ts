import { describe, expect, it } from 'vitest';
import { floodMask, maskToAlpha } from './fill';
import { LUT_SIZE, buildLUT, gradientT, renderGradientPixels } from './gradient';

function img(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fn(x, y), (y * w + x) * 4);
  return d;
}

describe('floodMask', () => {
  // A 10×10 white image with a black vertical wall at x=5.
  const src = img(10, 10, (x) => (x === 5 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

  it('contiguous fill stops at the wall', () => {
    const r = floodMask(src, 10, 10, 1, 1, 10, true);
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 5, height: 10 });
    expect(r.mask[7]).toBe(0);
  });

  it('non-contiguous fill selects every matching pixel', () => {
    const r = floodMask(src, 10, 10, 1, 1, 10, false);
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(r.mask[5]).toBe(0);
    expect(r.mask[7]).toBe(255);
  });

  it('tolerance includes similar colors', () => {
    const g = img(4, 1, (x) => [100 + x * 10, 100, 100, 255]);
    expect(floodMask(g, 4, 1, 0, 0, 5, true).bounds!.width).toBe(1);
    expect(floodMask(g, 4, 1, 0, 0, 25, true).bounds!.width).toBe(3);
  });

  it('treats all transparent pixels as equal', () => {
    const t = img(4, 1, (x) => [x * 60, 0, 0, 0]);
    expect(floodMask(t, 4, 1, 0, 0, 0, true).bounds!.width).toBe(4);
  });

  it('handles fills larger than the initial stack', () => {
    const big = img(300, 300, (x, y) => ((x * 7 + y * 3) % 11 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const r = floodMask(big, 300, 300, 1, 1, 0, true);
    expect(r.bounds).not.toBeNull();
  });

  it('anti-aliased alpha softens edges and grows bounds by 1px', () => {
    const r = floodMask(src, 10, 10, 1, 1, 10, true);
    const a = maskToAlpha(r, 10, 10, true)!;
    expect(a.rect.width).toBe(6);
    // interior solid, outside the wall partially covered
    expect(a.alpha[2 * a.rect.width + 1]).toBe(255);
    expect(a.alpha[2 * a.rect.width + 5]).toBeGreaterThan(0);
    expect(a.alpha[2 * a.rect.width + 5]).toBeLessThan(255);
  });
});

describe('gradient', () => {
  it('computes t for every kind', () => {
    expect(gradientT('linear', 50, 0, 0, 0, 100, 0)).toBeCloseTo(0.5);
    expect(gradientT('linear', -10, 0, 0, 0, 100, 0)).toBe(0);
    expect(gradientT('reflected', -50, 0, 0, 0, 100, 0)).toBeCloseTo(0.5);
    expect(gradientT('radial', 0, 50, 0, 0, 100, 0)).toBeCloseTo(0.5);
    expect(gradientT('diamond', 25, 25, 0, 0, 100, 0)).toBeCloseTo(0.5);
    const a = gradientT('angle', 0, -10, 0, 0, 10, 0);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });

  it('builds a LUT with endpoints and reverse', () => {
    const stops = [
      { offset: 0, color: '#000000' },
      { offset: 1, color: '#ffffff' },
    ];
    const lut = buildLUT(stops);
    expect(lut[0]).toBe(0);
    expect(lut[(LUT_SIZE - 1) * 4]).toBe(255);
    const rev = buildLUT(stops, true);
    expect(rev[0]).toBe(255);
    const transp = buildLUT([
      { offset: 0, color: '#ff000000' },
      { offset: 1, color: '#ff0000ff' },
    ]);
    expect(transp[3]).toBe(0);
    expect(buildLUT([{ offset: 0, color: '#ff000000' }], false, false)[3]).toBe(255);
  });

  it('renders pixels through a transform', () => {
    const lut = buildLUT([
      { offset: 0, color: '#000000' },
      { offset: 1, color: '#ffffff' },
    ]);
    const out = new Uint8ClampedArray(10 * 1 * 4);
    renderGradientPixels(out, 10, 1, 0, 0, 1, null, { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, lut, dither: false });
    expect(out[0]).toBeLessThan(out[9 * 4]);
    // Local pixels shifted by +100 in doc space → all past the end → white.
    renderGradientPixels(out, 10, 1, 0, 0, 1, { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 }, { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, lut, dither: false });
    expect(out[0]).toBe(255);
  });
});
