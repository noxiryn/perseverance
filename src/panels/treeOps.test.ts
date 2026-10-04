import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import type { Document, GroupLayer, Layer } from '../core/types';
import { createDocument, insertLayerDraft, makeFillLayer, makeGroupLayer, makeRasterLayer, makeTextLayer } from '../core/document';
import {
  ancestorsOf,
  arrangeDraft,
  canMoveInto,
  cloneLayerTree,
  copyName,
  descendantsOf,
  isFilterActive,
  layerBelow,
  layerMatchesKind,
  moveLayersDraft,
  orderedTopLevel,
  panelRows,
  resolveDrop,
  soloVisibility,
} from './treeOps';

/**
 * Test document (bottom → top):
 *   root: bg, a, G[ g1, g2, H[ h1 ] ], b
 */
function makeDoc() {
  const doc = createDocument({ name: 'T', width: 100, height: 80 });
  const named = <T extends Layer>(l: T, name: string): T => ({ ...l, id: name, name });
  const bg = named(makeFillLayer({ fill: { type: 'solid', color: '#fff' } }), 'bg');
  const a = named(makeRasterLayer({ bitmapId: 'bmp_a', width: 100, height: 80 }), 'a');
  const G = named(makeGroupLayer({}), 'G');
  const g1 = named(makeRasterLayer({ bitmapId: 'bmp_g1', width: 10, height: 10 }), 'g1');
  const g2 = named(makeTextLayer({ text: { content: 'Hi' } }), 'g2');
  const H = named(makeGroupLayer({}), 'H');
  const h1 = named(makeRasterLayer({ bitmapId: 'bmp_h1', width: 10, height: 10 }), 'h1');
  const b = named(makeTextLayer({}), 'b');
  for (const l of [bg, a, G]) insertLayerDraft(doc, l);
  insertLayerDraft(doc, g1, { parentId: 'G' });
  insertLayerDraft(doc, g2, { parentId: 'G' });
  insertLayerDraft(doc, H, { parentId: 'G' });
  insertLayerDraft(doc, h1, { parentId: 'H' });
  insertLayerDraft(doc, b);
  return doc;
}

const children = (d: Document, id: string) => (d.layers[id] as GroupLayer).childIds;

describe('selection helpers', () => {
  it('orderedTopLevel drops descendants of selected groups and sorts bottom → top', () => {
    const doc = makeDoc();
    expect(orderedTopLevel(doc, ['b', 'h1', 'G', 'a', 'nope'])).toEqual(['a', 'G', 'b']);
    expect(orderedTopLevel(doc, ['h1', 'g1'])).toEqual(['g1', 'h1']);
    expect(orderedTopLevel(doc, [])).toEqual([]);
  });

  it('descendants and ancestors', () => {
    const doc = makeDoc();
    expect(descendantsOf(doc, 'G')).toEqual(['g1', 'g2', 'H', 'h1']);
    expect(descendantsOf(doc, 'a')).toEqual([]);
    expect(ancestorsOf(doc, 'h1')).toEqual(['H', 'G']);
    expect(ancestorsOf(doc, 'b')).toEqual([]);
  });

  it('layerBelow returns the sibling below or null', () => {
    const doc = makeDoc();
    expect(layerBelow(doc, 'a')).toBe('bg');
    expect(layerBelow(doc, 'bg')).toBeNull();
    expect(layerBelow(doc, 'g2')).toBe('g1');
    expect(layerBelow(doc, 'g1')).toBeNull();
  });
});

