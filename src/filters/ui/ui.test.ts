import { describe, expect, it } from 'vitest';
import type { FilterDef } from '../../registry';
import { blendSelection, diffBounds } from './selectionBlend';
import { LIVE_PREVIEW_FILTER_ID, categoriesOf, categoryRank, isBrowsableFilter, matchesQuery, sortFilters } from './galleryModel';
import { getLastFilter, rememberParams, rememberedParams, setLastFilter, subscribeLastFilter } from './memory';

const f = (id: string, category: FilterDef['category'], extra: Partial<FilterDef> = {}): FilterDef => ({
  id,
  name: id.replace(/-/g, ' '),
  category,
  params: [],
  apply: (img) => img,
  ...extra,
});

describe('gallery model', () => {
  it('hides adjustment-only color filters but keeps creative adjustments like vignette', () => {
    expect(isBrowsableFilter(f('levels', 'Adjustments', { adjustment: true }))).toBe(false);
    expect(isBrowsableFilter(f('hue-saturation', 'Color', { adjustment: true }))).toBe(false);
    expect(isBrowsableFilter(f('vignette', 'Light', { adjustment: true }))).toBe(true);
    expect(isBrowsableFilter(f('halftone', 'Comic & Print'))).toBe(true);
    expect(isBrowsableFilter(f('rim-light', 'Roblox'))).toBe(true);
    // the internal on-canvas preview filter is never listed
    expect(isBrowsableFilter(f(LIVE_PREVIEW_FILTER_ID, 'Other'))).toBe(false);
  });

  it('sorts by category order then name and counts categories', () => {
    const list = sortFilters([f('wave', 'Distort'), f('cel-shade', 'Stylize'), f('blur', 'Blur'), f('emboss', 'Stylize')]);
    expect(list.map((x) => x.id)).toEqual(['cel-shade', 'emboss', 'blur', 'wave']);
    expect(categoriesOf(list)).toEqual([
      { category: 'Stylize', count: 2 },
      { category: 'Blur', count: 1 },
      { category: 'Distort', count: 1 },
    ]);
    expect(categoryRank('Roblox')).toBeGreaterThan(categoryRank('Retro & Glitch'));
    expect(categoryRank('Nope')).toBeGreaterThan(categoryRank('Adjustments'));
  });

  it('matches every query word against name, id, category and keywords', () => {
    const h = f('halftone', 'Comic & Print', { keywords: ['dots', 'manga'], description: 'Print screen' });
    expect(matchesQuery(h, '')).toBe(true);
    expect(matchesQuery(h, 'DOTS')).toBe(true);
    expect(matchesQuery(h, 'comic manga')).toBe(true);
    expect(matchesQuery(h, 'comic blur')).toBe(false);
  });
});

describe('selection blending', () => {
  it('keeps the original outside, the result inside and blends premultiplied at soft edges', () => {
    const orig = new Uint8ClampedArray([200, 0, 0, 255, 200, 0, 0, 255, 0, 0, 0, 0]);
    const out = new Uint8ClampedArray([0, 0, 200, 255, 0, 0, 200, 255, 0, 200, 0, 255]);
    blendSelection(orig, out, new Uint8ClampedArray([0, 255, 128]));
    expect(Array.from(out.slice(0, 4))).toEqual([200, 0, 0, 255]);
    expect(Array.from(out.slice(4, 8))).toEqual([0, 0, 200, 255]);
    // transparent original + opaque green result at 50% → half-transparent pure green (no dark fringe)
    expect(out[9]).toBe(200);
    expect(out[11]).toBeGreaterThan(120);
    expect(out[11]).toBeLessThan(135);
  });
});

describe('diff bounds', () => {
  it('finds the changed rectangle (or null)', () => {
    const w = 6,
      h = 5;
    const a = new Uint8ClampedArray(w * h * 4);
    const b = new Uint8ClampedArray(a);
    expect(diffBounds(a, b, w, h)).toBeNull();
    b[(1 * w + 2) * 4 + 1] = 9;
    b[(3 * w + 4) * 4 + 3] = 9;
    expect(diffBounds(a, b, w, h)).toEqual({ x: 2, y: 1, width: 3, height: 3 });
  });
});

describe('filter memory', () => {
  const def = f('halftone', 'Comic & Print', {
    params: [
      { type: 'number', key: 'size', label: 'Size', min: 2, max: 80, default: 8 },
      { type: 'select', key: 'mode', label: 'Mode', options: [{ value: 'mono', label: 'Mono' }, { value: 'cmyk', label: 'CMYK' }], default: 'mono' },
      { type: 'boolean', key: 'transparentPaper', label: 'T', default: false },
    ],
  });

  it('remembers params merged over defaults and drops values of the wrong shape', () => {
    expect(rememberedParams(def)).toEqual({ size: 8, mode: 'mono', transparentPaper: false });
    rememberParams('halftone', { size: 14, mode: 'bogus', transparentPaper: 'yes' as unknown as boolean, stale: 3 });
    expect(rememberedParams(def)).toEqual({ size: 14, mode: 'mono', transparentPaper: false });
  });

  it('tracks the last filter and notifies listeners', () => {
    let calls = 0;
    const off = subscribeLastFilter(() => calls++);
    const params = { size: 10 };
    setLastFilter({ filterId: 'halftone', params, mode: 'smart' });
    params.size = 99; // stored as a copy
    expect(getLastFilter()).toEqual({ filterId: 'halftone', params: { size: 10 }, mode: 'smart' });
    expect(calls).toBe(1);
    off();
  });
});
