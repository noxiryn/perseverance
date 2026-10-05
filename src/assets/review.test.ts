/**
 * Regression tests for the review fixes: thumbnail scheduling policy, grain tile hashing,
 * user-asset import sizing/summaries and the collision-free tendril layout.
 * (jsdom has no canvas — only pure logic is tested here.)
 */
import { describe, expect, it } from 'vitest';
import { mayRun } from './lib/thumbs';
import { grainHash } from './lib/field';
import { importSize, importSummary, isSvg, SVG_SIDE } from './lib/userAssets';
import { curlClear, layoutSide, stemPenalty } from './generators/tendrils';
import type { PlacedCurl } from './generators/tendrils';
import { makeRand } from './lib/util';

describe('thumbnail idle scheduling', () => {
  it('starts jobs that fit the remaining idle time', () => {
    expect(mayRun(8, 12, 3, false)).toBe(true);
    expect(mayRun(13, 12, 3, false)).toBe(true); // within the 2 ms tolerance
  });
  it('lets one small job overrun a slice, but only as the first job', () => {
    expect(mayRun(20, 5, 0, false)).toBe(true);
    expect(mayRun(20, 5, 1, false)).toBe(false);
  });
  it('defers heavy jobs until the queue is starving, then runs one', () => {
    expect(mayRun(90, 10, 0, false)).toBe(false);
    expect(mayRun(90, 10, 0, true)).toBe(true);
    expect(mayRun(90, 10, 2, true)).toBe(false);
  });
});

describe('grain tile hashing', () => {
  it('is deterministic and spreads seeds over variants, offsets and turns', () => {
    expect(grainHash(7)).toBe(grainHash(7));
    expect(grainHash(7.2)).toBe(grainHash(7));
    const variants = new Set<number>();
    const offsets = new Set<number>();
    for (let s = 0; s < 64; s++) {
      const h = grainHash(s);
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
      variants.add(h & 3);
      offsets.add((h >>> 4) & 255);
    }
    expect(variants.size).toBe(4);
    expect(offsets.size).toBeGreaterThan(40);
    expect(grainHash(-5)).toBeGreaterThanOrEqual(0);
  });
});

describe('user asset import', () => {
  it('clamps bitmaps and rasterizes vectors at a crisp size', () => {
    expect(importSize(8000, 2000, false)).toEqual({ width: 4096, height: 1024 });
    expect(importSize(300, 200, false)).toEqual({ width: 300, height: 200 });
    expect(importSize(100, 50, true)).toEqual({ width: SVG_SIDE, height: SVG_SIDE / 2 });
    expect(importSize(24, 24, true)).toEqual({ width: SVG_SIDE, height: SVG_SIDE });
  });
  it('recognizes SVG by type or extension', () => {
    expect(isSvg('logo.svg', new Blob([], { type: '' }))).toBe(true);
    expect(isSvg('logo', new Blob([], { type: 'image/svg+xml' }))).toBe(true);
    expect(isSvg('logo.png', new Blob([], { type: 'image/png' }))).toBe(false);
  });
  it('summarizes partial failures in one message', () => {
    expect(importSummary(['logo'], [])).toEqual({ message: 'Added “logo” to My Assets', kind: 'success' });
    expect(importSummary(['a', 'b'], [])).toEqual({ message: 'Added 2 images to My Assets', kind: 'success' });
    const mixed = importSummary(['logo'], ['bad.png']);
    expect(mixed.kind).toBe('warning');
    expect(mixed.message).toContain('Added “logo”');
    expect(mixed.message).toContain('“bad.png” could not be read as an image');
    const none = importSummary([], ['a.png', 'b.png', 'c.png']);
    expect(none.kind).toBe('error');
    expect(none.message).toBe('3 files could not be read as images.');
  });
});

describe('swirl tendril layout', () => {
  const opts = { width: 32, scale: 1, angular: true, spurs: 0 };
  it('never lets two curls touch (every spiral reads as its own shape)', () => {
    for (const [W, H] of [
      [1024, 1024],
      [1920, 1080],
      [512, 512],
    ]) {
      const u = Math.min(W, H) / 1000;
      for (let seed = 1; seed <= 12; seed++) {
        const { groups, curls } = layoutSide(W, H, u, makeRand(seed), 4, false, { ...opts, width: 32 * u });
        expect(groups.length).toBeGreaterThan(0);
        for (let a = 0; a < curls.length; a++) {
          for (let b = a + 1; b < curls.length; b++) {
            const ca = curls[a];
            const cb = curls[b];
            expect(Math.hypot(ca.x - cb.x, ca.y - cb.y)).toBeGreaterThanOrEqual(ca.R + cb.R);
          }
        }
      }
    }
  });
  it('detects clearance and stem collisions', () => {
    const curls: PlacedCurl[] = [{ x: 100, y: 100, R: 40, W: 10 }];
    expect(curlClear(curls, 100, 160, 30, 10)).toBe(false);
    expect(curlClear(curls, 100, 200, 30, 10)).toBe(true);
    const own = { x: 300, y: 100, R: 30, W: 10 };
    const through = Array.from({ length: 11 }, (_, i) => ({ x: 100, y: 300 - i * 30 })); // passes the curl at (100,100)
    const clear = Array.from({ length: 11 }, (_, i) => ({ x: 400, y: 300 - i * 30 }));
    const band = { maxX: 1000, minY: -1000 };
    expect(stemPenalty(through, 10, own, curls, [], band)).toBeGreaterThan(0);
    expect(stemPenalty(clear, 10, own, curls, [], band)).toBe(0);
  });
  it('is deterministic for a seed', () => {
    const a = layoutSide(1024, 1024, 1, makeRand(9), 3, false, opts);
    const b = layoutSide(1024, 1024, 1, makeRand(9), 3, false, opts);
    expect(a.curls).toEqual(b.curls);
    expect(a.groups.map((g) => g.polys.length)).toEqual(b.groups.map((g) => g.polys.length));
  });
});
