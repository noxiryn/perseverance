import { describe, expect, it } from 'vitest';
import { createDocument, insertLayerDraft, makeFilterInstance, makeRasterLayer } from '../core/document';
import { parseTemplateMetas, templateDocument } from './userTemplates';

describe('Save as Template', () => {
  it('marks the chosen character as the placeholder and records its treatment', () => {
    const doc = createDocument({ name: 'Ep 1', width: 1920, height: 1080 });
    const ch = makeRasterLayer({ name: 'Hero', bitmapId: 'b', width: 10, height: 10 });
    const f = makeFilterInstance('halftone');
    ch.filters.push(f);
    ch.meta = { kind: 'character', styler: { style: 'x', filters: { a: { id: f.id } }, effects: {} } };
    insertLayerDraft(doc, ch);
    doc.selection = { bitmapId: 's', bounds: { x: 0, y: 0, width: 1, height: 1 } };
    const t = templateDocument(doc, 'user-tpl:1', ch.id);
    const l = t.layers[ch.id];
    expect(l.meta).toMatchObject({ placeholder: true, kind: 'character', templateStyle: { filterIds: [f.id], effectIds: [] } });
    expect(l.meta?.styler).toBeUndefined();
    expect(t.meta).toMatchObject({ template: 'user-tpl:1', characterId: ch.id });
    expect(t.selection).toBeNull();
    // the open document is untouched
    expect(doc.layers[ch.id].meta?.placeholder).toBeUndefined();
  });

  it('can save without a character', () => {
    const doc = createDocument({ name: 'Ep 1', width: 100, height: 100 });
    doc.meta = { characterId: 'gone' };
    expect(templateDocument(doc, 'user-tpl:2', null).meta).toEqual({ template: 'user-tpl:2' });
  });

  it('parses the stored index defensively', () => {
    expect(parseTemplateMetas([{ id: 'user-tpl:a', name: 'A', width: 10, height: 10, created: 1 }, { id: 'tpl-x', name: 'B', width: 1, height: 1 }, null])).toHaveLength(1);
  });
});
