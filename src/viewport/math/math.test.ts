import { describe, expect, it } from 'vitest';
import { about, apply, chain, decompose, fromTransform, invert, isIdentity, mul, rotate, scale, translate } from './affine';
import { polygonArea, traceContours } from './contours';
import { alphaBounds, borderAlpha, colorRangeAlpha, morphAlpha, smoothAlpha, squaredDistanceTransform } from './mask';
import { clampZoom, fitZoom, formatZoom, nextZoomStep, normalizePan, wheelZoomFactor, zoomToRect } from './zoom';
import { boxFromDrag, fitRatio, resizeBox, roundCropRect } from './crop';
import { averageColor, hexToRgb, rgbToHex } from './color';
import { colorRangeWeights } from './colorRange';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('affine', () => {
  it('inverts and multiplies', () => {
    const m = chain(translate(10, -4), rotate(33), scale(2, 0.5));
    expect(isIdentity(mul(m, invert(m)), 1e-9)).toBe(true);
    const p = apply(m, { x: 3, y: 7 });
    const q = apply(invert(m), p);
    close(q.x, 3);
    close(q.y, 7);
  });

  it('rotates about a pivot', () => {
    const m = about({ x: 5, y: 5 }, rotate(90));
    const p = apply(m, { x: 6, y: 5 });
    close(p.x, 5);
    close(p.y, 6);
  });

  it('round-trips layer transforms through decompose (rotation, scale, flip, skew)', () => {
    const cases = [
      { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0 },
      { x: -40, y: 7, scaleX: 2, scaleY: 0.5, rotation: 30, skewX: 0 },
      { x: 3, y: 4, scaleX: -1.5, scaleY: 1.25, rotation: -120, skewX: 0 },
      { x: 0, y: 0, scaleX: 1.2, scaleY: 0.8, rotation: 15, skewX: 20 },
    ];
    for (const t of cases) {
      const m = fromTransform(t, 200, 100);
      const d = decompose(m, 200, 100, t);
      const m2 = fromTransform(d, 200, 100);
      for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) close(m2[k], m[k], 1e-6);
      expect(Math.sign(d.scaleX)).toBe(Math.sign(t.scaleX));
    }
  });
});

describe('contours (marching squares)', () => {
  const mask = (w: number, h: number, fill: (x: number, y: number) => boolean) => {
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y) ? 255 : 0;
    return { data, width: w, height: h, stride: 1, offset: 0 };
  };

  it('outlines a filled square on pixel boundaries', () => {
    const c = traceContours(mask(10, 10, (x, y) => x >= 2 && x < 6 && y >= 3 && y < 8));
    expect(c.length).toBe(1);
    const pts = Array.from(c[0]);
    const xs = pts.filter((_, i) => i % 2 === 0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    // the iso-line passes midway between pixel centers → exactly on pixel edges
    close(Math.min(...xs), 2);
    close(Math.max(...xs), 6);
    close(Math.min(...ys), 3);
    close(Math.max(...ys), 8);
    // collinear points are simplified away (a rectangle with clipped corners has 8 vertices)
    expect(c[0].length / 2).toBeLessThanOrEqual(8);
    close(Math.abs(polygonArea(c[0])), 4 * 5 - 4 * 0.125, 1e-3);
  });

  it('finds separate blobs and holes', () => {
    const two = traceContours(mask(12, 6, (x, y) => y >= 1 && y < 5 && ((x >= 1 && x < 4) || (x >= 7 && x < 11))));
    expect(two.length).toBe(2);
    const ring = traceContours(mask(10, 10, (x, y) => x >= 1 && x < 9 && y >= 1 && y < 9 && !(x >= 4 && x < 6 && y >= 4 && y < 6)));
    expect(ring.length).toBe(2);
  });

  it('respects the origin offset', () => {
    const src = { ...mask(4, 4, () => true), originX: 100, originY: 50 };
    const c = traceContours(src);
    const xs = Array.from(c[0]).filter((_, i) => i % 2 === 0);
    close(Math.min(...xs), 100);
  });
});

