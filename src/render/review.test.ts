import { describe, expect, it } from 'vitest';
import { edgeDistance, pooledMapPixels, POOLED_MAP_PIXELS } from './distance';
import { blurField, bevelMaps, strokeCoverage } from './effects/math';
import { blurChannel } from '../core/blur';
import { SlotCache, resourcePixels } from './cache';
import { addSides, expandSides, flipSides, maxSides, uniformSides } from './surface';
import { effectExtent, offsetSides, workRect, type EffectArgsExt } from './effects/common';
import { dropShadow, longShadow } from './effects/shadows';
import { stroke } from './effects/stroke';

/** Deterministic pseudo random generator. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
}

/** Random binary matte made of discs and boxes. */
function matte(w: number, h: number, seed: number): Uint8Array {
  const r = rng(seed);
  const a = new Uint8Array(w * h);
  for (let k = 0; k < 6; k++) {
    const cx = r() * w,
      cy = r() * h,
      rad = 1 + r() * 9,
      box = r() < 0.3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const inside = box ? Math.abs(x + 0.5 - cx) < rad && Math.abs(y + 0.5 - cy) < rad * 0.6 : Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= rad;
        if (inside) a[y * w + x] = 255;
      }
  }
  return a;
}

/** Brute-force reference for binary mattes: distance from pixel center to the nearest site, − 0.5. */
function bruteDistance(a: Uint8Array, w: number, h: number, mode: 'outside' | 'inside', maxDist: number): Float32Array {
  const out = new Float32Array(w * h);
  const site = (i: number) => (mode === 'outside' ? a[i] >= 128 : a[i] < 128);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (site(i)) continue;
      let best = Infinity;
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) if (site(v * w + u)) best = Math.min(best, (u - x) ** 2 + (v - y) ** 2);
      const d = best === Infinity ? Infinity : Math.max(0, Math.sqrt(best) - 0.5);
      out[i] = d >= maxDist ? maxDist : d;
    }
  return out;
}

describe('distance transform (exactness & memory)', () => {
  it('matches a brute-force EDT on binary mattes for both modes and bounded depths', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const w = 23 + seed * 3,
        h = 17 + seed * 2;
      const a = matte(w, h, seed);
      for (const mode of ['outside', 'inside'] as const) {
        for (const md of [2.5, 6, 30]) {
          const got = edgeDistance(a, w, h, mode, md);
          const ref = bruteDistance(a, w, h, mode, md);
          for (let i = 0; i < got.length; i++) {
            // below maxDist values are exact; at/above it they are clamped to ≥ maxDist
            if (ref[i] < md - 1e-6) expect(got[i]).toBeCloseTo(ref[i], 5);
            else expect(got[i]).toBeGreaterThanOrEqual(md - 1e-6);
          }
        }
      }
    }
  });

  it('releases very large scratch maps after use', () => {
    const w = 2100,
      h = 2100; // > POOLED_MAP_PIXELS
    expect(w * h).toBeGreaterThan(POOLED_MAP_PIXELS);
    edgeDistance(new Uint8Array(w * h), w, h, 'outside', 4);
    expect(pooledMapPixels()).toBe(0);
    edgeDistance(new Uint8Array(64 * 64), 64, 64, 'outside', 4);
    expect(pooledMapPixels()).toBeLessThanOrEqual(POOLED_MAP_PIXELS);
  });
});

describe('effect math with shared fields', () => {
  it('blurField equals core blurChannel', () => {
    const w = 37,
      h = 23;
    const r = rng(7);
    const a = new Float32Array(w * h).map(() => r() * 10);
    const b = Float32Array.from(a);
    blurField(a, w, h, 3);
    blurChannel(b, w, h, 3);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 4);
  });

  it('stroke and bevel give identical results from a deeper cached field', () => {
    const w = 60,
      h = 44;
    const a = matte(w, h, 11);
    for (const pos of ['outside', 'inside', 'center'] as const) {
      const direct = strokeCoverage(a, w, h, 5, pos);
      // a field computed deeper than asked (as the compositor caches them) must not change anything
      const cached = strokeCoverage(a, w, h, 5, pos, (mode) => edgeDistance(a, w, h, mode, 20));
      expect(Array.from(cached)).toEqual(Array.from(direct));
    }
    for (const style of ['inner', 'emboss'] as const) {
      const o = { size: 7, depth: 1, angle: 120, altitude: 30, style, soften: 0 };
      const d1 = bevelMaps(a, w, h, o);
      const d2 = bevelMaps(a, w, h, o, (mode) => edgeDistance(a, w, h, mode, 25));
      expect(Array.from(d2.hi)).toEqual(Array.from(d1.hi));
      expect(Array.from(d2.sh)).toEqual(Array.from(d1.sh));
    }
  });
});

