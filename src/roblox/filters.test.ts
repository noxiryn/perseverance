import { describe, expect, it } from 'vitest';
import { rimLightCore, robloxFilters, silhouetteCore, topShadeCore, toonRobloxCore, readToon } from './filters';
import { alphaBounds, blurFloat, distanceToOutside, hexToRgb, luma, makeBuffer, rgbToHexString, sobel, type PixelBuffer } from './pixels';

/** Transparent canvas with an opaque filled rect. */
function subject(w: number, h: number, rect: [number, number, number, number], color: [number, number, number] = [200, 150, 100]): PixelBuffer {
  const img = makeBuffer(w, h, [0, 0, 0, 0]);
  const [x0, y0, rw, rh] = rect;
  for (let y = y0; y < y0 + rh; y++)
    for (let x = x0; x < x0 + rw; x++) {
      const q = (y * w + x) * 4;
      img.data[q] = color[0];
      img.data[q + 1] = color[1];
      img.data[q + 2] = color[2];
      img.data[q + 3] = 255;
    }
  return img;
}

const px = (img: PixelBuffer, x: number, y: number) => {
  const q = (y * img.width + x) * 4;
  return [img.data[q], img.data[q + 1], img.data[q + 2], img.data[q + 3]];
};

describe('pixel helpers', () => {
  it('parses hex colors', () => {
    expect(hexToRgb('#ff8000')).toEqual([255, 128, 0]);
    expect(hexToRgb('#f80')).toEqual([255, 136, 0]);
    expect(hexToRgb('#11223344')).toEqual([17, 34, 51]);
    expect(hexToRgb('garbage')).toEqual([0, 0, 0]);
    expect(rgbToHexString(255, 128.4, -3)).toBe('#ff8000');
  });

  it('computes alpha bounds', () => {
    const img = subject(20, 10, [3, 2, 5, 4]);
    expect(alphaBounds(img)).toEqual({ x0: 3, y0: 2, x1: 7, y1: 5 });
    expect(alphaBounds(makeBuffer(4, 4, [0, 0, 0, 0]))).toBeNull();
  });

  it('distance transform grows toward the inside', () => {
    const w = 11,
      h = 11;
    const inside = new Uint8Array(w * h);
    for (let y = 1; y < 10; y++) for (let x = 1; x < 10; x++) inside[y * w + x] = 1;
    const d = distanceToOutside(inside, w, h);
    expect(d[0]).toBe(0);
    expect(d[1 * w + 1]).toBeCloseTo(1, 5);
    expect(d[5 * w + 5]).toBeCloseTo(5, 5);
    // border counts as outside when requested
    const all = new Uint8Array(w * h).fill(1);
    expect(distanceToOutside(all, w, h, true)[0]).toBe(1);
  });

  it('blurs a float channel preserving the mean', () => {
    const w = 16,
      h = 16;
    const buf = new Float32Array(w * h);
    buf[8 * w + 8] = 256;
    blurFloat(buf, w, h, 4);
    const sum = buf.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(256, 0);
    expect(buf[8 * w + 8]).toBeLessThan(256);
  });

  it('sobel detects a vertical edge', () => {
    const w = 8,
      h = 4;
    const buf = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 4; x < w; x++) buf[y * w + x] = 1;
    const e = sobel(buf, w, h);
    expect(e[1 * w + 4]).toBeGreaterThan(0.5);
    expect(e[1 * w + 1]).toBe(0);
  });
});

