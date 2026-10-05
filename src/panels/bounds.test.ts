import { describe, expect, it } from 'vitest';
import { alphaBounds, localRectToDoc } from './bounds';
import { paramCommitPhase, paramLabel } from './phase';
import type { ParamDef } from '../core/types';

function rgba(w: number, h: number, opaque: [number, number, number?][]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (const [x, y, a = 255] of opaque) d[(y * w + x) * 4 + 3] = a;
  return d;
}

describe('alphaBounds', () => {
  it('returns null for a fully transparent image', () => {
    expect(alphaBounds(new Uint8ClampedArray(10 * 6 * 4), 10, 6)).toBeNull();
  });

  it('finds the bounding box of non-transparent pixels', () => {
    const d = rgba(20, 10, [
      [3, 2],
      [12, 7],
      [5, 4],
    ]);
    expect(alphaBounds(d, 20, 10)).toEqual({ x: 3, y: 2, width: 10, height: 6 });
  });

  it('handles a single pixel and image edges', () => {
    expect(alphaBounds(rgba(8, 8, [[0, 0]]), 8, 8)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(alphaBounds(rgba(8, 8, [[7, 7]]), 8, 8)).toEqual({ x: 7, y: 7, width: 1, height: 1 });
  });

  it('respects the threshold', () => {
    const d = rgba(8, 8, [
      [1, 1, 5],
      [4, 4, 200],
    ]);
    expect(alphaBounds(d, 8, 8, 10)).toEqual({ x: 4, y: 4, width: 1, height: 1 });
  });
});

describe('localRectToDoc', () => {
  const base = { x: 100, y: 50, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0 };

  it('translates for an identity transform', () => {
    expect(localRectToDoc(base, 200, 100, { x: 10, y: 20, width: 30, height: 40 })).toEqual({ x: 110, y: 70, width: 30, height: 40 });
  });

  it('scales around the box center', () => {
    // 200×100 box at (100,50): center (200,100). Scale 2 → local (0,0) maps to (0,0).
    const r = localRectToDoc({ ...base, scaleX: 2, scaleY: 2 }, 200, 100, { x: 0, y: 0, width: 200, height: 100 });
    expect(r).toEqual({ x: 0, y: 0, width: 400, height: 200 });
  });

  it('mirrors with negative scale', () => {
    const r = localRectToDoc({ ...base, scaleX: -1 }, 200, 100, { x: 0, y: 0, width: 50, height: 100 });
    expect(r.x).toBeCloseTo(250);
    expect(r.width).toBeCloseTo(50);
  });

  it('gives the axis-aligned bounds of a rotated rect', () => {
    const r = localRectToDoc({ ...base, rotation: 90 }, 200, 100, { x: 0, y: 0, width: 200, height: 100 });
    expect(r.x).toBeCloseTo(150);
    expect(r.y).toBeCloseTo(0);
    expect(r.width).toBeCloseTo(100);
    expect(r.height).toBeCloseTo(200);
  });
});

describe('param phases', () => {
  const defs: ParamDef[] = [
    { key: 'size', label: 'Size', type: 'number', min: 0, max: 10, default: 1 },
    { key: 'color', label: 'Color', type: 'color', default: '#000' },
    { key: 'position', label: 'Position', type: 'select', options: [{ value: 'a', label: 'A' }], default: 'a' },
    { key: 'fade', label: 'Fade', type: 'boolean', default: false },
  ];

  it('coalesces continuous controls and commits discrete ones', () => {
    expect(paramCommitPhase(defs, 'size')).toBe('coalesce');
    expect(paramCommitPhase(defs, 'color')).toBe('coalesce');
    expect(paramCommitPhase(defs, 'position')).toBe('commit');
    expect(paramCommitPhase(defs, 'fade')).toBe('commit');
  });

  it('labels edits per parameter', () => {
    expect(paramLabel('Stroke', defs, 'size')).toBe('Stroke Size');
    expect(paramLabel('Stroke', defs, 'missing')).toBe('Stroke');
  });
});
