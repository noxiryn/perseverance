import { describe, expect, it, vi } from 'vitest';
import { encodeCached, PngCache, startEncodes } from './pngCache';

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

describe('startEncodes (consistent save snapshot)', () => {
  /** A canvas stand-in whose "pixels" can change after the snapshot (an edit or an undo). */
  const live = (width: number, height: number, pixels: number) => ({ width, height, pixels });
  /** Encoder that captures the pixels synchronously and finishes later, like canvas.toBlob. */
  const toBlobLike = () => {
    const calls: number[] = [];
    const encode = (c: { pixels: number }) => {
      const captured = c.pixels;
      calls.push(captured);
      return new Promise<ArrayBuffer>((resolve) => setTimeout(() => resolve(bytes(captured)), 5));
    };
    return { calls, encode };
  };

  it('starts every encode before returning, so later edits cannot reach the file', async () => {
    const cache = new PngCache();
    const a = live(4, 4, 1);
    const b = live(4, 4, 2);
    const { calls, encode } = toBlobLike();
    const jobs = startEncodes(cache, [
      { id: 'a', canvas: a, version: 1 },
      { id: 'b', canvas: b, version: 1 },
    ], encode);
    // Synchronously after the call: both snapshots are taken.
    expect(calls).toEqual([1, 2]);
    // The user undoes / paints while the PNGs are still encoding.
    a.pixels = 10;
    b.pixels = 20;
    const out = await Promise.all(jobs.map((j) => j.data));
    expect(out.map((d) => new Uint8Array(d)[0])).toEqual([1, 2]);
  });

  it('reuses cached PNGs of unchanged canvases and caches new ones under the snapshot version', async () => {
    const cache = new PngCache();
    const a = live(4, 4, 7);
    const { calls, encode } = toBlobLike();
    await Promise.all(startEncodes(cache, [{ id: 'a', canvas: a, version: 3 }], encode).map((j) => j.data));
    const again = startEncodes(cache, [{ id: 'a', canvas: a, version: 3 }], encode);
    expect(again[0].cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect(new Uint8Array(await again[0].data)).toEqual(new Uint8Array([7]));
    // Edited after the first save: re-encoded.
    a.pixels = 8;
    const edited = startEncodes(cache, [{ id: 'a', canvas: a, version: 4 }], encode);
    expect(edited[0].cached).toBe(false);
    expect(new Uint8Array(await edited[0].data)).toEqual(new Uint8Array([8]));
  });

  it('caches under the version read at snapshot time, not the version after the encode', async () => {
    const cache = new PngCache();
    const a = live(4, 4, 1);
    const { encode } = toBlobLike();
    const jobs = startEncodes(cache, [{ id: 'a', canvas: a, version: 1 }], encode);
    a.pixels = 2; // edited (version 2) while encoding
    await jobs[0].data;
    // (lookup drops a stale entry, so check the snapshot version first)
    expect(cache.lookup('a', a, 1)).not.toBeNull();
    expect(cache.lookup('a', a, 2)).toBeNull();
  });

  it('reports encoder failures through the job, without unhandled rejections', async () => {
    const cache = new PngCache();
    const jobs = startEncodes(cache, [{ id: 'a', canvas: live(1, 1, 0), version: 1 }], () => {
      throw new Error('toBlob failed');
    });
    await expect(jobs[0].data).rejects.toThrow('toBlob failed');
  });
});
