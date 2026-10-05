import { describe, expect, it } from 'vitest';
import { bitmaps } from './bitmaps';

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

describe('bitmap dirty regions', () => {
  it('touch(id, rect) records the region; dirtySince unions every change after a version', () => {
    const id = bitmaps.add(canvas(200, 100));
    const v0 = bitmaps.version(id);
    expect(bitmaps.dirtySince(id, v0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    bitmaps.touch(id, { x: 10, y: 20, width: 30, height: 10 });
    const v1 = bitmaps.version(id);
    expect(v1).toBe(v0 + 1);
    bitmaps.touch(id, { x: 50.5, y: 5.2, width: 10, height: 10 });
    expect(bitmaps.dirtySince(id, v1)).toEqual({ x: 50, y: 5, width: 11, height: 11 });
    expect(bitmaps.dirtySince(id, v0)).toEqual({ x: 10, y: 5, width: 51, height: 25 });
  });

  it('clamps rects to the bitmap and ignores empty ones in unions', () => {
    const id = bitmaps.add(canvas(100, 100));
    const v0 = bitmaps.version(id);
    bitmaps.touch(id, { x: -20, y: 90, width: 50, height: 50 });
    expect(bitmaps.dirtySince(id, v0)).toEqual({ x: 0, y: 90, width: 30, height: 10 });
    const v1 = bitmaps.version(id);
    bitmaps.touch(id, { x: 500, y: 500, width: 10, height: 10 });
    expect(bitmaps.dirtySince(id, v1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(bitmaps.dirtySince(id, v0)).toEqual({ x: 0, y: 90, width: 30, height: 10 });
  });

  it('a touch without a rect (or an unknown history) means "unknown": null', () => {
    const id = bitmaps.add(canvas(50, 50));
    const v0 = bitmaps.version(id);
    bitmaps.touch(id, { x: 1, y: 1, width: 2, height: 2 });
    const v1 = bitmaps.version(id);
    bitmaps.touch(id);
    expect(bitmaps.dirtySince(id, v0)).toBeNull();
    expect(bitmaps.dirtySince(id, v1)).toBeNull();
    expect(bitmaps.dirtySince(id, bitmaps.version(id))).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    // Versions before the bitmap existed / from the future / unknown bitmaps.
    expect(bitmaps.dirtySince(id, 0)).toBeNull();
    expect(bitmaps.dirtySince(id, bitmaps.version(id) + 1)).toBeNull();
    expect(bitmaps.dirtySince('nope', 1)).toBeNull();
  });

  it('forgets regions older than its log (then null)', () => {
    const id = bitmaps.add(canvas(10, 10));
    const v0 = bitmaps.version(id);
    for (let i = 0; i < 300; i++) bitmaps.touch(id, { x: 0, y: 0, width: 1, height: 1 });
    expect(bitmaps.dirtySince(id, v0)).toBeNull();
    expect(bitmaps.dirtySince(id, bitmaps.version(id) - 10)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('listeners get the rect as a second argument (undefined for full touches)', () => {
    const id = bitmaps.add(canvas(40, 40));
    const seen: unknown[] = [];
    const off = bitmaps.subscribe((bid, r) => {
      if (bid === id) seen.push(r);
    });
    bitmaps.touch(id, { x: 2, y: 3, width: 4, height: 5 });
    bitmaps.touch(id);
    off();
    expect(seen).toEqual([{ x: 2, y: 3, width: 4, height: 5 }, undefined]);
  });

  it('applyPatch touches only the patched rect', () => {
    const id = bitmaps.add(canvas(64, 64));
    const v0 = bitmaps.version(id);
    // jsdom has no 2D context: stub one that accepts putImageData.
    const c = bitmaps.get(id) as HTMLCanvasElement & { getContext: unknown };
    (c as unknown as { getContext: () => unknown }).getContext = () => ({ putImageData() {} });
    const img = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4) } as unknown as ImageData;
    bitmaps.applyPatch({ bitmapId: id, x: 5, y: 6, before: img, after: img }, 'after');
    expect(bitmaps.dirtySince(id, v0)).toEqual({ x: 5, y: 6, width: 8, height: 4 });
  });

  it('re-adding an id keeps versions increasing and marks everything changed', () => {
    const id = bitmaps.add(canvas(10, 10));
    bitmaps.touch(id, { x: 0, y: 0, width: 1, height: 1 });
    const v = bitmaps.version(id);
    bitmaps.add(canvas(20, 20), id);
    expect(bitmaps.version(id)).toBe(v + 1);
    expect(bitmaps.dirtySince(id, v)).toBeNull();
  });
});
