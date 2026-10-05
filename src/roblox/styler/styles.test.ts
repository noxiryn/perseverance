import { describe, expect, it } from 'vitest';
import type { Layer, RasterLayer } from '../../core/types';
import { STYLES, applyBuiltStyleDraft, buildStyle, readStylerMeta, resolveControls, setControlDraft, styleById } from './styles';

let n = 0;
const makeId = (p: string) => `${p}${++n}`;
const all = { hasFilter: () => true, hasEffect: () => true };
const robloxOnly = { hasFilter: (id: string) => ['rim-light', 'top-shade', 'silhouette', 'toon-roblox'].includes(id), hasEffect: () => false };

function layer(): RasterLayer {
  return {
    id: 'L1',
    name: 'Char',
    type: 'raster',
    visible: true,
    locks: { pixels: false, position: false, transparency: false, all: false },
    opacity: 1,
    fillOpacity: 1,
    blendMode: 'normal',
    clipped: false,
    mask: null,
    effects: [{ id: 'user-e', effectId: 'stroke', enabled: true, params: {} }],
    filters: [{ id: 'user-f', filterId: 'gaussian-blur', enabled: true, params: {} }],
    label: 'none',
    bitmapId: 'b',
    width: 10,
    height: 10,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    meta: { roblox: { kind: 'character' } },
  };
}

describe('character styles', () => {
  it('defines the 8 required styles with unique ids', () => {
    expect(STYLES.map((s) => s.name)).toEqual(['Toon Ink', 'Comic Halftone', 'Noir Shadow', 'Crimson Rim', 'Gothic Poster', 'Neon Edge', 'Silhouette', 'Painterly']);
    expect(new Set(STYLES.map((s) => s.id)).size).toBe(STYLES.length);
    for (const s of STYLES) {
      // every control targets a spec of the style
      for (const c of s.controls) {
        const keys = c.kind === 'filter' ? s.filters.map((f) => f.key) : s.effects.map((e) => e.key);
        expect(keys).toContain(c.target);
      }
    }
  });

  it('every style still works with only the Roblox filters registered', () => {
    for (const s of STYLES) {
      const built = buildStyle(s, robloxOnly, makeId);
      expect(built.filters.length).toBeGreaterThan(0);
      expect(built.effects).toEqual([]);
    }
  });

  it('prefers other modules filters when present, falling back otherwise', () => {
    const toon = styleById('toon-ink')!;
    expect(buildStyle(toon, all, makeId).meta.filters.base.filterId).toBe('cel-shade');
    expect(buildStyle(toon, robloxOnly, makeId).meta.filters.base.filterId).toBe('toon-roblox');
  });

  it('shades the face before posterizing, so the hair shadow is banded', () => {
    for (const s of STYLES) {
      const keys = s.filters.map((f) => f.key);
      if (!keys.includes('face') || !keys.includes('base')) continue;
      expect(keys.indexOf('face')).toBeLessThan(keys.indexOf('base'));
    }
  });

  it('adds optional stages only when their filters exist', () => {
    const comic = styleById('comic-halftone')!;
    expect(buildStyle(comic, all, makeId).meta.filters.amber?.filterId).toBe('gradient-map');
    expect(buildStyle(comic, robloxOnly, makeId).meta.filters.amber).toBeUndefined();
    const crimson = styleById('crimson-rim')!;
    expect(buildStyle(crimson, all, makeId).meta.filters.halftone?.filterId).toBe('halftone');
    expect(buildStyle(crimson, robloxOnly, makeId).meta.filters.halftone).toBeUndefined();
  });

  it('replaces only what the styler added', () => {
    const l = layer();
    const a = buildStyle(styleById('crimson-rim')!, all, makeId);
    applyBuiltStyleDraft(l, a);
    expect(l.filters[0].id).toBe('user-f');
    expect(l.filters.length).toBe(1 + a.filters.length);
    expect(l.effects.length).toBe(1 + a.effects.length);
    expect(readStylerMeta(l)?.style).toBe('crimson-rim');
    expect((l.meta as Record<string, unknown>).roblox).toEqual({ kind: 'character' });

    const b = buildStyle(styleById('silhouette')!, all, makeId);
    const removed = applyBuiltStyleDraft(l, b);
    expect(removed).toBe(a.filters.length + a.effects.length);
    expect(l.filters.map((f) => f.id)).toEqual(['user-f', ...b.filters.map((f) => f.id)]);
    expect(l.effects.map((e) => e.id)).toEqual(['user-e', ...b.effects.map((e) => e.id)]);

    applyBuiltStyleDraft(l, null);
    expect(l.filters.map((f) => f.id)).toEqual(['user-f']);
    expect(l.effects.map((e) => e.id)).toEqual(['user-e']);
    expect(readStylerMeta(l)).toBeNull();
  });

  it('binds controls to the right instance + param (alternative filters map param names)', () => {
    const l = layer();
    const style = styleById('toon-ink')!;
    applyBuiltStyleDraft(l, buildStyle(style, robloxOnly, makeId));
    const rcs = resolveControls(style, l);
    const outline = rcs.find((r) => r.control.id === 'outline')!;
    expect(outline.defId).toBe('toon-roblox');
    expect(outline.param).toBe('outlineWidth');
    setControlDraft(l as Layer, outline, 6);
    expect(l.filters.find((f) => f.id === outline.instanceId)!.params.outlineWidth).toBe(6);

    const l2 = layer();
    applyBuiltStyleDraft(l2, buildStyle(style, all, makeId));
    const o2 = resolveControls(style, l2).find((r) => r.control.id === 'outline')!;
    expect(o2.defId).toBe('cel-shade');
    expect(o2.param).toBe('outlineThickness');
  });

  it('drops controls whose instance was removed by the user', () => {
    const l = layer();
    const style = styleById('noir-shadow')!;
    applyBuiltStyleDraft(l, buildStyle(style, all, makeId));
    const before = resolveControls(style, l).length;
    l.effects = l.effects.filter((e) => e.effectId !== 'drop-shadow');
    expect(resolveControls(style, l).length).toBeLessThan(before);
    expect(resolveControls(styleById('toon-ink')!, l)).toEqual([]); // other style: nothing bound
  });

  it('readStylerMeta is defensive', () => {
    expect(readStylerMeta(null)).toBeNull();
    expect(readStylerMeta({ meta: { styler: 'x' } })).toBeNull();
    expect(readStylerMeta({ meta: { styler: { style: 'a' } } })).toEqual({ style: 'a', filters: {}, effects: {} });
  });
});
