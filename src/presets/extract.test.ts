import { describe, expect, it } from 'vitest';
import { extractPalette, kmeans, medianCut, samplePixels, type PixelSource } from './extract';

/** Image made of horizontal bands of solid colors. */
function bands(colors: [number, number, number, number?][], w = 40, hPer = 10): PixelSource {
  const h = hPer * colors.length;
  const data = new Uint8ClampedArray(w * h * 4);
  colors.forEach(([r, g, b, a = 255], i) => {
    for (let y = i * hPer; y < (i + 1) * hPer; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = a;
      }
  });
  return { data, width: w, height: h };
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

describe('samplePixels', () => {
  it('skips transparent pixels', () => {
    const img = bands([
      [255, 0, 0],
      [0, 255, 0, 0],
    ]);
    const px = samplePixels(img);
    expect(px.length / 3).toBe(400);
    for (let i = 0; i < px.length; i += 3) expect(px[i]).toBe(255);
  });
});

describe('palette extraction', () => {
  const four: [number, number, number][] = [
    [200, 20, 30],
    [20, 40, 200],
    [240, 220, 40],
    [10, 10, 10],
  ];

  it('k-means recovers distinct flat colors', () => {
    const out = kmeans(samplePixels(bands(four)), 4);
    const got = out.map((c) => c.color).sort();
    expect(got).toEqual(four.map(([r, g, b]) => hex(r, g, b)).sort());
    expect(out.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 5);
  });

  it('median cut recovers distinct flat colors', () => {
    const out = medianCut(samplePixels(bands(four)), 4);
    expect(out.map((c) => c.color).sort()).toEqual(four.map(([r, g, b]) => hex(r, g, b)).sort());
  });

  it('is deterministic and sorted dark → light', () => {
    const img = bands([...four, [128, 128, 128], [250, 250, 250]]);
    const a = extractPalette(img, 6, 'kmeans');
    const b = extractPalette(img, 6, 'kmeans');
    expect(a).toEqual(b);
    const lum = (h: string) => {
      const v = parseInt(h.slice(1), 16);
      return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
    };
    for (let i = 1; i < a.length; i++) expect(lum(a[i].color)).toBeGreaterThanOrEqual(lum(a[i - 1].color));
  });

  it('merges near-duplicates for flat images', () => {
    const out = extractPalette(bands([[90, 90, 90]]), 8, 'median-cut');
    expect(out).toHaveLength(1);
    expect(out[0].color).toBe('#5a5a5a');
  });

  it('handles empty / fully transparent images', () => {
    expect(extractPalette(bands([[0, 0, 0, 0]]), 6)).toEqual([]);
    expect(kmeans(new Float32Array(0), 5)).toEqual([]);
    expect(medianCut(new Float32Array(0), 5)).toEqual([]);
  });
});