describe('moving', () => {
  it('canMoveInto refuses a group into itself or its descendants', () => {
    const doc = makeDoc();
    expect(canMoveInto(doc, ['G'], 'H')).toBe(false);
    expect(canMoveInto(doc, ['G'], 'G')).toBe(false);
    expect(canMoveInto(doc, ['a'], 'H')).toBe(true);
    expect(canMoveInto(doc, ['a'], 'a')).toBe(false); // not a group
    expect(canMoveInto(doc, ['h1'], null)).toBe(true);
  });

  it('moves within the same list using the pre-move index', () => {
    const doc = makeDoc();
    // Move bg to the top of root (index = length before the move).
    const d = produce(doc, (dr) => void moveLayersDraft(dr, ['bg'], null, dr.rootIds.length));
    expect(d.rootIds).toEqual(['a', 'G', 'b', 'bg']);
    // Move b down to just above bg.
    const d2 = produce(doc, (dr) => void moveLayersDraft(dr, ['b'], null, 1));
    expect(d2.rootIds).toEqual(['bg', 'b', 'a', 'G']);
  });

  it('moves several layers into a group, preserving their order', () => {
    const doc = makeDoc();
    const d = produce(doc, (dr) => void moveLayersDraft(dr, ['a', 'b'], 'H', 0));
    expect(children(d, 'H')).toEqual(['a', 'b', 'h1']);
    expect(d.rootIds).toEqual(['bg', 'G']);
  });

  it('rejects invalid moves without touching the document', () => {
    const doc = makeDoc();
    let ok = true;
    const d = produce(doc, (dr) => void (ok = moveLayersDraft(dr, ['G'], 'H', 0)));
    expect(ok).toBe(false);
    expect(d).toBe(doc);
  });

  it('resolveDrop maps panel zones to (parent, index)', () => {
    const doc = makeDoc();
    // Panel shows top → bottom; "above" a row = higher index in the bottom→top list.
    expect(resolveDrop(doc, 'a', 'above')).toEqual({ parentId: null, index: 2 });
    expect(resolveDrop(doc, 'a', 'below')).toEqual({ parentId: null, index: 1 });
    expect(resolveDrop(doc, 'G', 'into')).toEqual({ parentId: 'G', index: 3 });
    // Below an expanded group = top of its children.
    expect(resolveDrop(doc, 'G', 'below')).toEqual({ parentId: 'G', index: 3 });
    const collapsed = produce(doc, (dr) => void ((dr.layers.G as GroupLayer).collapsed = true));
    expect(resolveDrop(collapsed, 'G', 'below')).toEqual({ parentId: null, index: 2 });
    expect(resolveDrop(doc, 'missing', 'above')).toBeNull();
  });
});

describe('arrange', () => {
  it('brings to front / sends to back within each sibling list', () => {
    const doc = makeDoc();
    expect(produce(doc, (d) => void arrangeDraft(d, ['bg'], 'front')).rootIds).toEqual(['a', 'G', 'b', 'bg']);
    expect(produce(doc, (d) => void arrangeDraft(d, ['b'], 'back')).rootIds).toEqual(['b', 'bg', 'a', 'G']);
    const d = produce(doc, (dr) => void arrangeDraft(dr, ['g1', 'a'], 'front'));
    expect(d.rootIds).toEqual(['bg', 'G', 'b', 'a']);
    expect(children(d, 'G')).toEqual(['g2', 'H', 'g1']);
  });

  it('forward / backward move one step and keep selected blocks together', () => {
    const doc = makeDoc();
    expect(produce(doc, (d) => void arrangeDraft(d, ['a'], 'forward')).rootIds).toEqual(['bg', 'G', 'a', 'b']);
    expect(produce(doc, (d) => void arrangeDraft(d, ['a', 'G'], 'forward')).rootIds).toEqual(['bg', 'b', 'a', 'G']);
    expect(produce(doc, (d) => void arrangeDraft(d, ['G', 'b'], 'backward')).rootIds).toEqual(['bg', 'G', 'b', 'a']);
    // Already at the top: no change.
    let changed = true;
    const same = produce(doc, (d) => void (changed = arrangeDraft(d, ['b'], 'forward')));
    expect(changed).toBe(false);
    expect(same.rootIds).toEqual(doc.rootIds);
  });
});

