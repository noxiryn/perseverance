/**
 * Adjustment-layer operations against the real editor store: insertion point and clipping-group
 * membership of new adjustment layers, and edits that change nothing not creating history.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Document, ID, Layer } from '../../core/types';
import { createDocument, makeAdjustmentLayer, makeGroupLayer, makeRasterLayer } from '../../core/document';
import { filters } from '../../registry';
import { useEditor } from '../../state/editor';
import { TONAL_DEFS } from './defs/tonal';
import { COLOR_DEFS } from './defs/color';
import { MAPPING_DEFS } from './defs/mapping';
import {
  adjustmentInsertion,
  commitAdjustmentParams,
  createAdjustmentLayer,
  previewAdjustmentParams,
  resetAdjustment,
  resolveClipped,
  setAdjustmentParams,
} from './layers';
import { useAdjustmentsPrefs } from './prefs';

beforeAll(() => {
  for (const d of [...TONAL_DEFS, ...COLOR_DEFS, ...MAPPING_DEFS]) if (!filters.get(d.id)) filters.register(d);
});

const raster = (name: string) => makeRasterLayer({ name, bitmapId: `bmp_${name}`, width: 8, height: 8 });

/** Backdrop, Red Glow (base) and Levels 1 clipped to Red Glow — the reviewer's scenario. */
function clipStackDoc() {
  const doc: Document = createDocument({ width: 8, height: 8 });
  const backdrop = raster('Backdrop');
  const glow = raster('Red Glow');
  const levels = makeAdjustmentLayer({ name: 'Levels 1', filterId: 'levels' });
  levels.clipped = true;
  for (const l of [backdrop, glow, levels]) {
    doc.layers[l.id] = l;
    doc.rootIds.push(l.id);
  }
  return { doc, backdrop, glow, levels };
}

function open(doc: Document, activeLayerId: ID) {
  for (const id of Object.keys(useEditor.getState().sessions)) useEditor.getState().closeDocument(id);
  useEditor.getState().openDocument(doc, { activeLayerId });
}

const session = () => {
  const st = useEditor.getState();
  return st.sessions[st.activeDocId!];
};
const docNow = () => session().doc;

/** The layer a clipped layer is clipped to: the nearest non-clipped sibling below it. */
function clipBase(doc: Document, id: ID): Layer | null {
  const i = doc.rootIds.indexOf(id);
  for (let k = i - 1; k >= 0; k--) {
    const l = doc.layers[doc.rootIds[k]];
    if (!l.clipped) return l;
  }
  return null;
}

beforeEach(() => useAdjustmentsPrefs.setState({ clipByDefault: false }));

describe('insertion point (pure)', () => {
  it('goes above the active layer and detects clipping groups on both sides', () => {
    const { doc, backdrop, glow, levels } = clipStackDoc();
    expect(adjustmentInsertion(doc, glow.id)).toEqual({ at: { aboveId: glow.id }, inClipGroup: true }); // base with clipped layer above
    expect(adjustmentInsertion(doc, levels.id)).toEqual({ at: { aboveId: levels.id }, inClipGroup: true }); // clipped layer
    expect(adjustmentInsertion(doc, backdrop.id)).toEqual({ at: { aboveId: backdrop.id }, inClipGroup: false });
    expect(adjustmentInsertion(doc, null)).toEqual({ at: { parentId: null, index: 3 }, inClipGroup: false });
  });

  it('goes to the top of an expanded active group, above a collapsed one', () => {
    const doc = createDocument({ width: 8, height: 8 });
    const child = raster('Child');
    const g = makeGroupLayer({ name: 'Group', childIds: [child.id] });
    doc.layers[child.id] = child;
    doc.layers[g.id] = g;
    doc.rootIds.push(g.id);
    expect(adjustmentInsertion(doc, g.id)).toEqual({ at: { parentId: g.id, index: 1 }, inClipGroup: false });
    g.collapsed = true;
    expect(adjustmentInsertion(doc, g.id)).toEqual({ at: { aboveId: g.id }, inClipGroup: false });
  });

  it('resolves the clipping state (group membership, preference, Alt inversion, explicit)', () => {
    expect(resolveClipped({}, false, false)).toBe(false);
    expect(resolveClipped({}, true, false)).toBe(true);
    expect(resolveClipped({}, false, true)).toBe(true);
    expect(resolveClipped({ invertClip: true }, false, false)).toBe(true);
    expect(resolveClipped({ invertClip: true }, true, false)).toBe(false);
    expect(resolveClipped({ ignoreClipPref: true }, false, true)).toBe(false);
    expect(resolveClipped({ ignoreClipPref: true }, true, true)).toBe(true);
    expect(resolveClipped({ clipped: false, invertClip: true }, true, true)).toBe(false);
  });
});

