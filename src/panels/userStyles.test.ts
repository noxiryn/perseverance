import { describe, expect, it } from 'vitest';
import { makeFilterInstance, makeGroupLayer, makeRasterLayer } from '../core/document';
import { applyUserStyleDraft, parseUserStyles, styleFromLayer } from './userStyles';

function styledLayer() {
  const l = makeRasterLayer({ name: 'Title', bitmapId: 'b', width: 10, height: 10 });
  l.effects.push({ id: 'e1', effectId: 'stroke', enabled: true, params: { color: '#fff', size: 4 } });
  l.filters.push({ ...makeFilterInstance('halftone', { size: 6 }), opacity: 0.5 });
  return l;
}

describe('My Styles', () => {
  it('snapshots effects and optionally smart filters', () => {
    const s = styleFromLayer(styledLayer(), 'Poster', true, 'id1', 5);
    expect(s).toMatchObject({ id: 'id1', name: 'Poster', created: 5 });
    expect(s.effects).toEqual([{ effectId: 'stroke', params: { color: '#fff', size: 4 }, enabled: true }]);
    expect(s.filters).toHaveLength(1);
    expect(s.filters[0]).toMatchObject({ filterId: 'halftone', opacity: 0.5, blendMode: 'normal' });
    expect(styleFromLayer(styledLayer(), 'x', false).filters).toEqual([]);
  });

  it('applies with fresh ids, appending or replacing', () => {
    const style = styleFromLayer(styledLayer(), 'Poster', true);
    let n = 0;
    const id = (p: string) => `${p}${++n}`;
    const target = makeRasterLayer({ name: 'Other', bitmapId: 'c', width: 5, height: 5 });
    target.effects.push({ id: 'keep', effectId: 'drop-shadow', enabled: true, params: {} });
    applyUserStyleDraft(target, style, false, id);
    expect(target.effects.map((e) => e.effectId)).toEqual(['drop-shadow', 'stroke']);
    expect(target.filters.map((f) => f.filterId)).toEqual(['halftone']);
    expect(target.effects[1].id).toBe('ef_1');
    applyUserStyleDraft(target, style, true, id);
    expect(target.effects.map((e) => e.effectId)).toEqual(['stroke']);
    expect(target.filters).toHaveLength(1);
    // the stored style is not shared with the layer
    target.effects[0].params.size = 99;
    expect(style.effects[0].params.size).toBe(4);
  });

  it('skips smart filters on groups', () => {
    const g = makeGroupLayer({ name: 'G' });
    const skipped = applyUserStyleDraft(g, styleFromLayer(styledLayer(), 'P', true), false);
    expect(skipped).toBe(1);
    expect(g.effects).toHaveLength(1);
    expect(g.filters).toEqual([]);
  });

  it('parses stored styles defensively', () => {
    expect(parseUserStyles(null)).toEqual([]);
    expect(parseUserStyles([{ id: 'a' }, { id: 'b', name: 'B', effects: [{ effectId: 'stroke', params: {} }] }, 'junk'])).toHaveLength(1);
  });
});
