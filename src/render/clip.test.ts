import { describe, expect, it } from 'vitest';
import { blendAtop } from './clip';

const px = (...v: number[]) => new Uint8ClampedArray(v);

describe('blendAtop (adjustment layers with a blend mode)', () => {
  it('blends the straight colours and keeps the backdrop alpha', () => {
    const back = px(200, 120, 60, 128);
    const src = px(55, 135, 195, 128);
    blendAtop(back, src, 'multiply', src);
    expect(Array.from(src)).toEqual([43, 64, 46, 128]);
  });

  it('clears pixels the backdrop does not cover', () => {
    const out = px(1, 2, 3, 4, 9, 9, 9, 9);
    blendAtop(px(0, 0, 0, 0, 10, 20, 30, 255), px(50, 60, 70, 255, 100, 100, 100, 255), 'screen', out);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 106, 112, 118, 255]);
  });

  it('linear dodge clamps; non-separable modes keep the backdrop luminosity', () => {
    const out = new Uint8ClampedArray(4);
    blendAtop(px(200, 10, 0, 255), px(100, 20, 0, 0), 'linear-dodge', out);
    expect(Array.from(out)).toEqual([255, 30, 0, 255]);
    blendAtop(px(128, 128, 128, 200), px(255, 0, 0, 255), 'color', out);
    expect(Array.from(out)).toEqual([255, 74, 74, 200]);
    blendAtop(px(128, 128, 128, 200), px(255, 0, 0, 255), 'luminosity', out);
    expect(Array.from(out)).toEqual([77, 77, 77, 200]);
  });
});
