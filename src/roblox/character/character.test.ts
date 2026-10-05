import { describe, expect, it } from 'vitest';
import type { Transform } from '../../core/types';
import { linearApply } from '../../panels/geometryMath';
import { fitIntoBox, trimRect, trimTransform } from './fit';

/** Doc position of local point (u, v) of a w×h box (same math as transformMatrix). */
function toDoc(t: Transform, w: number, h: number, u: number, v: number) {
  const d = linearApply(t, u - w / 2, v - h / 2);
  return { x: t.x + w / 2 + d.x, y: t.y + h / 2 + d.y };
}

const T = (p: Partial<Transform> = {}): Transform => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, ...p });

describe('fitIntoBox', () => {
  it('contains the image in the old box, centered, at 1:1 scale', () => {
    // Old box: 400×800 shown at half size (200×400 on the canvas), centered at (300, 400).
    const t = T({ x: 100, y: 0, scaleX: 0.5, scaleY: 0.5 });
    const r = fitIntoBox(t, 400, 800, 1000, 1000, 'center');
    expect(r.width).toBe(200);
    expect(r.height).toBe(200);
    expect(r.transform.scaleX).toBe(1);
    expect(r.transform.scaleY).toBe(1);
    const c = toDoc(r.transform, r.width, r.height, r.width / 2, r.height / 2);
    expect(c.x).toBeCloseTo(300);
    expect(c.y).toBeCloseTo(400);
  });

  it('keeps flips and rotation', () => {
    const t = T({ x: 0, y: 0, scaleX: -0.998, scaleY: 1, rotation: 12 });
    const r = fitIntoBox(t, 500, 1000, 300, 600);
    expect(r.transform.scaleX).toBe(-1);
    expect(r.transform.scaleY).toBe(1);
    expect(r.transform.rotation).toBe(12);
    expect(r.width / r.height).toBeCloseTo(0.5, 2);
  });

  it('bottom alignment keeps the feet on the same spot', () => {
    // Placeholder 300×900 at (500, 100); new image is a wide bust (800×400).
    const t = T({ x: 500, y: 100 });
    const r = fitIntoBox(t, 300, 900, 800, 400, 'bottom');
    expect(r.width).toBe(300);
    expect(r.height).toBe(150);
    const oldBottom = toDoc(t, 300, 900, 150, 900);
    const newBottom = toDoc(r.transform, r.width, r.height, r.width / 2, r.height);
    expect(newBottom.x).toBeCloseTo(oldBottom.x);
    expect(newBottom.y).toBeCloseTo(oldBottom.y);
  });

  it('bottom alignment follows the layer rotation', () => {
    const t = T({ x: 0, y: 0, rotation: 90, scaleX: 2, scaleY: 2 });
    const r = fitIntoBox(t, 100, 200, 100, 100, 'bottom');
    const oldBottom = toDoc(t, 100, 200, 50, 200);
    const newBottom = toDoc(r.transform, r.width, r.height, r.width / 2, r.height);
    expect(newBottom.x).toBeCloseTo(oldBottom.x);
    expect(newBottom.y).toBeCloseTo(oldBottom.y);
  });
});

describe('trim', () => {
  it('trimRect returns null when nothing would change', () => {
    expect(trimRect(null, 10, 10)).toBeNull();
    expect(trimRect({ x0: 0, y0: 0, x1: 9, y1: 9 }, 10, 10)).toBeNull();
    expect(trimRect({ x0: 2, y0: 3, x1: 5, y1: 9 }, 10, 10)).toEqual({ x: 2, y: 3, width: 4, height: 7 });
  });

  it('trimTransform keeps every pixel where it was (scaled, rotated, flipped)', () => {
    const t = T({ x: 40, y: -20, scaleX: -1.5, scaleY: 0.75, rotation: 33, skewX: 5 });
    const w = 400,
      h = 300;
    const rect = { x: 120, y: 40, width: 90, height: 200 };
    const nt = trimTransform(t, w, h, rect);
    for (const [u, v] of [
      [0, 0],
      [90, 0],
      [45, 120],
      [90, 200],
    ]) {
      const before = toDoc(t, w, h, rect.x + u, rect.y + v);
      const after = toDoc(nt, rect.width, rect.height, u, v);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });
});
