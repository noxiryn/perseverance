/**
 * PixelSession history integrity (regression for tile-lazy loading): the pooled work/orig
 * buffers only hold valid pixels in tiles a dab loaded, so live writes, patches and restores
 * must never cover tiles the stroke did not visit — even when the pool still holds another
 * layer's pixels from an earlier stroke. jsdom has no canvas, so the canvas, store and viewport
 * are replaced by small fakes backed by plain RGBA arrays.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BitmapPatch } from '../../../core/types';

interface FakeCanvas {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const commits: { label: string; patches: BitmapPatch[] }[] = [];
let valid = true;

vi.mock('../../../core/canvas', () => {
  const ctx = (c: FakeCanvas) => ({
    getImageData(x: number, y: number, w: number, h: number) {
      const out = new ImageData(w, h);
      for (let r = 0; r < h; r++) {
        const o = ((y + r) * c.width + x) * 4;
        out.data.set(c.data.subarray(o, o + w * 4), r * w * 4);
      }
      return out;
    },
    putImageData(img: ImageData, dx: number, dy: number, sx = 0, sy = 0, sw = img.width, sh = img.height) {
      for (let r = 0; r < sh; r++) {
        const so = ((sy + r) * img.width + sx) * 4;
        const o = ((dy + sy + r) * c.width + dx + sx) * 4;
        c.data.set(img.data.subarray(so, so + sw * 4), o);
      }
    },
  });
  return { ctx2d: ctx, ctxRead: ctx };
});
vi.mock('../../../core/bitmaps', () => ({ bitmaps: { touch: () => {}, tryGet: () => current } }));
vi.mock('../../../editor/viewport', () => ({ viewport: { requestRender: () => {} } }));
vi.mock('../../../state/ui', () => ({ toast: () => {} }));
vi.mock('../../../state/editor', () => ({
  useEditor: {
    getState: () => ({ commit: (label: string, _r: unknown, o: { patches: BitmapPatch[] }) => commits.push({ label, patches: o.patches }) }),
    subscribe: () => () => {},
  },
}));
vi.mock('./target', () => ({ targetStillValid: () => valid }));

let current: FakeCanvas | null = null;

beforeAll(() => {
  if (typeof globalThis.ImageData === 'undefined') {
    class ImageDataPolyfill {
      data: Uint8ClampedArray;
      constructor(
        public width: number,
        public height: number,
      ) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    }
    (globalThis as unknown as { ImageData: unknown }).ImageData = ImageDataPolyfill;
  }
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
});

beforeEach(() => {
  commits.length = 0;
  valid = true;
});

const W = 1024;
const H = 768;

function layer(rgba: [number, number, number, number]): FakeCanvas {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: W, height: H, data };
}

async function session(canvas: FakeCanvas) {
  current = canvas;
  const { PixelSession } = await import('./pixelSession');
  return new PixelSession({
    docId: 'd',
    layerId: 'l',
    layerName: 'L',
    kind: 'content',
    bitmapId: 'b',
    canvas: canvas as unknown as HTMLCanvasElement,
    width: W,
    height: H,
    toLocal: null,
    toDoc: null,
    lockTransparency: false,
    selection: null,
  });
}

/** Invert a dab-sized square in the working buffer and mark it (like a retouch dab). */
function dab(s: Awaited<ReturnType<typeof session>>, cx: number, cy: number, r = 20) {
  const rect = { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r };
  s.ensure(rect);
  const d = s.work.data;
  for (let y = rect.y; y < rect.y + rect.height; y++)
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * W + x) * 4;
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
    }
  s.markDirty(rect);
}

function applyPatches(c: FakeCanvas, patches: BitmapPatch[], side: 'before' | 'after') {
  const list = side === 'before' ? [...patches].reverse() : patches;
  for (const p of list) {
    const img = side === 'before' ? p.before : p.after;
    for (let r = 0; r < img.height; r++) c.data.set(img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((p.y + r) * W + p.x) * 4);
  }
}

const px = (c: FakeCanvas, x: number, y: number) => Array.from(c.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));

describe('PixelSession', () => {
  it('a diagonal stroke across tiles never records or writes tiles it did not load', async () => {
    // 1) Fill the pooled buffers with another layer's pixels everywhere.
    const other = layer([200, 10, 10, 255]);
    const s0 = await session(other);
    s0.ensure({ x: 0, y: 0, width: W, height: H });
    dab(s0, 512, 384);
    s0.flush();
    expect(s0.commit('Other')).toBe(true);

    // 2) Slow diagonal stroke on a different layer, flushing every few dabs.
    const blue = layer([51, 102, 204, 255]);
    const original = blue.data.slice();
    const s = await session(blue);
    for (let i = 0; i <= 60; i++) {
      dab(s, 60 + i * 14, 60 + i * 10);
      if (i % 3 === 0) s.flush();
    }
    // Live writes never put stale pool pixels into untouched tiles.
    expect(px(blue, 800, 150)).toEqual([51, 102, 204, 255]);
    expect(px(blue, 150, 650)).toEqual([51, 102, 204, 255]);
    expect(s.commit('Dodge')).toBe(true);
    const after = blue.data.slice();
    const { patches } = commits[commits.length - 1];

    // History memory follows the stroke, not its bounding box (~900×640).
    const area = patches.reduce((n, p) => n + p.before.width * p.before.height, 0);
    expect(area).toBeLessThan(900 * 640 * 0.4);

    // Undo restores the original everywhere; redo reproduces the stroke exactly.
    applyPatches(blue, patches, 'before');
    expect(blue.data).toEqual(original);
    applyPatches(blue, patches, 'after');
    expect(blue.data).toEqual(after);
  });

  it('a single fast move (one big jump per frame) writes only the dabbed cells', async () => {
    const blue = layer([51, 102, 204, 255]);
    const s = await session(blue);
    dab(s, 40, 40);
    dab(s, 980, 720);
    s.flush();
    expect(px(blue, 500, 380)).toEqual([51, 102, 204, 255]);
    expect(px(blue, 40, 40)).toEqual([255 - 51, 255 - 102, 204, 255]);
    s.commit('Blur');
    expect(commits[commits.length - 1].patches.length).toBe(2);
  });

  it('cancel and a discarded commit (document changed) restore the touched pixels', async () => {
    const blue = layer([51, 102, 204, 255]);
    const original = blue.data.slice();
    const s = await session(blue);
    for (let i = 0; i < 20; i++) dab(s, 100 + i * 30, 100 + i * 20);
    s.flush();
    expect(blue.data).not.toEqual(original);
    s.cancel();
    expect(blue.data).toEqual(original);

    const s2 = await session(blue);
    for (let i = 0; i < 20; i++) dab(s2, 100 + i * 30, 600 - i * 20);
    s2.flush();
    valid = false;
    expect(s2.commit('Sponge')).toBe(false);
    expect(commits.length).toBe(0);
    expect(blue.data).toEqual(original);
  });
});