describe('mask math', () => {
  const square = (w: number, h: number, x0: number, y0: number, x1: number, y1: number) => {
    const a = new Uint8ClampedArray(w * h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 255;
    return a;
  };

  it('distance transform is exact', () => {
    const f = new Uint8Array(25);
    f[12] = 1; // center of 5×5
    const d = squaredDistanceTransform(f, 5, 5);
    expect(d[12]).toBe(0);
    expect(d[0]).toBe(8);
    expect(d[2]).toBe(4);
  });

  it('expands and contracts by the given radius', () => {
    const a = square(40, 40, 15, 15, 25, 25);
    const grown = alphaBounds(morphAlpha(a, 40, 40, 5), 40, 40, 128)!;
    expect(grown.width).toBe(20);
    const shrunk = alphaBounds(morphAlpha(a, 40, 40, -3), 40, 40, 128)!;
    expect(shrunk.width).toBe(4);
  });

  it('border selects a band around the edge but not the center', () => {
    const a = square(40, 40, 10, 10, 30, 30);
    const b = borderAlpha(a, 40, 40, 4);
    expect(b[20 * 40 + 20]).toBe(0); // center
    expect(b[10 * 40 + 20]).toBeGreaterThan(128); // on the edge
    expect(b[0]).toBe(0);
  });

  it('smooth removes isolated specks', () => {
    const a = square(30, 30, 5, 5, 25, 25);
    a[1 * 30 + 1] = 255; // speck
    const s = smoothAlpha(a, 30, 30, 2);
    expect(s[1 * 30 + 1]).toBe(0);
    expect(s[15 * 30 + 15]).toBe(255);
  });

  it('color range weights fall off with distance', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 250, 10, 10, 255, 0, 0, 255, 255, 255, 0, 0, 0]);
    const w = colorRangeAlpha(rgba, 4, [{ r: 255, g: 0, b: 0 }], 40);
    expect(w[0]).toBe(255);
    expect(w[1]).toBeGreaterThan(200);
    expect(w[2]).toBe(0);
    expect(w[3]).toBe(0); // transparent
  });
});

describe('zoom helpers', () => {
  it('steps through presets', () => {
    expect(nextZoomStep(1, 1)).toBe(1.5);
    expect(nextZoomStep(1, -1)).toBe(0.6667);
    expect(nextZoomStep(0.461, 1)).toBe(0.5);
    expect(nextZoomStep(64, 1)).toBe(64);
    expect(nextZoomStep(0.02, -1)).toBe(0.02);
  });
  it('clamps and formats', () => {
    expect(clampZoom(1000)).toBe(64);
    expect(clampZoom(-1)).toBe(1);
    expect(formatZoom(0.461)).toBe('46.1%');
    expect(formatZoom(2)).toBe('200%');
  });
  it('wheel factor is symmetric', () => {
    close(wheelZoomFactor(100) * wheelZoomFactor(-100), 1);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
  });
  it('fit / fill / zoom to rect', () => {
    close(fitZoom(1000, 500, 1048, 1048, 24, 'fit'), 1);
    close(fitZoom(1000, 500, 1000, 1000, 0, 'fill'), 2);
    const v = zoomToRect({ x: 0, y: 0, width: 100, height: 100 }, 1000, 1000, 400, 400);
    close(v.zoom, 4);
    // rect center (50,50) lands at the viewport center
    const ox = 400 / 2 + v.panX - (1000 * v.zoom) / 2;
    close(ox + 50 * v.zoom, 200);
  });
});

describe('crop math', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  it('resizes from a corner keeping the opposite corner', () => {
    const r = resizeBox(box, 'br', { x: 400, y: 260 }, { ratio: null, fromCenter: false });
    expect(r).toEqual({ x: 100, y: 100, width: 300, height: 160 });
  });
  it('keeps a ratio on corners and sides', () => {
    const r = resizeBox(box, 'br', { x: 500, y: 150 }, { ratio: 2, fromCenter: false });
    close(r.width / r.height, 2);
    expect(r.x).toBe(100);
    const s = resizeBox(box, 'r', { x: 500, y: 0 }, { ratio: 2, fromCenter: false });
    close(s.width, 400);
    close(s.height, 200);
    close(s.y + s.height / 2, 150); // centered vertically
  });
  it('resizes from the center with Alt', () => {
    const r = resizeBox(box, 'r', { x: 350, y: 0 }, { ratio: null, fromCenter: true });
    expect(r.x).toBe(50);
    expect(r.width).toBe(300);
  });
  it('flips when dragged past the anchor', () => {
    const r = resizeBox(box, 'l', { x: 350, y: 0 }, { ratio: null, fromCenter: false });
    expect(r.x).toBe(300);
    expect(r.width).toBe(50);
  });
  it('draws new boxes and fits ratios', () => {
    expect(boxFromDrag({ x: 10, y: 10 }, { x: 0, y: 30 }, { ratio: null, fromCenter: false })).toEqual({ x: 0, y: 10, width: 10, height: 20 });
    const sq = boxFromDrag({ x: 0, y: 0 }, { x: 50, y: 20 }, { ratio: 1, fromCenter: false });
    expect(sq.width).toBe(sq.height);
    const f = fitRatio({ x: 0, y: 0, width: 1920, height: 1080 }, 1);
    expect(f).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
    expect(roundCropRect({ x: 0.4, y: 0.6, width: 10.2, height: 0.1 })).toEqual({ x: 0, y: 1, width: 11, height: 1 });
  });
});