describe('duplicating', () => {
  it('copyName follows Photoshop naming', () => {
    const taken = new Set(['Layer 1', 'Layer 1 copy']);
    expect(copyName('Layer 2', taken)).toBe('Layer 2 copy');
    expect(copyName('Layer 1', taken)).toBe('Layer 1 copy 2');
    expect(copyName('Layer 1 copy', taken)).toBe('Layer 1 copy 2');
  });

  it('cloneLayerTree deep copies groups with fresh ids and duplicated bitmaps', () => {
    const doc = produce(makeDoc(), (d) => {
      d.layers.h1.mask = { bitmapId: 'bmp_mask', enabled: true, density: 1, feather: 0, inverted: false };
      d.layers.g1.effects = [{ id: 'e1', effectId: 'stroke', enabled: true, params: { size: 3 } }];
    });
    let n = 0;
    const dup: string[] = [];
    const res = cloneLayerTree(doc, 'G', {
      newId: (p) => `${p}${++n}`,
      dupBitmap: (b) => (dup.push(b), `${b}_dup`),
    });
    expect(res.layers).toHaveLength(5);
    const root = res.layers.find((l) => l.id === res.rootId) as GroupLayer;
    expect(root.name).toBe('G copy');
    expect(root.childIds).toHaveLength(3);
    // Children keep their names; every id is new.
    const ids = new Set(res.layers.map((l) => l.id));
    for (const id of ['G', 'g1', 'g2', 'H', 'h1']) expect(ids.has(id)).toBe(false);
    expect(res.layers.map((l) => l.name).sort()).toEqual(['G copy', 'H', 'g1', 'g2', 'h1']);
    expect(dup.sort()).toEqual(['bmp_g1', 'bmp_h1', 'bmp_mask']);
    const h1c = res.layers.find((l) => l.name === 'h1')!;
    expect(h1c.mask?.bitmapId).toBe('bmp_mask_dup');
    const g1c = res.layers.find((l) => l.name === 'g1')!;
    expect(g1c.effects[0].id).not.toBe('e1');
    expect(g1c.effects[0].params).toEqual({ size: 3 });
    // The source document is untouched.
    expect(doc.layers.g1.effects[0].id).toBe('e1');
  });
});

describe('panel rows & filtering', () => {
  it('without a filter equals the display list (collapsed groups hide children)', () => {
    const doc = makeDoc();
    const f = { kinds: [], query: '' };
    expect(isFilterActive(f)).toBe(false);
    expect(panelRows(doc, f).map((r) => `${r.id}@${r.depth}`)).toEqual(['b@0', 'G@0', 'H@1', 'h1@2', 'g2@1', 'g1@1', 'a@0', 'bg@0']);
    const collapsed = produce(doc, (d) => void ((d.layers.H as GroupLayer).collapsed = true));
    expect(panelRows(collapsed, f).map((r) => r.id)).toEqual(['b', 'G', 'H', 'g2', 'g1', 'a', 'bg']);
  });

  it('with a filter lists matches plus dimmed ancestor groups, ignoring collapse', () => {
    const doc = produce(makeDoc(), (d) => void ((d.layers.H as GroupLayer).collapsed = true));
    const rows = panelRows(doc, { kinds: ['pixel'], query: '' });
    expect(rows.map((r) => `${r.id}${r.dim ? '*' : ''}`)).toEqual(['G*', 'H*', 'h1', 'g1', 'a']);
    const byName = panelRows(doc, { kinds: [], query: 'G2' });
    expect(byName.map((r) => r.id)).toEqual(['G', 'g2']);
    const groups = panelRows(doc, { kinds: ['group'], query: '' });
    expect(groups.map((r) => `${r.id}${r.dim ? '*' : ''}`)).toEqual(['G', 'H']);
  });

  it('kind matching', () => {
    const doc = makeDoc();
    expect(layerMatchesKind(doc.layers.bg, 'adjustment')).toBe(true);
    expect(layerMatchesKind(doc.layers.a, 'pixel')).toBe(true);
    expect(layerMatchesKind(doc.layers.b, 'text')).toBe(true);
    expect(layerMatchesKind(doc.layers.a, 'smart')).toBe(false);
  });
});

describe('solo visibility', () => {
  it('hides siblings along the path and shows the layer and its ancestors', () => {
    const doc = produce(makeDoc(), (d) => void (d.layers.H.visible = false));
    const change = soloVisibility(doc, 'h1');
    expect(change).toEqual({ H: true, g1: false, g2: false, bg: false, a: false, b: false });
  });
});
