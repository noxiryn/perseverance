import { describe, expect, it } from 'vitest';
import type { Rect, Transform } from '../core/types';
import {
  alignDelta,
  distributeDeltas,
  flippedTransform,
  linearApply,
  normalizeAngle,
  pixelBox,
  reboxTransform,
  resetTransform,
  unionRects,
  visualBox,
  withVisualPosition,
  withVisualSize,
} from './geometryMath';

const T = (p: Partial<Transform> = {}): Transform => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0, ...p });

/** Full layer transform M(p) = center + L(p − c) (same convention as core/geometry). */
function apply(t: Transform, w: number, h: number, p: { x: number; y: number }) {
  const d = linearApply(t, p.x - w / 2, p.y - h / 2);
  return { x: t.x + w / 2 + d.x, y: t.y + h / 2 + d.y };
}

describe('align & distribute', () => {
  const target: Rect = { x: 0, y: 0, width: 100, height: 50 };
  const b: Rect = { x: 10, y: 20, width: 20, height: 10 };
  it('alignDelta', () => {
    expect(alignDelta(b, target, 'left')).toEqual({ dx: -10, dy: 0 });
    expect(alignDelta(b, target, 'hcenter')).toEqual({ dx: 30, dy: 0 });
    expect(alignDelta(b, target, 'right')).toEqual({ dx: 70, dy: 0 });
    expect(alignDelta(b, target, 'top')).toEqual({ dx: 0, dy: -20 });
    expect(alignDelta(b, target, 'vcenter')).toEqual({ dx: 0, dy: 0 });
    expect(alignDelta({ ...b, y: 0 }, target, 'vcenter')).toEqual({ dx: 0, dy: 20 });
    expect(alignDelta(b, target, 'bottom')).toEqual({ dx: 0, dy: 20 });
  });

  it('distributes centers evenly, keeping the outermost in place', () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 80, y: 0, width: 20, height: 10 },
      { x: 20, y: 0, width: 10, height: 10 },
    ];
    const d = distributeDeltas(rects, 'h', 'centers');
    // centers: 5, 90, 25 → evenly between 5 and 90: 47.5
    expect(d[0]).toEqual({ dx: 0, dy: 0 });
    expect(d[1]).toEqual({ dx: 0, dy: 0 });
    expect(d[2].dx).toBeCloseTo(22.5);
  });

  it('distributes spacing (equal gaps)', () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 12, y: 0, width: 30, height: 10 },
      { x: 90, y: 0, width: 10, height: 10 },
    ];
    const d = distributeDeltas(rects, 'h', 'spacing');
    // span 100, total 50 → gap 25 → middle starts at 35
    expect(d[1].dx).toBeCloseTo(23);
    expect(d[0].dx).toBe(0);
    expect(d[2].dx).toBe(0);
    expect(distributeDeltas(rects.slice(0, 2), 'v', 'centers')).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });

  it('unionRects', () => {
    expect(unionRects([])).toBeNull();
    expect(unionRects([{ x: 5, y: 5, width: 5, height: 5 }, { x: -5, y: 0, width: 2, height: 2 }])).toEqual({ x: -5, y: 0, width: 15, height: 10 });
  });
});

describe('transform fields', () => {
  it('visualBox is the scaled box around the same center', () => {
    expect(visualBox(T({ x: 10, y: 20, scaleX: 2, scaleY: 0.5 }), 100, 40)).toEqual({ x: -40, y: 30, width: 200, height: 20 });
    // Flips do not change the box.
    expect(visualBox(T({ scaleX: -1 }), 10, 10)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('withVisualPosition moves the visual top-left', () => {
    const t = withVisualPosition(T({ scaleX: 2, scaleY: 2 }), 10, 10, { x: 0, y: 0 });
    expect(visualBox(t, 10, 10)).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  it('withVisualSize keeps the top-left, the aspect ratio when linked, and flips', () => {
    const t0 = T({ x: 0, y: 0, scaleX: -1, scaleY: 1 });
    const t = withVisualSize(t0, 100, 50, { width: 200 }, true);
    const b = visualBox(t, 100, 50);
    expect(b.x).toBeCloseTo(0);
    expect(b.y).toBeCloseTo(0);
    expect(b.width).toBeCloseTo(200);
    expect(b.height).toBeCloseTo(100);
    expect(t.scaleX).toBeCloseTo(-2);
    const u = withVisualSize(T(), 100, 50, { height: 10 }, false);
    expect(visualBox(u, 100, 50).width).toBeCloseTo(100);
    expect(visualBox(u, 100, 50).height).toBeCloseTo(10);
    const v = withVisualSize(T(), 100, 50, { height: 100 }, true);
    expect(visualBox(v, 100, 50).width).toBeCloseTo(200);
  });

  it('flip / reset / normalize', () => {
    expect(flippedTransform(T({ scaleX: 2 }), 'h').scaleX).toBe(-2);
    expect(flippedTransform(T({ scaleY: 2 }), 'v').scaleY).toBe(-2);
    expect(resetTransform(T({ x: 5, scaleX: 3, rotation: 40, skewX: 10 }))).toEqual(T({ x: 5 }));
    expect(normalizeAngle(190)).toBe(-170);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(360)).toBe(0);
  });
});

describe('rebox', () => {
  it('pixelBox snaps outward to integers', () => {
    expect(pixelBox({ x: -3.5, y: 0.2, width: 10.1, height: 4 })).toEqual({ x: -4, y: 0, width: 11, height: 5 });
  });

  it('reboxTransform keeps every pixel where it was (rotation, scale, flip, skew)', () => {
    const cases: [Transform, number, number, Rect][] = [
      [T({ x: 10, y: 20 }), 100, 40, { x: -6, y: -4, width: 112, height: 50 }],
      [T({ x: 300, y: 120, rotation: 33, scaleX: 1.7, scaleY: 0.6 }), 220, 90, { x: -12, y: -30, width: 250, height: 140 }],
      [T({ x: -50, y: 80, rotation: -120, scaleX: -1, scaleY: 2, skewX: 14 }), 64, 64, { x: -8, y: -8, width: 90, height: 72 }],
    ];
    for (const [t, w, h, box] of cases) {
      const nt = reboxTransform(t, w, h, box);
      for (const [u, v] of [
        [0, 0],
        [box.width, 0],
        [box.width / 3, box.height],
        [17, 9],
      ]) {
        const before = apply(t, w, h, { x: box.x + u, y: box.y + v });
        const after = apply(nt, box.width, box.height, { x: u, y: v });
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
      }
      expect(nt.rotation).toBe(t.rotation);
      expect(nt.scaleX).toBe(t.scaleX);
    }
  });
});
