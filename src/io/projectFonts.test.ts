import { describe, expect, it } from 'vitest';
import { createDocument, insertLayerDraft, makeTextLayer } from '../core/document';
import { documentFamilies, listFamilies, missingFamilies } from './projectFonts';

function docWithFonts(...families: string[]) {
  const doc = createDocument({ width: 100, height: 100, background: null });
  for (const f of families) {
    const l = makeTextLayer({ text: { content: 'Hi' } });
    l.text.fontFamily = f;
    insertLayerDraft(doc, l, {});
  }
  return doc;
}

describe('project fonts', () => {
  it('lists the families used by text layers once, ignoring case and quotes', () => {
    const doc = docWithFonts('Bebas Neue', 'My Brush', '"bebas neue"', 'My Brush', '');
    expect(documentFamilies(doc)).toEqual(['Bebas Neue', 'My Brush']);
  });

  it('reports the families that are not available', () => {
    const have = new Set(['Bebas Neue']);
    expect(missingFamilies(['Bebas Neue', 'My Brush', 'Fancy'], (f) => have.has(f))).toEqual(['My Brush', 'Fancy']);
  });

  it('keeps toast lists short', () => {
    expect(listFamilies(['A'])).toBe('A');
    expect(listFamilies(['A', 'B', 'C'])).toBe('A, B, C');
    expect(listFamilies(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more');
  });
});