describe('effect regions', () => {
  it('pixel work covers the raster extent (overflow beyond the layout box), not the layout box', () => {
    // A warped/stroked text overflows its layout box: effects must see the whole extent.
    const args = {
      content: { width: 400, height: 300 } as HTMLCanvasElement,
      params: {},
      region: { x: 0, y: 0, bounds: { x: 20, y: 10, w: 360, h: 280 }, paintBox: { x: 100, y: 100, w: 200, h: 80 } },
    } as unknown as EffectArgsExt;
    const r = workRect(args, 5)!;
    expect(r.x).toBeLessThanOrEqual(20 - 5);
    expect(r.y).toBeLessThanOrEqual(10 - 5);
    expect(r.x + r.w).toBeGreaterThanOrEqual(380 + 5);
    expect(r.y + r.h).toBeGreaterThanOrEqual(290 + 5);
  });

  it('a stroke computed over the extent reaches content outside the layout box', () => {
    const w = 80,
      h = 40;
    const a = new Uint8Array(w * h);
    // layout box = x 20..60; a glyph part sticks out to x 2..10
    for (let y = 15; y < 25; y++) for (let x = 2; x < 10; x++) a[y * w + x] = 255;
    for (let y = 10; y < 30; y++) for (let x = 25; x < 55; x++) a[y * w + x] = 255;
    const cov = strokeCoverage(a, w, h, 3, 'outside');
    expect(cov[20 * w + 0]).toBe(255); // stroke around the overflowing part
    expect(cov[13 * w + 5]).toBe(255);
  });

  it('long shadow and drop shadow only grow the region in their own direction', () => {
    const ls = effectExtent(longShadow, { length: 1500, angle: 135 }, 1);
    // 135° → shadow goes down-right
    expect(ls.r).toBeGreaterThan(1000);
    expect(ls.b).toBeGreaterThan(1000);
    expect(ls.l).toBeLessThan(5);
    expect(ls.t).toBeLessThan(5);
    const ds = effectExtent(dropShadow, { distance: 40, size: 10, angle: 90 }, 2);
    // 90° → light from the top, shadow below; blur reach on every side
    expect(ds.b).toBeGreaterThan(ds.t + 70);
    expect(ds.t).toBeGreaterThan(20);
    const st = effectExtent(stroke, { size: 6, position: 'outside' }, 1);
    expect(st.l).toBe(st.r);
    expect(offsetSides(2, 10, -4)).toEqual({ l: 2, t: 6, r: 12, b: 2 });
  });

  it('per-side rect helpers', () => {
    const s = { l: 1, t: 2, r: 3.2, b: 0 };
    expect(expandSides({ x: 10, y: 10, w: 5, h: 5 }, s)).toEqual({ x: 9, y: 8, w: 10, h: 7 });
    expect(flipSides(s)).toEqual({ l: 3.2, t: 0, r: 1, b: 2 });
    expect(maxSides(s, uniformSides(2))).toEqual({ l: 2, t: 2, r: 3.2, b: 2 });
    expect(addSides(s, 1)).toEqual({ l: 2, t: 3, r: 4.2, b: 1 });
  });
});

describe('slot cache resource accounting', () => {
  it('counts shared resources once and releases them with their last entry', () => {
    const c = new SlotCache(1e9, 2);
    const canvas = { width: 100, height: 50 };
    const field = new Float32Array(400); // 400 px-equivalents
    expect(resourcePixels(field)).toBe(400);
    c.set('L|a', 's1', 'render1', 0, { res: [canvas, field] });
    c.set('L|a', 's2', 'shifted', 0, { res: [canvas, field] }); // shares everything
    expect(c.pixels).toBe(5000 + 400);
    c.set('L|a', 's3', 'other', 0, { res: [{ width: 10, height: 10 }] }); // evicts s1 (max 2)
    expect(c.pixels).toBe(5400 + 100); // still held by s2
    c.set('L|a', 's4', 'again', 0, { res: [{ width: 10, height: 10 }] }); // evicts s2
    expect(c.pixels).toBe(200);
    c.delete('L|a');
    expect(c.pixels).toBe(0);
  });

  it('targeted clears can keep composites', () => {
    const c = new SlotCache(1e9, 2);
    c.set('L|x', 's', 1, 10, { layerId: 'x' });
    c.set('D|doc', 's', 2, 20, { composite: true, layerId: 'doc:1' });
    c.clear('x', { composites: false });
    expect(c.get('L|x', 's')).toBeUndefined();
    expect(c.get('D|doc', 's')).toBe(2);
    c.clear('doc:1', { composites: false });
    expect(c.get('D|doc', 's')).toBeUndefined();
    expect(c.pixels).toBe(0);
  });
});

describe('engine & text cache keys', () => {
  it('field buckets give headroom without inflating small depths', async () => {
    const { fieldBucket } = await import('./engine');
    let prev = 0;
    for (const d of [1, 3, 6, 8, 12, 22, 60, 250]) {
      const b = fieldBucket(d);
      expect(b).toBeGreaterThanOrEqual(d + 2);
      expect(b).toBeLessThanOrEqual(Math.ceil(d * 1.25) + 2);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
    expect(fieldBucket(6)).toBe(8);
  });

  it('resetTextCaches bumps the text epoch used by raster keys and layer signatures', async () => {
    const T = await import('./text');
    const e0 = T.textCacheEpoch();
    T.resetTextCaches();
    expect(T.textCacheEpoch()).toBe(e0 + 1);
  });
});
