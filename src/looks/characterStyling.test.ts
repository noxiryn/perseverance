import { describe, expect, it } from 'vitest';
import type { FilterInstance, Layer, LayerEffect } from '../core/types';
import {
  adoptTemplateStylingDraft,
  hasCharacterStyling,
  ownedIds,
  restoreCharacterStylingDraft,
  restylesCharacter,
  stripCharacterStylingDraft,
  stylingOwnersOn,
  takeCharacterStylingDraft,
  templateStyleOf,
} from './characterStyling';

const f = (id: string, filterId = 'halftone'): FilterInstance => ({ id, filterId, enabled: true, params: {}, opacity: 1, blendMode: 'normal' });
const e = (id: string, effectId = 'outer-glow'): LayerEffect => ({ id, effectId, enabled: true, params: {} });

function layer(meta: Record<string, unknown>, filters: FilterInstance[], effects: LayerEffect[]): Layer {
  return {
    id: 'L',
    name: 'Character',
    type: 'raster',
    visible: true,
    locks: { pixels: false, position: false, transparency: false, all: false },
    opacity: 1,
    fillOpacity: 1,
    blendMode: 'normal',
    clipped: false,
    mask: null,
    effects,
    filters,
    label: 'none',
    meta,
    bitmapId: 'b',
    width: 10,
    height: 10,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  };
}

/** Template placeholder with gradient-map + halftone + glow, a styler style and a user filter. */
function crimson(): Layer {
  return layer(
    {
      placeholder: true,
      templateStyle: { filterIds: ['t1', 't2'], effectIds: ['te'] },
      styler: { style: 'comic-halftone', filters: { base: { id: 's1', filterId: 'cel-shade' } }, effects: {} },
      look: { lookId: 'crimson-film', filterIds: ['k1'], effectIds: ['ke'] },
    },
    [f('t1', 'gradient-map'), f('t2'), f('u1', 'sharpen'), f('s1', 'cel-shade'), f('k1', 'gradient-map')],
    [e('te'), e('ke'), e('ue', 'stroke')],
  );
}

describe('character styling ownership', () => {
  it('reads the ids each owner added', () => {
    const l = crimson();
    expect(ownedIds(l, 'template')).toEqual({ filterIds: ['t1', 't2'], effectIds: ['te'] });
    expect(ownedIds(l, 'styler')).toEqual({ filterIds: ['s1'], effectIds: [] });
    expect(ownedIds(l, 'look')).toEqual({ filterIds: ['k1'], effectIds: ['ke'] });
    expect(stylingOwnersOn(l)).toEqual(['template', 'styler', 'look']);
  });

  it('a style replaces the template and look treatment but keeps the user’s own filters', () => {
    const l = crimson();
    const removed = stripCharacterStylingDraft(l, ['template', 'look']);
    expect(removed).toBe(5);
    expect(l.filters.map((x) => x.id)).toEqual(['u1', 's1']);
    expect(l.effects.map((x) => x.id)).toEqual(['ue']);
    expect(l.meta?.templateStyle).toBeUndefined();
    expect(l.meta?.look).toBeUndefined();
    expect(l.meta?.styler).toBeDefined();
    expect(l.meta?.placeholder).toBe(true);
  });

  it('reset removes every owner', () => {
    const l = crimson();
    stripCharacterStylingDraft(l, ['template', 'styler', 'look']);
    expect(l.filters.map((x) => x.id)).toEqual(['u1']);
    expect(hasCharacterStyling(l)).toBe(false);
  });

  it('can strip only duplicate effect types (a look that only adds a glow)', () => {
    const l = crimson();
    stripCharacterStylingDraft(l, ['template', 'styler'], { onlyEffectTypes: new Set(['outer-glow']) });
    expect(l.effects.map((x) => x.id)).toEqual(['ke', 'ue']);
    expect(l.filters).toHaveLength(5);
    expect(l.meta?.templateStyle).toBeDefined();
  });

  it('adopts the treatment of an older placeholder that has no record', () => {
    const l = layer({ placeholder: true, kind: 'character' }, [f('a', 'gradient-map'), f('b')], [e('c')]);
    expect(ownedIds(l, 'template')).toBeNull();
    adoptTemplateStylingDraft(l);
    expect(ownedIds(l, 'template')).toEqual({ filterIds: ['a', 'b'], effectIds: ['c'] });
    // Not for ordinary layers.
    const plain = layer({}, [f('x')], []);
    adoptTemplateStylingDraft(plain);
    expect(ownedIds(plain, 'template')).toBeNull();
  });

  it('templateStyleOf skips instances owned by the styler or a look', () => {
    const l = crimson();
    expect(templateStyleOf(l)).toEqual({ filterIds: ['t1', 't2', 'u1'], effectIds: ['te', 'ue'] });
  });

  it('take + restore puts the replaced treatment back in place', () => {
    const l = crimson();
    const before = JSON.parse(JSON.stringify({ filters: l.filters, effects: l.effects, meta: l.meta }));
    const rep = takeCharacterStylingDraft(l, ['template', 'styler']);
    expect(rep?.filters.map((x) => [x.index, x.instance.id])).toEqual([
      [0, 't1'],
      [1, 't2'],
      [3, 's1'],
    ]);
    expect(Object.keys(rep!.records).sort()).toEqual(['styler', 'templateStyle']);
    expect(l.filters.map((x) => x.id)).toEqual(['u1', 'k1']);
    restoreCharacterStylingDraft(l, rep);
    expect(JSON.parse(JSON.stringify({ filters: l.filters, effects: l.effects, meta: l.meta }))).toEqual(before);
    // nothing to take → null; restoring twice doesn't duplicate
    expect(takeCharacterStylingDraft(layer({}, [f('x')], []), ['template'])).toBeNull();
    restoreCharacterStylingDraft(l, rep);
    expect(l.filters).toHaveLength(5);
  });

  it('a partial strip by filter type keeps the other instances and the records', () => {
    const l = crimson();
    const rep = takeCharacterStylingDraft(l, ['template', 'styler'], { onlyFilterTypes: new Set(['cel-shade']), onlyEffectTypes: new Set(['outer-glow']) });
    expect(l.filters.map((x) => x.id)).toEqual(['t1', 't2', 'u1', 'k1']);
    expect(l.effects.map((x) => x.id)).toEqual(['ke', 'ue']);
    expect(rep?.records).toEqual({});
    expect(l.meta?.templateStyle).toBeDefined();
    expect(l.meta?.styler).toBeDefined();
  });

  it('knows restyling filters from additive ones', () => {
    expect(restylesCharacter(['rim-light', 'glitch'])).toBe(false);
    expect(restylesCharacter(['rim-light', 'gradient-map'])).toBe(true);
    expect(restylesCharacter(['cel-shade'])).toBe(true);
  });
});
