import { describe, expect, it } from 'vitest';
import { computePointSnap, computeRectSnap, computeValueSnap, snapAxis, type SnapTargets } from './snap';
import { rulerAt, rulerTicks, minorStep } from './rulers';

const targets: SnapTargets = {
  x: [
    { v: 0, lo: 0, hi: 1080, kind: 'canvas' },
    { v: 960, lo: 0, hi: 1080, kind: 'canvas' },
    { v: 1920, lo: 0, hi: 1080, kind: 'canvas' },
    { v: 500, lo: -Infinity, hi: Infinity, kind: 'guide' },
  ],
  y: [
    { v: 0, lo: 0, hi: 1920, kind: 'canvas' },
    { v: 540, lo: 0, hi: 1920, kind: 'canvas' },
    { v: 1080, lo: 0, hi: 1920, kind: 'canvas' },
  ],
};

describe('snapping', () => {
  it('picks the closest candidate within the threshold', () => {
    expect(snapAxis([497], targets.x, 6)?.delta).toBe(3);
    expect(snapAxis([480], targets.x, 6)).toBeNull();
    // multiple moving coordinates: the closest wins
    expect(snapAxis([955, 1004], targets.x, 6)?.delta).toBe(5);
  });

  it('snaps a rect by its edges and center and reports smart guides', () => {
    // center of a 100-wide rect at x=905 → 955; canvas center 960 is 5 away
    const r = computeRectSnap({ x: 905, y: 100, width: 100, height: 50 }, targets, 6);
    expect(r.dx).toBe(5);
    expect(r.dy).toBe(0);
    expect(r.lines.some((l) => l.axis === 'x' && l.pos === 960)).toBe(true);
    // right edge to the right canvas edge
    const e = computeRectSnap({ x: 1818, y: 1027, width: 100, height: 50 }, targets, 6);
    expect(e.dx).toBe(2);
    expect(e.dy).toBe(3);
  });

  it('respects disabled axes', () => {
    const r = computeRectSnap({ x: 905, y: 538, width: 100, height: 4 }, targets, 6, { x: false });
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0); // center 540 already aligned
  });

  it('snaps points and values', () => {
    const p = computePointSnap({ x: 3, y: 1078 }, targets, 6);
    expect(p.x).toBe(0);
    expect(p.y).toBe(1080);
    expect(computeValueSnap(503, targets.x, 6)).toBe(500);
    expect(computeValueSnap(520, targets.x, 6)).toBe(520);
  });
});

describe('rulers', () => {
  it('chooses readable label spacing', () => {
    expect(rulerTicks(1)).toEqual({ major: 100, divisions: 10 });
    expect(rulerTicks(0.5).major).toBe(200);
    expect(rulerTicks(8).major).toBe(10);
    expect(rulerTicks(64).major).toBe(1);
    const t = rulerTicks(0.05);
    expect(t.major * 0.05).toBeGreaterThanOrEqual(56);
  });
  it('minor ticks are at least 5px apart', () => {
    for (const z of [0.03, 0.1, 0.33, 1, 2.5, 12, 40]) expect(minorStep(z) * z).toBeGreaterThanOrEqual(5 - 1e-9);
  });
  it('hit-tests the ruler bands', () => {
    expect(rulerAt({ x: 5, y: 5 }, true)).toBe('corner');
    expect(rulerAt({ x: 100, y: 5 }, true)).toBe('top');
    expect(rulerAt({ x: 5, y: 100 }, true)).toBe('left');
    expect(rulerAt({ x: 100, y: 100 }, true)).toBeNull();
    expect(rulerAt({ x: 5, y: 5 }, false)).toBeNull();
  });
});
