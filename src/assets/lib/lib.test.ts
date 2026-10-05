/**
 * Pure helpers of the asset library: geometry, words, noise, randomness, keys and sizing.
 * (jsdom has no canvas — everything here is plain math on arrays.)
 */
import { describe, expect, it } from 'vitest';
import {
  arcFractions,
  blob,
  catmullRom,
  dist,
  polylineLength,
  positiveWinding,
  resample,
  rotateAround,
  signedArea,
  spiralPoints,
  spiralStartTangent,
  taperedOutline,
  tornLine,
} from './geom';
import { capitalize, fakeHeadline, fakeSentence, fakeWord } from './words';
import { blurField, fbm2, grainField, ridged2, simplex } from './noise';
import { clamp01, makeRand, smoothstep, unitOf } from './util';
import { fieldDims, normalizeField } from './field';
import { sampleField, worleyAt, worleyGrid } from './raster';
import type { WorleyHit } from './raster';
import { previewSize, stableKey } from './thumbs';
import { presetBox } from './shapes';
import { clampSize, displayName } from './userAssets';
import { parsePayload } from './dnd';

describe('randomness', () => {
  it('is deterministic per seed and independent across seeds', () => {
    const a = makeRand(42);
    const b = makeRand(42);
    const c = makeRand(43);
    const sa = Array.from({ length: 8 }, () => a());
    expect(Array.from({ length: 8 }, () => b())).toEqual(sa);
    expect(Array.from({ length: 8 }, () => c())).not.toEqual(sa);
  });
  it('int() is inclusive and range() stays in bounds', () => {
    const r = makeRand(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
      seen.add(v);
      const f = r.range(-3, 3);
      expect(f).toBeGreaterThanOrEqual(-3);
      expect(f).toBeLessThan(3);
    }
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
  });
  it('fork() yields a reproducible independent stream', () => {
    const x = makeRand(9).fork(3);
    const y = makeRand(9).fork(3);
    const z = makeRand(9).fork(4);
    expect(x()).toBe(y());
    expect(makeRand(9).fork(3)()).not.toBe(z());
  });
});

describe('math helpers', () => {
  it('clamp01 / smoothstep / unitOf', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 3)).toBe(1);
    expect(unitOf(1920, 1080)).toBeCloseTo(1.08);
    expect(unitOf(1, 1)).toBe(0.05);
  });
});

describe('geometry', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  it('measures polylines', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(polylineLength(square)).toBe(30);
    expect(arcFractions(square)).toEqual([0, 1 / 3, 2 / 3, 1]);
  });
  it('resamples at roughly uniform spacing and keeps the end point', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const pts = resample(line, 10);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 0 });
    for (let i = 1; i < pts.length - 1; i++) expect(dist(pts[i - 1], pts[i])).toBeCloseTo(10, 5);
  });
  it('catmullRom passes through its control points', () => {
    const pts = catmullRom(square, 4);
    expect(pts[0]).toEqual(square[0]);
    expect(pts[4].x).toBeCloseTo(square[1].x);
    expect(pts[pts.length - 1]).toEqual(square[3]);
  });
  it('taperedOutline returns both sides with the requested half widths', () => {
    const center = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ];
    const out = taperedOutline(center, [10, 6, 0]);
    expect(out).toHaveLength(6);
    expect(Math.abs(out[0].y - out[5].y)).toBeCloseTo(10);
    expect(Math.abs(out[1].y - out[4].y)).toBeCloseTo(6);
    expect(Math.abs(out[2].y - out[3].y)).toBeCloseTo(0);
  });
  it('spirals shrink towards the end ratio and start on the outer radius', () => {
    const s = { cx: 0, cy: 0, radius: 100, startAngle: 0, turns: 2, dir: 1 as const, endRatio: 0.25 };
    const pts = spiralPoints(s, Math.PI / 16);
    expect(Math.hypot(pts[0].x, pts[0].y)).toBeCloseTo(100);
    expect(Math.hypot(pts[pts.length - 1].x, pts[pts.length - 1].y)).toBeCloseTo(25, 0);
    const t = spiralStartTangent(s);
    expect(Math.hypot(t.x, t.y)).toBeCloseTo(1);
  });
  it('tornLine connects its endpoints deterministically', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 0 };
    const p1 = tornLine(a, b, makeRand(5), 0.1, 3);
    const p2 = tornLine(a, b, makeRand(5), 0.1, 3);
    expect(p1).toEqual(p2);
    expect(p1[0]).toEqual(a);
    expect(p1[p1.length - 1]).toEqual(b);
    expect(p1.length).toBeGreaterThan(30);
  });
  it('winding helpers', () => {
    expect(signedArea(square)).toBe(100);
    const rev = square.slice().reverse();
    expect(signedArea(rev)).toBe(-100);
    expect(signedArea(positiveWinding(rev))).toBe(100);
    expect(positiveWinding(square)).toBe(square);
    const p = rotateAround({ x: 1, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
    expect(blob(0, 0, 10, makeRand(1), 7)).toHaveLength(7);
  });
});

describe('fake newspaper words', () => {
  it('are deterministic and word-like', () => {
    const w1 = Array.from({ length: 50 }, ((r) => () => fakeWord(r))(makeRand(3)));
    const w2 = Array.from({ length: 50 }, ((r) => () => fakeWord(r))(makeRand(3)));
    expect(w1).toEqual(w2);
    for (const w of w1) {
      expect(w).toMatch(/^[a-z]+$/);
      expect(w.length).toBeLessThanOrEqual(13);
    }
  });
  it('sentences start capitalized and end with punctuation', () => {
    const s = fakeSentence(makeRand(11), 12);
    expect(s).toHaveLength(12);
    expect(s[0][0]).toBe(s[0][0].toUpperCase());
    expect(s[s.length - 1]).toMatch(/[.?!]$/);
    expect(capitalize('word')).toBe('Word');
    expect(fakeHeadline(makeRand(2), 3).split(' ')).toHaveLength(3);
  });
});

