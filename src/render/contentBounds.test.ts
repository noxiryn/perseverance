/** Conservative content bounds used to crop layer renders (release review render-paint-diff-3). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bitmaps } from '../core/bitmaps';
import { installSoftCanvas } from './softCanvas';
import { boundsStats, conservativeBounds, rasterCrop, resetContentBounds, scanAlphaBounds } from './contentBounds';

let uninstall: () => void = () => {};
beforeAll(() => {
  uninstall = installSoftCanvas();
});
afterAll(() => uninstall());

function rgba(w: number, h: number, opaque: [number, number, number][]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (const [x, y, a] of opaque) d[(y * w + x) * 4 + 3] = a;
  return d;
}

function bitmap(w: number, h: number, draw?: (k: CanvasRenderingContext2D) => void): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  if (draw) draw(c.getContext('2d')!);
  return bitmaps.add(c);
}

describe('scanAlphaBounds', () => {
  it('finds the exact bounds of non-zero alpha (even alpha 1)', () => {
    expect(scanAlphaBounds(rgba(8, 6, []), 8, 6)).toBeNull();
    expect(scanAlphaBounds(rgba(8, 6, [[3, 2, 1]]), 8, 6)).toEqual({ x: 3, y: 2, width: 1, height: 1 });
    expect(scanAlphaBounds(rgba(8, 6, [[7, 0, 255], [0, 5, 9], [4, 3, 1]]), 8, 6)).toEqual({ x: 0, y: 0, width: 8, height: 6 });
    expect(scanAlphaBounds(rgba(8, 6, [[2, 1, 4], [5, 4, 200], [1, 3, 1]]), 8, 6)).toEqual({ x: 1, y: 1, width: 5, height: 4 });
  });
});

describe('conservativeBounds', () => {
  it('scans once, then grows by the touched regions (never shrinks, never misses content)', () => {
    resetContentBounds();
    const id = bitmap(200, 100, (k) => {
      k.fillStyle = '#fff';
      k.fillRect(20, 30, 10, 5);
    });
    expect(conservativeBounds(id)).toEqual({ x: 20, y: 30, width: 10, height: 5 });
    expect(boundsStats.scans).toBe(1);
    const k = bitmaps.get(id).getContext('2d')!;
    k.fillStyle = '#fff';
    k.fillRect(150, 80, 4, 4);
    bitmaps.touch(id, { x: 150, y: 80, width: 4, height: 4 });
    expect(conservativeBounds(id)).toEqual({ x: 20, y: 30, width: 134, height: 54 });
    // erasing keeps the bounds (conservative)
    k.clearRect(150, 80, 4, 4);
    bitmaps.touch(id, { x: 150, y: 80, width: 4, height: 4 });
    expect(conservativeBounds(id)).toEqual({ x: 20, y: 30, width: 134, height: 54 });
    expect(boundsStats.scans).toBe(1);
    // a change of unknown extent rescans (exact again)
    bitmaps.touch(id);
    expect(conservativeBounds(id)).toEqual({ x: 20, y: 30, width: 10, height: 5 });
    expect(boundsStats.scans).toBe(2);
    // pixels replaced under the same id
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    bitmaps.add(c, id);
    expect(conservativeBounds(id)).toBeNull();
    expect(conservativeBounds('missing')).toBeUndefined();
  });
});

describe('rasterCrop', () => {
  it('grows the bounds by slack, snaps to 64 px, and is skipped when it saves too little', () => {
    resetContentBounds();
    const id = bitmap(1024, 768, (k) => {
      k.fillStyle = '#fff';
      k.fillRect(300, 200, 40, 40);
    });
    // slack 64 px (bounds 40 px): 236…404 → 192…448, 136…304 → 128…320
    expect(rasterCrop(id, 1024, 768, 1)).toEqual({ x: 192, y: 128, width: 256, height: 192 });
    // at a small render scale the slack covers 3 output px
    expect(rasterCrop(id, 1024, 768, 0.02)).toEqual({ x: 128, y: 0, width: 384, height: 448 });
    // empty bitmap: nothing to draw
    expect(rasterCrop(bitmap(1024, 768), 1024, 768, 1)).toBeNull();
    // content all over: not cropped
    const big = bitmap(400, 300, (k) => {
      k.fillStyle = '#fff';
      k.fillRect(10, 10, 380, 280);
    });
    expect(rasterCrop(big, 400, 300, 1)).toBe('full');
    // a bitmap of another size than the layer box
    expect(rasterCrop(id, 512, 768, 1)).toBe('full');
  });
});