describe('createAdjustmentLayer', () => {
  it('keeps a base + clipped stack intact when inserting in the middle', () => {
    const { doc, backdrop, glow, levels } = clipStackDoc();
    open(doc, glow.id);
    const id = createAdjustmentLayer('color-balance')!;
    const d = docNow();
    expect(d.rootIds).toEqual([backdrop.id, glow.id, id, levels.id]);
    expect(d.layers[id].clipped).toBe(true);
    // Levels 1 still affects Red Glow (not the new Color Balance layer).
    expect(clipBase(d, levels.id)?.id).toBe(glow.id);
    expect(clipBase(d, id)?.id).toBe(glow.id);
    expect(session().activeLayerId).toBe(id);
    expect(session().history.entries.at(-1)?.label).toBe('New Color Balance Layer');
  });

  it('joins the clipping group when created above a clipped layer', () => {
    const { doc, glow, levels } = clipStackDoc();
    open(doc, levels.id);
    const id = createAdjustmentLayer('curves')!;
    const d = docNow();
    expect(d.rootIds.at(-1)).toBe(id);
    expect(d.layers[id].clipped).toBe(true);
    expect(clipBase(d, id)?.id).toBe(glow.id);
  });

  it('is unclipped over a normal layer; Alt-click (invertClip) clips it', () => {
    const { doc, backdrop } = clipStackDoc();
    open(doc, backdrop.id);
    const a = createAdjustmentLayer('levels')!;
    expect(docNow().layers[a].clipped).toBe(false);
    useEditor.getState().setActiveLayer(backdrop.id);
    const b = createAdjustmentLayer('levels', { invertClip: true })!;
    expect(docNow().layers[b].clipped).toBe(true);
    expect(clipBase(docNow(), b)?.id).toBe(backdrop.id);
  });

  it('follows "Clip to Layer by Default" unless told to ignore it', () => {
    const { doc, backdrop } = clipStackDoc();
    open(doc, backdrop.id);
    useAdjustmentsPrefs.setState({ clipByDefault: true });
    const a = createAdjustmentLayer('levels')!;
    expect(docNow().layers[a].clipped).toBe(true);
    useEditor.getState().setActiveLayer(backdrop.id);
    const b = createAdjustmentLayer('levels', { ignoreClipPref: true })!;
    expect(docNow().layers[b].clipped).toBe(false);
  });

  it('inserts at the top of an expanded active group', () => {
    const doc = createDocument({ width: 8, height: 8 });
    const child = raster('Child');
    const g = makeGroupLayer({ name: 'Group', childIds: [child.id] });
    doc.layers[child.id] = child;
    doc.layers[g.id] = g;
    doc.rootIds.push(g.id);
    open(doc, g.id);
    const id = createAdjustmentLayer('invert')!;
    const grp = docNow().layers[g.id];
    expect(grp.type === 'group' && grp.childIds).toEqual([child.id, id]);
    expect(docNow().rootIds).toEqual([g.id]);
  });

  it('rejects unknown and non-adjustment filters without touching history', () => {
    const { doc, glow } = clipStackDoc();
    open(doc, glow.id);
    const before = session().history.entries.length;
    expect(createAdjustmentLayer('no-such-filter')).toBeNull();
    expect(session().history.entries.length).toBe(before);
  });
});

describe('edits that change nothing record no history', () => {
  function setup() {
    const { doc, glow } = clipStackDoc();
    open(doc, glow.id);
    const id = createAdjustmentLayer('color-balance')!;
    return { id, entries: () => session().history.entries.length };
  }

  it('committing identical params twice adds no entry and keeps the document clean', () => {
    const { id, entries } = setup();
    const n = entries();
    const params = { ...(docNow().layers[id] as Extract<Layer, { type: 'adjustment' }>).adjustment.params };
    commitAdjustmentParams(id, params);
    commitAdjustmentParams(id, { ...params });
    expect(entries()).toBe(n);
  });

  it('a preview followed by a commit of the original values reverts the preview', () => {
    const { id, entries } = setup();
    const n = entries();
    const layer = docNow().layers[id] as Extract<Layer, { type: 'adjustment' }>;
    const original = { ...layer.adjustment.params };
    previewAdjustmentParams(id, { ...original, midR: 40 });
    expect((docNow().layers[id] as typeof layer).adjustment.params.midR).toBe(40);
    commitAdjustmentParams(id, original);
    expect(entries()).toBe(n);
    expect(docNow()).toBe(session().history.entries[session().history.index].doc);
  });

  it('Reset on an untouched layer adds nothing; a real change still commits (coalesced)', () => {
    const { id, entries } = setup();
    const n = entries();
    resetAdjustment(id);
    expect(entries()).toBe(n);
    commitAdjustmentParams(id, { midR: 20 });
    commitAdjustmentParams(id, { midR: 30 });
    expect(entries()).toBe(n + 1);
    expect(session().history.entries.at(-1)?.label).toBe('Edit Color Balance');
    setAdjustmentParams(id, { midR: 30 }, 'Same');
    expect(entries()).toBe(n + 1);
    resetAdjustment(id);
    expect(entries()).toBe(n + 2);
  });

  it("switching Selective Color's viewed range is not an edit", () => {
    const { doc, glow } = clipStackDoc();
    open(doc, glow.id);
    const id = createAdjustmentLayer('selective-color')!;
    const n = session().history.entries.length;
    const params = (docNow().layers[id] as Extract<Layer, { type: 'adjustment' }>).adjustment.params;
    commitAdjustmentParams(id, { ...params, range: 'blues' });
    expect(session().history.entries.length).toBe(n);
    expect(session().dirty).toBe(true); // the new layer itself
    commitAdjustmentParams(id, { ...params, range: 'blues', bluesC: 25 });
    expect(session().history.entries.length).toBe(n + 1);
  });
});