describe('noise', () => {
  it('simplex is deterministic and roughly in [-1, 1]', () => {
    const n1 = simplex(10);
    const n2 = simplex(10);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const x = i * 0.173;
      const y = i * 0.311;
      const v = n1(x, y);
      expect(v).toBe(n2(x, y));
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThan(-1.05);
    expect(hi).toBeLessThan(1.05);
    expect(hi - lo).toBeGreaterThan(1);
  });
  it('fbm stays normalized and ridged is in [0, 1]', () => {
    const n = simplex(4);
    for (let i = 0; i < 500; i++) {
      const f = fbm2(n, i * 0.21, i * 0.13, 5);
      expect(Math.abs(f)).toBeLessThan(1.05);
      const r = ridged2(n, i * 0.21, i * 0.13, 4);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });
  it('blurField preserves flat fields and smooths spikes', () => {
    const flat = new Float32Array(30 * 20).fill(0.7);
    blurField(flat, 30, 20, 3);
    for (const v of flat) expect(v).toBeCloseTo(0.7, 5);
    const spike = new Float32Array(31 * 31);
    spike[15 * 31 + 15] = 1;
    blurField(spike, 31, 31, 2);
    expect(spike[15 * 31 + 15]).toBeLessThan(0.2);
    expect(spike[15 * 31 + 17]).toBeGreaterThan(0);
  });
  it('grainField is cached, in range and centred on 0.5', () => {
    const g = grainField(77, 64, 1);
    expect(grainField(77, 64, 1)).toBe(g);
    let mean = 0;
    for (const v of g) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      mean += v;
    }
    expect(mean / g.length).toBeCloseTo(0.5, 1);
  });
});

describe('fields and worley', () => {
  it('fieldDims never upscales and respects the sample budget', () => {
    const d = fieldDims(1920, 1080, 100_000);
    expect(d.fw * d.fh).toBeLessThanOrEqual(101_000);
    expect(d.s).toBeLessThan(1);
    expect(fieldDims(100, 100, 100_000)).toEqual({ fw: 100, fh: 100, s: 1 });
  });
  it('normalizeField maps to [0, 1] and sampleField interpolates bilinearly', () => {
    const f = normalizeField(new Float32Array([2, 4, 6, 8]));
    [0, 1 / 3, 2 / 3, 1].forEach((v, i) => expect(f[i]).toBeCloseTo(v, 6));
    expect(sampleField(f, 2, 2, 0.5, 0.5)).toBeCloseTo(0.5);
    expect(sampleField(f, 2, 2, -5, -5)).toBeCloseTo(0);
  });
  it('worley F1 ≤ F2 and the nearest point is the reported one', () => {
    const g = worleyGrid(400, 300, 50, makeRand(3));
    const hit: WorleyHit = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 };
    for (let i = 0; i < 200; i++) {
      const x = (i * 37) % 400;
      const y = (i * 53) % 300;
      worleyAt(g, x, y, hit);
      expect(hit.f1).toBeLessThanOrEqual(hit.f2);
      expect(Math.hypot(hit.cx - x, hit.cy - y)).toBeCloseTo(hit.f1, 4);
    }
  });
});

describe('library helpers', () => {
  it('stableKey ignores key order', () => {
    expect(stableKey({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(stableKey({ b: { d: 'x', c: [1, 2] }, a: 1 }));
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }));
    expect(stableKey(null)).toBe('null');
  });
  it('previewSize fits the longest side', () => {
    expect(previewSize({ sizing: 'document' }, 128, 16 / 9)).toEqual({ width: 128, height: 72 });
    expect(previewSize({ sizing: { width: 520, height: 760 } }, 128)).toEqual({ width: 88, height: 128 });
  });
  it('presetBox is ~30% of the document height and keeps wide presets on canvas', () => {
    expect(presetBox([0, 0, 100, 100], 1920, 1080)).toEqual({ width: 324, height: 324 });
    const wide = presetBox([0, 0, 1000, 100], 1000, 1000);
    expect(wide.width).toBe(900);
    expect(wide.height).toBe(90);
  });
  it('user asset helpers', () => {
    expect(clampSize(8000, 4000)).toEqual({ width: 4096, height: 2048 });
    expect(clampSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(displayName('C:\\Users\\me\\my_team-logo.PNG')).toBe('my team logo');
    expect(displayName('/tmp/.png')).toBe('Image');
    expect(displayName('render.webp')).toBe('render');
  });
  it('parsePayload accepts only well-formed library payloads', () => {
    expect(parsePayload(JSON.stringify({ kind: 'asset', id: 'smoke', params: { seed: 2 } }))).toEqual({ kind: 'asset', id: 'smoke', params: { seed: 2 } });
    expect(parsePayload(JSON.stringify({ kind: 'shape', id: 'star-5' }))).toEqual({ kind: 'shape', id: 'star-5' });
    expect(parsePayload(JSON.stringify({ kind: 'file', id: 'x' }))).toBeNull();
    expect(parsePayload(JSON.stringify({ kind: 'asset' }))).toBeNull();
    expect(parsePayload('not json')).toBeNull();
    expect(parsePayload(null)).toBeNull();
  });
});
