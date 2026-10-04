import { describe, expect, it } from 'vitest';
import {
  CurveSmoother,
  DabSpacer,
  Stabilizer,
  computeDab,
  dabBounds,
  nextBrushSize,
  pressureSizeFactor,
  roundFalloff,
  smoothingRadius,
  type DynamicsSettings,
} from './math';

const base: DynamicsSettings = {
  size: 20,
  flow: 1,
  angle: 0,
  roundness: 1,
  sizeJitter: 0,
  angleJitter: 0,
  scatter: 0,
  opacityJitter: 0,
  pressureSize: false,
  pressureOpacity: false,
  followDirection: false,
};

describe('DabSpacer', () => {
  it('emits a dab at the start and then every `spacing` px', () => {
    const s = new DabSpacer(() => 10);
    expect(s.start({ x: 0, y: 0, pressure: 1 })).toHaveLength(1);
    const dabs = s.lineTo({ x: 35, y: 0, pressure: 1 });
    expect(dabs.map((d) => d.x)).toEqual([10, 20, 30]);
  });

  it('carries leftover distance across segments', () => {
    const s = new DabSpacer(() => 10);
    s.start({ x: 0, y: 0, pressure: 1 });
    const a = s.lineTo({ x: 6, y: 0, pressure: 1 });
    const b = s.lineTo({ x: 12, y: 0, pressure: 1 });
    const c = s.lineTo({ x: 25, y: 0, pressure: 1 });
    expect(a).toHaveLength(0);
    expect(b.map((d) => d.x)).toEqual([10]);
    expect(c.map((d) => d.x)).toEqual([20]);
  });

  it('spaces evenly along diagonal and multi-segment paths', () => {
    const s = new DabSpacer(() => 5);
    s.start({ x: 0, y: 0, pressure: 1 });
    const pts = [
      ...s.lineTo({ x: 3, y: 4, pressure: 1 }), // len 5
      ...s.lineTo({ x: 3, y: 14, pressure: 1 }), // len 10
    ];
    expect(pts).toHaveLength(3);
    expect(pts[0].x).toBeCloseTo(3);
    expect(pts[0].y).toBeCloseTo(4);
    expect(pts[1].y).toBeCloseTo(9);
    expect(pts[2].y).toBeCloseTo(14);
  });

  it('interpolates pressure and uses pressure-dependent spacing', () => {
    const s = new DabSpacer((p) => 2 + 8 * p);
    s.start({ x: 0, y: 0, pressure: 0 });
    const pts = s.lineTo({ x: 100, y: 0, pressure: 1 });
    // pressure grows along the segment
    for (let i = 1; i < pts.length; i++) expect(pts[i].pressure).toBeGreaterThan(pts[i - 1].pressure);
    // gaps grow with pressure
    const gaps = pts.slice(1).map((p, i) => p.x - pts[i].x);
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]);
  });

  it('never emits more dabs than the minimum step allows', () => {
    const s = new DabSpacer(() => 0);
    s.start({ x: 0, y: 0, pressure: 1 });
    expect(s.lineTo({ x: 10, y: 0, pressure: 1 }).length).toBe(20);
  });

  it('reports direction of travel', () => {
    const s = new DabSpacer(() => 1);
    s.start({ x: 0, y: 0, pressure: 1 });
    const pts = s.lineTo({ x: 0, y: 5, pressure: 1 });
    expect(pts[0].direction).toBeCloseTo(Math.PI / 2);
  });
});

describe('CurveSmoother', () => {
  it('starts at the first point and ends at the last after finish()', () => {
    const c = new CurveSmoother(1);
    const out = [
      ...c.push({ x: 0, y: 0, pressure: 1 }),
      ...c.push({ x: 10, y: 0, pressure: 1 }),
      ...c.push({ x: 10, y: 10, pressure: 1 }),
      ...c.finish(),
    ];
    expect(out[0]).toMatchObject({ x: 0, y: 0 });
    expect(out[out.length - 1]).toMatchObject({ x: 10, y: 10 });
    // The corner at (10,0) is rounded off: no output point hits it exactly.
    expect(out.some((p) => p.x === 10 && p.y === 0)).toBe(false);
  });
});

