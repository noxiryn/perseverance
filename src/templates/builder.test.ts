/**
 * Template builds must not depend on what was built before them in the session (release review:
 * the Group Banner rendered differently alone and after the other templates).
 *  - Placeholder characters: the canvas-height ÷ figure-height ratio used to be measured by
 *    whichever build needed a pose first (a low-resolution start-screen preview, another template at
 *    another size), and a later build skipped its exact re-render when that ratio was within 3 %.
 *  - Assets that need something before they can render faithfully (fonts of text-drawing assets,
 *    the decode of a user image) were generated before it was there: the bitmap kept the fallback.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RasterLayer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { assets } from '../registry';
import { defineAsset } from '../assets/lib/params';
import { installSoftCanvas } from '../render/softCanvas';
import { DocBuilder } from './builder';

// A stand-in figure renderer (the real one draws paths the test canvas can't): the figure spans
// 13 %–91 % of the canvas height, so its measured height carries the rounding a real one has.
vi.mock('../roblox/placeholder', () => ({
  renderPlaceholderCharacter: (o: { width: number; height: number }) => {
    const c = document.createElement('canvas');
    c.width = o.width;
    c.height = o.height;
    const k = c.getContext('2d')!;
    k.fillStyle = '#334455';
    const top = Math.round(o.height * 0.13);
    const bottom = Math.round(o.height * 0.91);
    k.fillRect(Math.round(o.width * 0.2), top, Math.max(1, Math.round(o.width * 0.6)), bottom - top);
    return c;
  },
}));

let uninstall: () => void = () => {};
beforeAll(() => {
  uninstall = installSoftCanvas();
});
afterAll(() => {
  assets.unregister('test-unready-asset');
  uninstall();
});

async function character(pose: string, height: number, preview = 1) {
  const b = new DocBuilder('t', 1000, 1000, null, { preview });
  const l = b.character({ cx: 500, top: 40, height, pose: pose as never }) as RasterLayer;
  await b.flush();
  const c = bitmaps.tryGet(l.bitmapId)!;
  return { w: c.width, h: c.height, transform: l.transform };
}

describe('template builds are independent of earlier builds', () => {
  it('a placeholder character renders the same whether its pose was built before (other size, preview) or not', async () => {
    // 'hero' fresh; 'idle' first built at preview resolution and at another size, then at the same size.
    const fresh = await character('hero', 731);
    await character('idle', 731, 0.17);
    await character('idle', 389);
    const after = await character('idle', 731);
    expect(after).toEqual(fresh);
    // and the figure is the requested height (doc px) either way
    expect(after.h * after.transform.scaleY).toBeGreaterThan(731);
  });

  it('assets that are not ready yet are generated only once they are', async () => {
    let ready = false;
    const seen: boolean[] = [];
    assets.register(
      defineAsset(
        {
          id: 'test-unready-asset',
          name: 'Unready',
          category: 'My Assets',
          sizing: 'document',
          params: [],
          generate: (_p: unknown, size: { width: number; height: number }) => {
            seen.push(ready);
            const c = document.createElement('canvas');
            c.width = size.width;
            c.height = size.height;
            return c;
          },
        } as never,
        {
          isReady: () => ready,
          prepare: async () => {
            await new Promise((r) => setTimeout(r, 5));
            ready = true;
          },
        },
      ),
    );
    const b = new DocBuilder('t', 64, 64, null);
    expect(b.asset('test-unready-asset')).not.toBeNull();
    await b.flush();
    expect(seen).toEqual([true]);
  });
});
