import { describe, expect, it, vi } from 'vitest';
import { encodeCached, PngCache } from './pngCache';

const fakeCanvas = (width: number, height: number) => ({ width, height });
const bytes = (...v: number[]) => new Uint8Array(v).buffer as ArrayBuffer;

describe('PngCache', () => {
  it('reuses the encoding of an unchanged canvas', async () => {
    const cache = new PngCache();
    const c = fakeCanvas(4, 4);
    const encode = vi.fn(async () => bytes(1, 2, 3));
    const a = await encodeCached(cache, 'bmp_1', c, 1, encode);
    const b = await encodeCached(cache, 'bmp_1', c, 1, encode);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(new Uint8Array(b.data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('re-encodes after the bitmap version changes', async () => {
    const cache = new PngCache();
    const c = fakeCanvas(4, 4);
    const encode = vi.fn(async () => bytes(9));
    await encodeCached(cache, 'bmp_1', c, 1, encode);
    await encodeCached(cache, 'bmp_1', c, 2, encode);
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it('never serves another canvas that reuses the same id, version and size (regression)', async () => {
    // Project v1 is saved and closed; its bitmaps are dropped. Project v2 has the same bitmap ids,
    // so decoding registers NEW canvases under those ids at version 1 — with different pixels.
    const cache = new PngCache();
    const red = fakeCanvas(8, 8);
    const blue = fakeCanvas(8, 8);
    await encodeCached(cache, 'bmp_shared', red, 1, async () => bytes(0xff, 0, 0));
    const saved = await encodeCached(cache, 'bmp_shared', blue, 1, async () => bytes(0, 0, 0xff));
    expect(saved.cached).toBe(false);
    expect(new Uint8Array(saved.data)).toEqual(new Uint8Array([0, 0, 0xff]));
    // …and the blue entry is now the cached one.
    expect(cache.lookup('bmp_shared', blue, 1)).not.toBeNull();
    expect(cache.lookup('bmp_shared', red, 1)).toBeNull();
  });

  it('misses when the canvas was resized in place', async () => {
    const cache = new PngCache();
    const c = fakeCanvas(4, 4);
    await encodeCached(cache, 'bmp_1', c, 3, async () => bytes(1));
    c.width = 5;
    expect(cache.lookup('bmp_1', c, 3)).toBeNull();
  });

  it('caches the size captured before the async encode', async () => {
    const cache = new PngCache();
    const c = fakeCanvas(4, 4);
    const r = await encodeCached(cache, 'bmp_1', c, 1, async (cv) => {
      const out = bytes(cv.width);
      cv.width = 10; // changed while encoding
      return out;
    });
    expect(r.width).toBe(4);
    expect(cache.lookup('bmp_1', c, 1)).toBeNull();
  });

  it('forget and prune drop entries', async () => {
    const cache = new PngCache();
    const a = fakeCanvas(1, 1);
    const b = fakeCanvas(1, 1);
    cache.store('a', a, 1, bytes(1));
    cache.store('b', b, 1, bytes(2));
    cache.forget('a');
    expect(cache.lookup('a', a, 1)).toBeNull();
    cache.store('a', a, 1, bytes(1));
    cache.prune(new Set(['b']));
    expect(cache.size).toBe(1);
    expect(cache.lookup('b', b, 1)).not.toBeNull();
  });
});
