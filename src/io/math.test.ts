import { describe, expect, it } from 'vitest';
import type { Transform } from '../core/types';
import {
  anchorFractions,
  canvasSizeOffset,
  clampRect,
  distanceTo,
  fitRect,
  formatBytes,
  fromPsdBlend,
  opBakedTransform,
  opDocSize,
  opMapPoint,
  opTransform,
  pushRecent,
  safeFileName,
  scaleTransform,
  strokeCoverage,
  toPsdBlend,
  trimBounds,
  withExtension,
  type CanvasOp,
} from './math';

/* Minimal affine helper mirroring core/geometry transformMatrix (jsdom has no DOMMatrix). */
type M = [number, number, number, number, number, number]; // a b c d e f
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const T = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const R = (deg: number): M => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
const K = (deg: number): M => [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
const S = (x: number, y: number): M => [x, 0, 0, y, 0, 0];
const matrix = (t: Transform, w: number, h: number) =>
  [T(t.x + w / 2, t.y + h / 2), R(t.rotation), K(t.skewX ?? 0), S(t.scaleX, t.scaleY), T(-w / 2, -h / 2)].reduce(mul);
const apply = (m: M, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/** Pixel mapping of a local point when a w×h bitmap is rotated/flipped like the canvas. */
const localMap = (op: CanvasOp, u: number, v: number, w: number, h: number) => opMapPoint(op, u, v, w, h);

const ops: CanvasOp[] = ['rotate90cw', 'rotate90ccw', 'rotate180', 'flipH', 'flipV'];
const samples: Transform[] = [
  { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0 },
  { x: 120, y: -40, scaleX: 1.5, scaleY: 0.75, rotation: 30, skewX: 0 },
  { x: -10, y: 300, scaleX: -1, scaleY: 2, rotation: -135, skewX: 12 },
];

describe('canvas rotate/flip transforms', () => {
  const W = 800,
    H = 500,
    w = 200,
    h = 120;
  for (const op of ops)
    for (const [si, t] of samples.entries())
      it(`${op} keeps content in place (transform only, sample ${si})`, () => {
        const before = matrix(t, w, h);
        const after = matrix(opTransform(op, t, w, h, W, H), w, h);
        for (const [u, v] of [
          [0, 0],
          [w, 0],
          [w, h],
          [0, h],
          [37, 81],
        ]) {
          const p = apply(before, u, v);
          const expected = opMapPoint(op, p.x, p.y, W, H);
          const got = apply(after, u, v);
          expect(got.x).toBeCloseTo(expected.x, 6);
          expect(got.y).toBeCloseTo(expected.y, 6);
        }
      });

  for (const op of ops)
    for (const [si, t] of samples.entries())
      it(`${op} baked raster transform matches (sample ${si})`, () => {
        const baked = opBakedTransform(op, t, w, h, W, H);
        if (!baked) {
          expect(t.skewX && (op === 'rotate90cw' || op === 'rotate90ccw')).toBeTruthy();
          return;
        }
        const before = matrix(t, w, h);
        const after = matrix(baked.transform, baked.width, baked.height);
        for (const [u, v] of [
          [0, 0],
          [w, 0],
          [w, h],
          [0, h],
          [37, 81],
        ]) {
          const p = apply(before, u, v);
          const expected = opMapPoint(op, p.x, p.y, W, H);
          const l = localMap(op, u, v, w, h);
          const got = apply(after, l.x, l.y);
          expect(got.x).toBeCloseTo(expected.x, 6);
          expect(got.y).toBeCloseTo(expected.y, 6);
        }
      });

  it('doc size swaps for 90° turns', () => {
    expect(opDocSize('rotate90cw', 10, 20)).toEqual({ width: 20, height: 10 });
    expect(opDocSize('flipH', 10, 20)).toEqual({ width: 10, height: 20 });
  });
});

describe('image size / canvas size', () => {
  it('scaleTransform scales positions and size about the doc origin', () => {
    const t: Transform = { x: 100, y: 50, scaleX: 1, scaleY: 1, rotation: 20, skewX: 0 };
    const out = scaleTransform(t, 40, 20, 2, 0.5);
    const before = matrix(t, 40, 20);
    const after = matrix(out, 40, 20);
    const c0 = apply(before, 20, 10);
    const c1 = apply(after, 20, 10);
    expect(c1.x).toBeCloseTo(c0.x * 2);
    expect(c1.y).toBeCloseTo(c0.y * 0.5);
    expect(out.scaleX).toBe(2);
    expect(out.scaleY).toBe(0.5);
  });

  it('anchors', () => {
    expect(anchorFractions(0)).toEqual({ ax: 0, ay: 0 });
    expect(anchorFractions(4)).toEqual({ ax: 0.5, ay: 0.5 });
    expect(anchorFractions(8)).toEqual({ ax: 1, ay: 1 });
    expect(canvasSizeOffset(100, 100, 200, 140, 4)).toEqual({ dx: 50, dy: 20 });
    expect(canvasSizeOffset(100, 100, 50, 50, 8)).toEqual({ dx: -50, dy: -50 });
    expect(canvasSizeOffset(100, 100, 300, 300, 0)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('export helpers', () => {
  it('fitRect cover/fit', () => {
    const cover = fitRect(1920, 1080, 512, 512, 'cover');
    expect(cover.height).toBeCloseTo(512);
    expect(cover.width).toBeGreaterThan(512);
    expect(cover.x).toBeCloseTo((512 - cover.width) / 2);
    const fit = fitRect(1920, 1080, 512, 512, 'fit');
    expect(fit.width).toBeCloseTo(512);
    expect(fit.y).toBeCloseTo((512 - 288) / 2);
  });
  it('formats bytes and names', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
    expect(safeFileName('a/b:c*?"<>|d')).toBe('a_b_c_d');
    expect(safeFileName('   ')).toBe('Untitled');
    expect(withExtension('My Thumb.pgfx', 'png')).toBe('My Thumb.png');
    expect(withExtension('Icon', 'jpg')).toBe('Icon.jpg');
  });
});

describe('trimBounds', () => {
  const img = (w: number, h: number, fill: (x: number, y: number) => number[]) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4);
    return { data, width: w, height: h };
  };
  it('transparent', () => {
    const b = img(10, 8, (x, y) => (x >= 2 && x <= 6 && y >= 3 && y <= 4 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    expect(trimBounds(b, 'transparent')).toEqual({ x: 2, y: 3, width: 5, height: 2 });
    expect(trimBounds(b, 'transparent', undefined, { top: true, bottom: false, left: true, right: false })).toEqual({ x: 2, y: 3, width: 8, height: 5 });
    expect(trimBounds(img(3, 3, () => [0, 0, 0, 0]), 'transparent')).toBeNull();
  });
  it('color', () => {
    const b = img(6, 6, (x, y) => (x === 4 && y === 1 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    expect(trimBounds(b, 'color', [255, 255, 255, 255])).toEqual({ x: 4, y: 1, width: 1, height: 1 });
  });
});

describe('psd blend modes', () => {
  it('maps both ways', () => {
    expect(toPsdBlend('color-dodge')).toBe('color dodge');
    expect(toPsdBlend('pass-through')).toBe('pass through');
    expect(toPsdBlend('normal')).toBe('normal');
    expect(fromPsdBlend('soft light')).toBe('soft-light');
    expect(fromPsdBlend('pass through', true)).toBe('pass-through');
    expect(fromPsdBlend('pass through', false)).toBe('normal');
    expect(fromPsdBlend('linear burn')).toBe('multiply');
    expect(fromPsdBlend('weird')).toBe('normal');
    expect(fromPsdBlend(undefined, true)).toBe('pass-through');
  });
});

describe('distance field & stroke', () => {
  it('distanceTo is euclidean', () => {
    const w = 7,
      h = 5;
    const inside = new Uint8Array(w * h);
    inside[2 * w + 3] = 1;
    const d = distanceTo(inside, w, h);
    expect(d[2 * w + 3]).toBe(0);
    expect(d[2 * w + 4]).toBeCloseTo(1);
    expect(d[0]).toBeCloseTo(Math.hypot(3, 2));
  });
  it('strokeCoverage outside/inside/center', () => {
    const w = 20,
      h = 20;
    const a = new Uint8Array(w * h);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) a[y * w + x] = 255;
    const out = strokeCoverage(a, w, h, 2, 'outside');
    expect(out[10 * w + 4]).toBe(255); // 1px outside
    expect(out[10 * w + 3]).toBe(255); // 2px outside
    expect(out[10 * w + 2]).toBe(0);
    expect(out[10 * w + 5]).toBe(0); // inside untouched
    const ins = strokeCoverage(a, w, h, 2, 'inside');
    expect(ins[10 * w + 5]).toBe(255);
    expect(ins[10 * w + 6]).toBe(255);
    expect(ins[10 * w + 7]).toBe(0);
    expect(ins[10 * w + 4]).toBe(0);
    const c = strokeCoverage(a, w, h, 2, 'center');
    expect(c[10 * w + 4]).toBe(255);
    expect(c[10 * w + 5]).toBe(255);
    expect(c[10 * w + 3]).toBe(0);
  });
});

describe('misc', () => {
  it('pushRecent dedupes and caps', () => {
    let l = [] as { path: string; name: string; time: number }[];
    for (let i = 0; i < 15; i++) l = pushRecent(l, { path: `C:\\f${i}.pgfx`, name: `f${i}`, time: i });
    expect(l.length).toBe(12);
    l = pushRecent(l, { path: 'c:/F3.pgfx', name: 'f3', time: 99 });
    expect(l[0].time).toBe(99);
    expect(l.filter((e) => e.name === 'f3').length).toBe(1);
  });
  it('clampRect', () => {
    expect(clampRect({ x: -5.5, y: 2.2, width: 10, height: 100 }, 50, 50)).toEqual({ x: 0, y: 2, width: 5, height: 48 });
    expect(clampRect({ x: 60, y: 0, width: 10, height: 10 }, 50, 50)).toBeNull();
  });
});
