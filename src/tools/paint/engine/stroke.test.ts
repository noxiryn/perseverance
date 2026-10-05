import { describe, expect, it } from 'vitest';
import { BrushStroke, type StrokeConfig } from './stroke';

const cfg: StrokeConfig = {
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
  spacing: 0.25,
  stabilizer: 0,
  seed: 1,
};

function run(c: StrokeConfig, pts: [number, number][]) {
  const s = new BrushStroke(c);
  const out = [...s.begin({ x: pts[0][0], y: pts[0][1], pressure: 1 })];
  for (const [x, y] of pts.slice(1)) out.push(...s.move({ x, y, pressure: 1 }));
  const last = pts[pts.length - 1];
  out.push(...s.end({ x: last[0], y: last[1], pressure: 1 }));
  return { s, dabs: out };
}

describe('BrushStroke', () => {
  it('places evenly spaced dabs (spacing × size) along a straight drag', () => {
    const pts: [number, number][] = [];
    for (let x = 0; x <= 100; x += 7) pts.push([x, 0]);
    const { dabs } = run(cfg, pts);
    expect(dabs[0].x).toBe(0);
    const gaps = dabs.slice(1).map((d, i) => d.x - dabs[i].x);
    for (const g of gaps) expect(g).toBeCloseTo(5, 5);
    // Reaches (close to) the end of the drag.
    expect(dabs[dabs.length - 1].x).toBeGreaterThan(94);
    for (const d of dabs) expect(d.y).toBeCloseTo(0, 6);
  });

  it('dab rhythm does not depend on how densely the pointer was sampled', () => {
    const sparse: [number, number][] = [[0, 0], [50, 0], [100, 0]];
    const dense: [number, number][] = [];
    for (let x = 0; x <= 100; x += 1) dense.push([x, 0]);
    const a = run(cfg, sparse).dabs.length;
    const b = run(cfg, dense).dabs.length;
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });

  it('straight lineTo (Shift-click) bypasses smoothing and lands on the target', () => {
    const s = new BrushStroke(cfg);
    s.begin({ x: 0, y: 0, pressure: 1 });
    const dabs = s.lineTo({ x: 0, y: 50, pressure: 1 });
    expect(dabs.length).toBe(10);
    for (const d of dabs) expect(d.x).toBeCloseTo(0, 6);
    expect(dabs[dabs.length - 1].y).toBeCloseTo(50, 6);
    expect(s.position).toMatchObject({ x: 0, y: 50 });
  });

  it('beginAt + lineTo (Shift-click polyline) does not re-stamp the joint', () => {
    const s = new BrushStroke(cfg);
    s.beginAt({ x: 0, y: 0, pressure: 1 });
    const dabs = s.lineTo({ x: 0, y: 50, pressure: 1 });
    // Same segment as begin()+lineTo() minus the dab on the start point.
    expect(dabs.length).toBe(10);
    expect(dabs[0].y).toBeCloseTo(5, 6);
    for (const d of dabs) expect(d.y).toBeGreaterThan(0);
    expect(dabs[dabs.length - 1].y).toBeCloseTo(50, 6);
  });

  it('beginAt never emits a deferred follow-direction dab at the joint', () => {
    const s = new BrushStroke({ ...cfg, followDirection: true });
    s.beginAt({ x: 0, y: 0, pressure: 1 });
    const dabs = [...s.lineTo({ x: 20, y: 0, pressure: 1 }), ...s.end()];
    expect(dabs.every((d) => d.x > 0)).toBe(true);
  });

  it('follow-direction tips defer the first dab until the direction is known', () => {
    const c = { ...cfg, followDirection: true };
    const s = new BrushStroke(c);
    expect(s.begin({ x: 0, y: 0, pressure: 1 })).toHaveLength(0);
    const dabs = s.move({ x: 0, y: 30, pressure: 1 });
    expect(dabs.length).toBeGreaterThan(0);
    // First dab (the start point) is rotated along +y.
    expect(dabs[0].angle).toBeCloseTo(90);
  });

  it('a click without movement still stamps once', () => {
    const s = new BrushStroke({ ...cfg, followDirection: true });
    s.begin({ x: 5, y: 5, pressure: 1 });
    const dabs = s.end();
    expect(dabs).toHaveLength(1);
    expect(dabs[0]).toMatchObject({ x: 5, y: 5 });
  });

  it('stabilizer holds the brush back until the pointer leaves the string radius', () => {
    const s = new BrushStroke({ ...cfg, stabilizer: 30 });
    s.begin({ x: 0, y: 0, pressure: 1 });
    expect(s.move({ x: 20, y: 0, pressure: 1 })).toHaveLength(0);
    expect(s.position).toMatchObject({ x: 0, y: 0 });
    s.move({ x: 60, y: 0, pressure: 1 });
    expect(s.position!.x).toBeCloseTo(30);
    // end() catches up to the release point.
    s.end({ x: 60, y: 0, pressure: 1 });
    expect(s.position!.x).toBeCloseTo(60);
  });

  it('airbrush stationary() stamps at the current brush position', () => {
    const s = new BrushStroke(cfg);
    s.begin({ x: 3, y: 4, pressure: 1 });
    const d = s.stationary();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ x: 3, y: 4 });
  });

  it('is deterministic for a given seed', () => {
    const c = { ...cfg, sizeJitter: 0.8, scatter: 0.5, angleJitter: 1 };
    const pts: [number, number][] = [[0, 0], [40, 10], [80, 0]];
    const a = run(c, pts).dabs;
    const b = run(c, pts).dabs;
    expect(a).toEqual(b);
  });
});
