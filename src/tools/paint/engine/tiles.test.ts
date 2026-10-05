import { describe, expect, it } from 'vitest';
import type { Rect } from '../../../core/types';
import { DirtyGrid, bandsOf } from './tiles';

/** Every pixel covered by any of the rects. */
function covered(rects: Rect[], w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (const r of rects) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) m[y * w + x] = 1;
  return m;
}

describe('DirtyGrid', () => {
  it('starts empty and clears cheaply', () => {
    const g = new DirtyGrid(300, 200, 64);
    expect(g.isEmpty).toBe(true);
    expect(g.rects()).toEqual([]);
    g.add({ x: 10, y: 10, width: 5, height: 5 });
    expect(g.isEmpty).toBe(false);
    g.clear();
    expect(g.isEmpty).toBe(true);
    expect(g.bounds()).toBeNull();
  });

  it('keeps exact dirty bounds inside a cell', () => {
    const g = new DirtyGrid(300, 200, 64);
    g.add({ x: 10, y: 12, width: 5, height: 6 });
    g.add({ x: 20, y: 8, width: 3, height: 2 });
    expect(g.rects()).toEqual([{ x: 10, y: 8, width: 13, height: 10, row: 0 }]);
  });

  it('clips to the bitmap', () => {
    const g = new DirtyGrid(100, 100, 64);
    g.add({ x: -20, y: 90, width: 40, height: 40 });
    expect(g.rects()).toEqual([{ x: 0, y: 90, width: 20, height: 10, row: 1 }]);
    g.add({ x: 500, y: 500, width: 5, height: 5 });
    expect(g.count).toBe(1);
  });

  it('a long diagonal stroke records the band around the stroke, not its bounding box', () => {
    const W = 1920,
      H = 1080;
    const g = new DirtyGrid(W, H, 64);
    // 40px dabs every 10px from (0,0) to (1000,1000).
    for (let t = 0; t <= 1000; t += 10) g.add({ x: t - 20, y: t - 20, width: 40, height: 40 });
    const rects = g.rects();
    const area = rects.reduce((s, r) => s + r.width * r.height, 0);
    const bbox = g.bounds()!;
    expect(bbox.width * bbox.height).toBeGreaterThan(1_000_000);
    // Far less than the bounding box (which is what the old single patch recorded).
    expect(area).toBeLessThan(bbox.width * bbox.height * 0.2);
    // Untouched corners of the bounding box are not part of any rect.
    const m = covered(rects, W, H);
    expect(m[150 * W + 800]).toBe(0);
    expect(m[800 * W + 150]).toBe(0);
    // Every dab pixel is covered.
    for (let t = 0; t <= 1000; t += 10) expect(m[Math.min(H - 1, t) * W + t]).toBe(1);
  });

  it('merges runs of adjacent touched cells per row', () => {
    const g = new DirtyGrid(512, 128, 64);
    g.add({ x: 30, y: 10, width: 200, height: 20 }); // cells 0..3 of row 0
    g.add({ x: 400, y: 5, width: 10, height: 10 }); // cell 6
    const rects = g.rects();
    expect(rects).toEqual([
      { x: 30, y: 10, width: 200, height: 20, row: 0 },
      { x: 400, y: 5, width: 10, height: 10, row: 0 },
    ]);
  });

  it('every rect pixel lies in a touched cell', () => {
    const g = new DirtyGrid(640, 640, 64);
    const touched = new Set<number>();
    const add = (r: Rect) => {
      g.add(r);
      for (let cy = Math.floor(r.y / 64); cy <= Math.floor((r.y + r.height - 1) / 64); cy++)
        for (let cx = Math.floor(r.x / 64); cx <= Math.floor((r.x + r.width - 1) / 64); cx++) touched.add(cy * 10 + cx);
    };
    add({ x: 5, y: 5, width: 10, height: 10 });
    add({ x: 120, y: 60, width: 90, height: 10 });
    add({ x: 300, y: 400, width: 200, height: 130 });
    for (const r of g.rects())
      for (let y = r.y; y < r.y + r.height; y++)
        for (let x = r.x; x < r.x + r.width; x++) expect(touched.has(Math.floor(y / 64) * 10 + Math.floor(x / 64))).toBe(true);
  });
});

describe('bandsOf', () => {
  it('groups rects by cell row with the band bounds', () => {
    const g = new DirtyGrid(512, 256, 64);
    g.add({ x: 10, y: 10, width: 20, height: 20 });
    g.add({ x: 300, y: 40, width: 20, height: 10 });
    g.add({ x: 100, y: 130, width: 20, height: 20 });
    const bands = bandsOf(g.rects());
    expect(bands).toHaveLength(2);
    expect(bands[0].band).toEqual({ x: 10, y: 10, width: 310, height: 40 });
    expect(bands[0].rects).toHaveLength(2);
    expect(bands[1].band).toEqual({ x: 100, y: 130, width: 20, height: 20 });
  });
});