describe('color helpers', () => {
  it('averages with alpha weighting and ignores transparent pixels', () => {
    // 2×1: opaque red, transparent green
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0]);
    expect(averageColor(data, 2, 1, 0, 0, 3)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(averageColor(data, 2, 1, 1, 0, 1)).toBeNull();
    expect(averageColor(data, 2, 1, 5, 0, 1)).toBeNull();
  });
  it('converts hex', () => {
    expect(rgbToHex(255, 128, 0)).toBe('#ff8000');
    expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('nope')).toBeNull();
  });
  it('color range presets', () => {
    const px = new Uint8ClampedArray([230, 20, 20, 255, 20, 20, 230, 255, 250, 250, 250, 255, 10, 10, 10, 255]);
    const reds = colorRangeWeights(px, 4, { preset: 'reds', samples: [], negatives: [], fuzziness: 40, invert: false });
    expect(reds[0]).toBeGreaterThan(200);
    expect(reds[1]).toBe(0);
    const hi = colorRangeWeights(px, 4, { preset: 'highlights', samples: [], negatives: [], fuzziness: 40, invert: false });
    expect(hi[2]).toBe(255);
    expect(hi[3]).toBe(0);
    const sh = colorRangeWeights(px, 4, { preset: 'shadows', samples: [], negatives: [], fuzziness: 40, invert: true });
    expect(sh[3]).toBe(0);
    const neg = colorRangeWeights(px, 4, { preset: 'sampled', samples: [{ r: 230, g: 20, b: 20 }], negatives: [{ r: 230, g: 20, b: 20 }], fuzziness: 40, invert: false });
    expect(neg[0]).toBe(0);
  });
});

describe('view normalization', () => {
  const origin = (v: { zoom: number; panX: number; panY: number }, dw: number, dh: number, W: number, H: number) => ({
    x: W / 2 + v.panX - (dw * v.zoom) / 2,
    y: H / 2 + v.panY - (dh * v.zoom) / 2,
  });

  it('keeps at least 64px of the document on screen', () => {
    // Panned far off to the right/bottom.
    const r = normalizePan({ zoom: 1, panX: 5000, panY: 5000 }, 1000, 800, 1200, 900);
    const o = origin({ zoom: 1, ...r }, 1000, 800, 1200, 900);
    expect(o.x).toBeCloseTo(1200 - 64, 6);
    expect(o.y).toBeCloseTo(900 - 64, 6);
    // Far off to the left/top: the right/bottom doc edge stays 64px inside.
    const l = normalizePan({ zoom: 2, panX: -9000, panY: -9000 }, 1000, 800, 1200, 900);
    const ol = origin({ zoom: 2, ...l }, 1000, 800, 1200, 900);
    expect(ol.x + 2000).toBeCloseTo(64, 6);
    expect(ol.y + 1600).toBeCloseTo(64, 6);
  });

  it('leaves in-range pans alone (apart from device-pixel snapping)', () => {
    const r = normalizePan({ zoom: 0.5, panX: 10, panY: -20 }, 1920, 1080, 1400, 860);
    expect(r.panX).toBeCloseTo(10, 6);
    expect(r.panY).toBeCloseTo(-20, 6);
  });

  it('snaps the document origin to device pixels', () => {
    for (const dpr of [1, 1.5, 2]) {
      const v = { zoom: 0.4137, panX: 3.3, panY: -7.77 };
      const r = normalizePan(v, 1920, 1080, 1301, 857, dpr);
      const o = origin({ zoom: v.zoom, ...r }, 1920, 1080, 1301, 857);
      expect(Math.abs(o.x * dpr - Math.round(o.x * dpr))).toBeLessThan(1e-6);
      expect(Math.abs(o.y * dpr - Math.round(o.y * dpr))).toBeLessThan(1e-6);
    }
  });

  it('small documents use half their size as the visible minimum', () => {
    const r = normalizePan({ zoom: 1, panX: 4000, panY: 0 }, 40, 40, 800, 600);
    const o = origin({ zoom: 1, ...r }, 40, 40, 800, 600);
    expect(o.x).toBeCloseTo(800 - 20, 6);
  });
});