describe('roblox filters', () => {
  it('registers the four Roblox filters with the documented param keys', () => {
    const ids = robloxFilters.map((f) => f.id);
    expect(ids).toEqual(['rim-light', 'top-shade', 'silhouette', 'toon-roblox']);
    const keys = (id: string) => robloxFilters.find((f) => f.id === id)!.params.map((p) => p.key);
    expect(keys('rim-light')).toEqual(expect.arrayContaining(['color', 'width', 'angle', 'intensity', 'softness']));
    expect(keys('top-shade')).toEqual(expect.arrayContaining(['color', 'height', 'opacity']));
    expect(keys('silhouette')).toEqual(expect.arrayContaining(['color', 'keepEdges']));
    for (const f of robloxFilters) expect(f.category).toBe('Roblox');
    const rim = robloxFilters[0].params;
    expect(rim.find((p) => p.key === 'width')).toMatchObject({ min: 0, max: 60, default: 12 });
    expect(rim.find((p) => p.key === 'angle')).toMatchObject({ default: 135 });
    expect(rim.find((p) => p.key === 'intensity')).toMatchObject({ default: 0.8 });
  });

  it('rim-light brightens the edge facing the light and leaves the far side', () => {
    const img = subject(40, 40, [10, 10, 20, 20], [60, 60, 60]);
    // light from the right (angle 0)
    rimLightCore(img, { color: '#ff0000', width: 4, angle: 0, intensity: 1, softness: 0.2 });
    const right = px(img, 29, 20);
    const left = px(img, 10, 20);
    const center = px(img, 20, 20);
    expect(right[0]).toBeGreaterThan(150);
    expect(left[0]).toBe(60);
    expect(center[0]).toBe(60);
    // alpha untouched
    expect(right[3]).toBe(255);
    expect(px(img, 2, 2)[3]).toBe(0);
  });

  it('rim-light is a no-op at zero intensity', () => {
    const img = subject(10, 10, [2, 2, 6, 6]);
    const before = Array.from(img.data);
    rimLightCore(img, { color: '#ffffff', width: 5, angle: 45, intensity: 0, softness: 0.5 });
    expect(Array.from(img.data)).toEqual(before);
  });

  it('top-shade darkens the top of the subject only', () => {
    const img = subject(20, 40, [5, 0, 10, 40], [200, 200, 200]);
    topShadeCore(img, { color: '#000000', height: 0.5, opacity: 1, softness: 0.1 });
    expect(px(img, 10, 1)[0]).toBeLessThan(10);
    expect(px(img, 10, 39)[0]).toBe(200);
    // transparent pixels untouched
    expect(px(img, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('silhouette flattens color and keeps alpha', () => {
    const img = subject(10, 10, [2, 2, 6, 6], [250, 10, 10]);
    img.data[3 + (5 * 10 + 5) * 4] = 128;
    silhouetteCore(img, { color: '#102030', keepEdges: 0 });
    expect(px(img, 4, 4)).toEqual([16, 32, 48, 255]);
    expect(px(img, 5, 5)[3]).toBe(128);
    expect(px(img, 0, 0)[3]).toBe(0);
  });

  it('toon-roblox posterizes luminance into the requested number of bands', () => {
    const w = 64,
      h = 4;
    const img = makeBuffer(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const q = (y * w + x) * 4;
        const v = Math.round((x / (w - 1)) * 255);
        img.data.set([v, v, v, 255], q);
      }
    const p = { ...readToon({}), levels: 3, outlineWidth: 0, edges: 0, smooth: 0, shadowStrength: 0 };
    toonRobloxCore(img, p);
    const values = new Set<number>();
    for (let x = 0; x < w; x++) values.add(Math.round(luma(...(px(img, x, 1).slice(0, 3) as [number, number, number])) / 8));
    expect(values.size).toBeLessThanOrEqual(4);
    expect(values.size).toBeGreaterThanOrEqual(3);
  });

  it('toon-roblox draws an inner outline on cut-out subjects', () => {
    const img = subject(30, 30, [5, 5, 20, 20], [220, 220, 220]);
    toonRobloxCore(img, { ...readToon({}), outlineWidth: 2, outlineColor: '#000000', edges: 0, smooth: 0, shadowStrength: 0 });
    expect(px(img, 5, 15)[0]).toBeLessThan(40); // edge pixel inked
    expect(px(img, 15, 15)[0]).toBeGreaterThan(100); // interior keeps its tone
  });
});
