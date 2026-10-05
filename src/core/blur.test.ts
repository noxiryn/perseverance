import { describe, expect, it } from 'vitest';
import { boxBlurImageData, blurChannel } from './blur';

function flat(w: number, h: number, v: number) {
  const data = new Uint8ClampedArray(w * h * 4).fill(v);
  return { data, width: w, height: h, colorSpace: 'srgb' } as unknown as ImageData;
}

describe('blur helpers', () => {
  it('boxBlurImageData keeps a flat image flat', () => {
    const img = boxBlurImageData(flat(32, 20, 100), 4);
    for (const v of img.data) expect(v).toBe(100);
  });

  it('blurChannel keeps a constant buffer constant', () => {
    const buf = new Float32Array(24 * 16).fill(1);
    blurChannel(buf, 24, 16, 3);
    for (const v of buf) expect(v).toBeCloseTo(1, 5);
  });

  it('boxBlurImageData spreads a single bright pixel and preserves total energy approximately', () => {
    const w = 21,
      h = 21;
    const img = flat(w, h, 0);
    const c = (10 * w + 10) * 4;
    img.data[c] = 255;
    boxBlurImageData(img, 2);
    let sum = 0;
    for (let i = 0; i < img.data.length; i += 4) sum += img.data[i];
    expect(img.data[c]).toBeLessThan(255);
    expect(sum).toBeGreaterThan(150);
    expect(sum).toBeLessThan(360);
  });
});