describe('Stabilizer', () => {
  it('passes through when radius is 0', () => {
    const s = new Stabilizer(0);
    expect(s.push({ x: 1, y: 2, pressure: 1 })).toMatchObject({ x: 1, y: 2 });
    expect(s.push({ x: 5, y: 2, pressure: 1 })).toMatchObject({ x: 5, y: 2 });
  });

  it('holds the brush inside the string radius and drags it beyond', () => {
    const s = new Stabilizer(10);
    s.push({ x: 0, y: 0, pressure: 1 });
    expect(s.push({ x: 5, y: 0, pressure: 1 })).toBeNull();
    const p = s.push({ x: 25, y: 0, pressure: 1 });
    expect(p!.x).toBeCloseTo(15);
    expect(s.finish({ x: 25, y: 0, pressure: 1 })).toMatchObject({ x: 25 });
  });

  it('maps smoothing percentage monotonically', () => {
    expect(smoothingRadius(0)).toBe(0);
    expect(smoothingRadius(50)).toBeGreaterThan(0);
    expect(smoothingRadius(100)).toBeGreaterThan(smoothingRadius(50));
  });
});

describe('computeDab', () => {
  const p = { x: 10, y: 20, pressure: 0.5, direction: 0 };

  it('returns the base dab without dynamics', () => {
    const d = computeDab(p, base, () => 0.7);
    expect(d).toMatchObject({ x: 10, y: 20, size: 20, angle: 0, roundness: 1, alpha: 1 });
  });

  it('applies pressure to size and opacity', () => {
    const d = computeDab(p, { ...base, pressureSize: true, pressureOpacity: true, flow: 0.8 }, () => 0);
    expect(d.size).toBeCloseTo(20 * pressureSizeFactor(0.5));
    expect(d.alpha).toBeCloseTo(0.4);
  });

  it('keeps jitter within bounds', () => {
    let seed = 1;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const s = { ...base, sizeJitter: 1, angleJitter: 1, scatter: 1, opacityJitter: 1 };
    for (let i = 0; i < 500; i++) {
      const d = computeDab(p, s, rand);
      expect(d.size).toBeGreaterThanOrEqual(0.5);
      expect(d.size).toBeLessThanOrEqual(20);
      expect(d.angle).toBeGreaterThanOrEqual(-180);
      expect(d.angle).toBeLessThanOrEqual(180);
      expect(d.alpha).toBeGreaterThanOrEqual(0);
      expect(d.alpha).toBeLessThanOrEqual(1);
      expect(Math.abs(d.x - 10)).toBeLessThanOrEqual(2 * 20 * 0.35 + 1e-9);
      expect(Math.abs(d.y - 20)).toBeLessThanOrEqual(2 * 20 + 1e-9);
    }
  });

  it('follows the stroke direction', () => {
    const d = computeDab({ ...p, direction: Math.PI / 2 }, { ...base, followDirection: true, angle: 10 }, () => 0);
    expect(d.angle).toBeCloseTo(100);
  });

  it('computes rotated bounds', () => {
    const b = dabBounds({ x: 0, y: 0, size: 20, angle: 90, roundness: 0.5, alpha: 1 });
    expect(b.width).toBeCloseTo(10 + 2);
    expect(b.height).toBeCloseTo(20 + 2);
  });
});

describe('misc', () => {
  it('steps brush size like Photoshop', () => {
    expect(nextBrushSize(5, 1)).toBe(6);
    expect(nextBrushSize(10, -1)).toBe(9);
    expect(nextBrushSize(60, 1)).toBe(70);
    expect(nextBrushSize(100, -1)).toBe(90);
    expect(nextBrushSize(1, -1)).toBe(1);
  });

  it('falloff is 1 at the center, 0 at the edge and monotonic', () => {
    for (const h of [0, 0.5, 0.9, 1]) {
      expect(roundFalloff(0, h)).toBe(1);
      expect(roundFalloff(1, h)).toBe(0);
      let prev = 1;
      for (let r = 0; r <= 1; r += 0.05) {
        const v = roundFalloff(r, h);
        expect(v).toBeLessThanOrEqual(prev + 1e-9);
        prev = v;
      }
    }
  });
});
