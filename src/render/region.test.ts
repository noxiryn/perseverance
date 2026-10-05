import { describe, expect, it } from 'vitest';
import type { EffectDef } from '../registry';
import { filters } from '../registry';
import { EFFECT_DEFS } from './effects';
import { alignGrid, alignRect, effectInfluence, effectUsesFields, fieldBucket, fieldReach, filtersLocal, isPixelExact, mapDirtyRect, FAR } from './region';

/** Minimal affine matrix (jsdom has no DOMMatrix). */
function mat(a: number, b: number, c: number, d: number, e: number, f: number): DOMMatrix {
  return { a, b, c, d, e, f, transformPoint: (p: { x: number; y: number }) => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }) } as unknown as DOMMatrix;
}
const def = (id: string) => EFFECT_DEFS.find((d) => d.id === id) as EffectDef;

describe('dirty region mapping', () => {
  it('maps a bitmap rect 1:1 through integer translations (no margin)', () => {
    const m = mat(1, 0, 0, 1, 100, 50);
    expect(isPixelExact(m)).toBe(true);
    expect(mapDirtyRect(m, { x: 10, y: 20, width: 30, height: 40 })).toEqual({ x: 110, y: 70, w: 30, h: 40 });
  });

  it('grows resampled mappings by the filter footprint', () => {
    const frac = mat(1, 0, 0, 1, 100.4, 50);
    expect(isPixelExact(frac)).toBe(false);
    const r = mapDirtyRect(frac, { x: 10, y: 20, width: 30, height: 40 });
    expect(r.x).toBeLessThanOrEqual(110 - 4);
    expect(r.x + r.w).toBeGreaterThanOrEqual(141 + 4);
    // Rotation: the bounds of the rotated rect, grown.
    const c = Math.cos(Math.PI / 6),
      s = Math.sin(Math.PI / 6);
    const rot = mapDirtyRect(mat(c, s, -s, c, 0, 0), { x: 0, y: 0, width: 10, height: 10 });
    expect(rot.x).toBeLessThanOrEqual(-5 - 4);
    expect(rot.y).toBeLessThanOrEqual(-4);
    expect(rot.x + rot.w).toBeGreaterThanOrEqual(Math.ceil(10 * c) + 4);
    // Magnification widens the footprint.
    const up = mapDirtyRect(mat(3, 0, 0, 3, 0, 0), { x: 10, y: 10, width: 1, height: 1 });
    expect(up.x).toBeLessThanOrEqual(30 - 6);
  });

  it('extends changes touching an edge-clamped source edge to infinity', () => {
    const r = mapDirtyRect(mat(1, 0, 0, 1, 0, 0), { x: 0, y: 30, width: 10, height: 70 }, { w: 100, h: 100 });
    expect(r.x).toBe(-FAR);
    expect(r.y + r.h).toBe(FAR);
    expect(r.y).toBe(30);
  });
});

describe('alignment', () => {
  it('moves the top-left onto the grid anchored at the full rect, clipped to it', () => {
    const origin = { x: 3, y: 5, w: 500, h: 400 };
    expect(alignRect({ x: 40, y: 60, w: 10, h: 10 }, origin, 16)).toEqual({ x: 35, y: 53, w: 15, h: 17 });
    expect(alignRect({ x: 0, y: 0, w: 10, h: 10 }, origin, 16)).toEqual({ x: 3, y: 5, w: 7, h: 5 });
    expect(alignRect({ x: 600, y: 0, w: 10, h: 10 }, origin, 16)).toBeNull();
  });

  it('uses coarser grids for blurs that downsample', () => {
    expect(alignGrid(0)).toBe(16);
    expect(alignGrid(4)).toBe(16);
    expect(alignGrid(16)).toBe(16);
    expect(alignGrid(40)).toBe(32);
    expect(alignGrid(100)).toBe(64);
    expect(alignGrid(1e6)).toBe(256);
  });
});

describe('effect influence', () => {
  it('covers blur + offset for shadows and glows (scaled to output px)', () => {
    const ds = effectInfluence(def('drop-shadow'), { distance: 18, size: 24 }, 1);
    expect(ds).toBeGreaterThanOrEqual(18 + 24 * 1.25);
    expect(effectInfluence(def('drop-shadow'), { distance: 18, size: 24 }, 0.5)).toBeLessThan(ds);
    expect(effectInfluence(def('outer-glow'), { size: 30 }, 1)).toBeGreaterThanOrEqual(30 * 1.25);
  });

  it('covers the distance-field window for strokes and bevels', () => {
    const st = effectInfluence(def('stroke'), { size: 6, position: 'inside' }, 1);
    expect(st).toBeGreaterThanOrEqual(fieldBucket(8) + 2);
    expect(fieldReach(8)).toBe(fieldBucket(8) + 3);
    const bv = effectInfluence(def('bevel'), { size: 10, soften: 2 }, 1);
    expect(bv).toBeGreaterThanOrEqual(fieldBucket(12) + 2 + 3 * 4);
  });

  it('overlays are pixel-local; only field effects share distance fields', () => {
    expect(effectInfluence(def('color-overlay'), {}, 1)).toBe(2);
    expect(effectUsesFields('stroke')).toBe(true);
    expect(effectUsesFields('bevel')).toBe(true);
    expect(effectUsesFields('drop-shadow')).toBe(false);
    expect(effectUsesFields('some-plugin-effect')).toBe(true);
  });

  it('field buckets match the compositor (25% deeper, at least 2 px)', () => {
    expect(fieldBucket(6)).toBe(8);
    expect(fieldBucket(40)).toBe(50);
  });
});

describe('smart filter locality', () => {
  it('only adjustment filters are pixel-local', () => {
    filters.register({ id: 'test-local-adj', name: 'A', category: 'Adjustments', adjustment: true, params: [], apply: (img) => img });
    filters.register({ id: 'test-blur', name: 'B', category: 'Blur', params: [], apply: (img) => img });
    const inst = (filterId: string, enabled = true) => ({ id: filterId, filterId, enabled, params: {}, opacity: 1, blendMode: 'normal' as const });
    expect(filtersLocal(undefined)).toBe(true);
    expect(filtersLocal([inst('test-local-adj')])).toBe(true);
    expect(filtersLocal([inst('test-local-adj'), inst('test-blur')])).toBe(false);
    expect(filtersLocal([inst('test-blur', false)])).toBe(true);
  });
});
