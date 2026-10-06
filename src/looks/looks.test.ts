import { beforeAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import type { Document, Layer, RasterLayer } from '../core/types';
import { createDocument, insertLayerDraft, makeAdjustmentLayer, makeFillLayer, makeFilterInstance, makeGroupLayer, makeRasterLayer, makeTextLayer } from '../core/document';
import { effects, filters, type LookDef } from '../registry';
import { bitmaps } from '../core/bitmaps';
import { contentSignature } from './preview';
import { edgeStripPolygons } from './masks';
import {
  LOOK_META_KEY,
  buildLook,
  characterInGroup,
  describeTargetSkips,
  lookTouchesTarget,
  currentLookId,
  hasLook,
  insertLookDraft,
  isInsideLookGroup,
  lookGroups,
  lookMetaOf,
  lookTargets,
  behindInsertionPoint,
  documentCharacter,
  resolveTarget,
  stripLookDraft,
  targetCaps,
  targetHidesBehind,
  type ExtLookDef,
  type OverlayFactory,
} from './engine';
import { BUILTIN_LOOKS } from './defs';

/* ---------- fixtures ---------- */

const ident = (img: ImageData) => img;

beforeAll(() => {
  filters.register({ id: 't-cel', name: 'Cel', category: 'Stylize', params: [{ key: 'levels', label: 'Levels', type: 'number', min: 2, max: 8, default: 4 }], apply: ident });
  filters.register({ id: 't-rim', name: 'Rim', category: 'Roblox', params: [], apply: ident });
  filters.register({ id: 't-curves', name: 'Curves', category: 'Adjustments', adjustment: true, params: [{ key: 'amount', label: 'Amount', type: 'number', min: 0, max: 1, default: 0.5 }], apply: ident });
  // Stand-ins for the real filters the built-in looks use (ids matter: restyling / scope rules).
  for (const [id, name, category] of [
    ['halftone', 'Halftone', 'Comic & Print'],
    ['gradient-map', 'Gradient Map', 'Color'],
    ['glitch', 'Glitch', 'Retro & Glitch'],
    ['chromatic-aberration', 'Chromatic Aberration', 'Retro & Glitch'],
    ['rim-light', 'Rim Light', 'Roblox'],
    ['vignette', 'Vignette', 'Adjustments'],
    ['brightness-contrast', 'Brightness/Contrast', 'Adjustments'],
    ['color-lookup', 'Color Lookup', 'Adjustments'],
  ] as const)
    filters.register({ id, name, category, params: [], apply: ident });
  effects.register({ id: 'outer-glow', name: 'Outer Glow', stage: 'behind', order: 2, params: [], render: () => {} });
  effects.register({ id: 't-shadow', name: 'Shadow', stage: 'behind', order: 1, params: [{ key: 'size', label: 'Size', type: 'number', min: 0, max: 100, default: 12 }], render: () => {} });
});

const fakeOverlay: OverlayFactory = (o, w, h) =>
  o.assetId === 'missing-asset' ? null : makeRasterLayer({ name: `asset ${o.assetId}`, bitmapId: `bm_${o.assetId}`, width: w, height: h });

const LOOK: LookDef = {
  id: 'test-look',
  name: 'Test Look',
  category: 'Test',
  swatch: ['#000', '#fff'],
  layerFilters: [{ filterId: 't-cel', params: { levels: 3 } }, { filterId: 't-rim' }, { filterId: 'not-registered' }],
  layerEffects: [{ effectId: 't-shadow', params: { size: 30 } }, { effectId: 'nope' }],
  overlays: [{ assetId: 'paper', blendMode: 'multiply', opacity: 0.5, name: 'Paper' }, { assetId: 'missing-asset' }],
  adjustments: [{ filterId: 't-curves', name: 'Contrast', opacity: 0.8, blendMode: 'overlay' }, { filterId: 'absent' }],
};

function makeDoc(): { doc: Document; charId: string; textId: string; adjId: string } {
  const doc = createDocument({ name: 'T', width: 100, height: 50 });
  const ch = makeRasterLayer({ name: 'Character', bitmapId: 'bm_char', width: 40, height: 40 });
  ch.filters.push(makeFilterInstance('user-filter'));
  const text = makeTextLayer({ name: 'Title' });
  const adj = makeAdjustmentLayer({ filterId: 't-levels' });
  insertLayerDraft(doc, ch);
  insertLayerDraft(doc, text);
  insertLayerDraft(doc, adj);
  return { doc, charId: ch.id, textId: text.id, adjId: adj.id };
}

/* ---------- tests ---------- */

describe('targetCaps', () => {
  it('knows which layer types hold filters/effects', () => {
    const { doc, charId, textId, adjId } = makeDoc();
    expect(targetCaps(doc.layers[charId])).toEqual({ filters: true, effects: true });
    expect(targetCaps(doc.layers[textId])).toEqual({ filters: true, effects: true });
    expect(targetCaps(doc.layers[adjId])).toEqual({ filters: false, effects: false });
    expect(targetCaps(makeGroupLayer({}))).toEqual({ filters: false, effects: true });
    expect(targetCaps(null)).toEqual({ filters: false, effects: false });
  });
});

describe('buildLook', () => {
  it('puts filters/effects on the target and textures/grades in the group', () => {
    const { doc, charId } = makeDoc();
    const b = buildLook(LOOK, doc, charId, fakeOverlay);
    expect(b.filters.map((f) => f.filterId)).toEqual(['t-cel', 't-rim']);
    expect(b.filters[0].params).toEqual({ levels: 3 });
    expect(b.effects.map((e) => e.effectId)).toEqual(['t-shadow']);
    expect(b.effects[0].params).toEqual({ size: 30 });
    // overlays first, then adjustments on top
    expect(b.groupLayers.map((l) => l.name)).toEqual(['Paper', 'Contrast']);
    const paper = b.groupLayers[0] as RasterLayer;
    expect(paper.blendMode).toBe('multiply');
    expect(paper.opacity).toBe(0.5);
    const adj = b.groupLayers[1] as Extract<Layer, { type: 'adjustment' }>;
    expect(adj.type).toBe('adjustment');
    expect(adj.adjustment.params).toEqual({ amount: 0.5 });
    expect(adj.opacity).toBe(0.8);
    expect(adj.blendMode).toBe('overlay');
    // missing ids are reported, not thrown
    expect(b.skipped.join(' ')).toMatch(/not-registered/);
    expect(b.skipped.join(' ')).toMatch(/nope/);
    expect(b.skipped.join(' ')).toMatch(/missing-asset/);
    expect(b.skipped.join(' ')).toMatch(/absent/);
  });

  it('whole-document mode converts filters to adjustment layers and skips character filters', () => {
    const { doc } = makeDoc();
    const b = buildLook(LOOK, doc, null, fakeOverlay);
    expect(b.filters).toEqual([]);
    expect(b.effects).toEqual([]);
    expect(b.groupLayers.map((l) => `${l.type}:${l.name}`)).toEqual(['adjustment:Cel', 'raster:Paper', 'adjustment:Contrast']);
    expect(b.skipped.join(' ')).toMatch(/t-rim/);
    expect(b.skipped.join(' ')).toMatch(/t-shadow/);
  });
});

describe('insert / strip', () => {
  it('applies in one recipe: group at the top + tracked target filters', () => {
    const { doc, charId } = makeDoc();
    const built = buildLook(LOOK, doc, charId, fakeOverlay);
    const next = produce(doc, (d) => {
      insertLookDraft(d, built, charId);
    });
    const groups = lookGroups(next);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Look: Test Look');
    expect(groups[0].meta).toEqual({ lookId: 'test-look', lookLayerIds: groups[0].childIds });
    expect(groups[0].blendMode).toBe('pass-through');
    expect(next.rootIds[next.rootIds.length - 1]).toBe(groups[0].id);
    expect(groups[0].childIds.map((id) => next.layers[id].name)).toEqual(['Paper', 'Contrast']);
    const ch = next.layers[charId];
    expect(ch.filters.map((f) => f.filterId)).toEqual(['user-filter', 't-cel', 't-rim']);
    expect(lookMetaOf(ch)).toEqual({ lookId: 'test-look', filterIds: built.filters.map((f) => f.id), effectIds: built.effects.map((e) => e.id) });
    expect(currentLookId(next, charId)).toBe('test-look');
    expect(currentLookId(next, null)).toBe('test-look');
    expect(hasLook(next, charId)).toBe(true);
    expect(isInsideLookGroup(next, groups[0].childIds[0])).toBe(true);
    expect(isInsideLookGroup(next, charId)).toBe(false);
    // original untouched
    expect(lookGroups(doc)).toHaveLength(0);
  });

  it('re-applying replaces the previous look instead of stacking', () => {
    const { doc, charId } = makeDoc();
    const first = produce(doc, (d) => {
      insertLookDraft(d, buildLook(LOOK, d, charId, fakeOverlay), charId);
    });
    const other: LookDef = { id: 'other', name: 'Other', category: 'Test', swatch: ['#111'], layerFilters: [{ filterId: 't-cel' }], adjustments: [{ filterId: 't-curves' }] };
    const second = produce(first, (d) => {
      insertLookDraft(d, buildLook(other, d, charId, fakeOverlay), charId);
    });
    expect(lookGroups(second)).toHaveLength(1);
    expect(lookGroups(second)[0].meta?.lookId).toBe('other');
    expect(second.layers[charId].filters.map((f) => f.filterId)).toEqual(['user-filter', 't-cel']);
    expect(second.layers[charId].effects).toEqual([]);
    expect(lookMetaOf(second.layers[charId])?.lookId).toBe('other');
    // the previous group's children are gone from the layer table
    for (const id of lookGroups(first)[0].childIds) expect(second.layers[id]).toBeUndefined();
  });

  it('strip removes the group and only the look-added filters/effects', () => {
    const { doc, charId, textId } = makeDoc();
    const applied = produce(doc, (d) => {
      insertLookDraft(d, buildLook(LOOK, d, charId, fakeOverlay), charId);
      // a second layer that also carries a look (e.g. applied earlier)
      insertLookDraft(d, { lookId: 'x', lookName: 'X', filters: [makeFilterInstance('t-cel')], effects: [], groupLayers: [], skipped: [] }, textId);
    });
    const stripped = produce(applied, (d) => {
      stripLookDraft(d, charId);
    });
    expect(lookGroups(stripped)).toHaveLength(0);
    expect(stripped.layers[charId].filters.map((f) => f.filterId)).toEqual(['user-filter']);
    expect(stripped.layers[charId].meta?.[LOOK_META_KEY]).toBeUndefined();
    // other layers keep their look unless stripping everything
    expect(lookMetaOf(stripped.layers[textId])?.lookId).toBe('x');
    const all = produce(applied, (d) => {
      stripLookDraft(d, null, 'all');
    });
    expect(lookMetaOf(all.layers[textId])).toBeNull();
    // Document-mode removal takes every document-scope (non-confined) look as well.
    const docScope = produce(applied, (d) => {
      stripLookDraft(d, null, 'document');
    });
    expect(lookMetaOf(docScope.layers[textId])).toBeNull();
    expect(lookMetaOf(docScope.layers[charId])).toBeNull();
    expect(lookGroups(docScope)).toHaveLength(0);
    expect(all.layers[textId].filters).toEqual([]);
    expect(hasLook(all, null)).toBe(false);
  });
});

describe('resolveTarget', () => {
  it('redirects unsupported targets and blocks locked layers', () => {
    const { doc, charId, adjId } = makeDoc();
    expect(resolveTarget(doc, charId)).toEqual({ targetId: charId });
    expect(resolveTarget(doc, null)).toEqual({ targetId: null });
    expect(resolveTarget(doc, 'gone').targetId).toBeNull();
    expect(resolveTarget(doc, 'gone').blocked).toBeTruthy();
    // An adjustment layer can't hold a look: blocked (never widened to the whole document).
    const adj = resolveTarget(doc, adjId);
    expect(adj.targetId).toBeNull();
    expect(adj.note).toBeTruthy();
    expect(adj.blocked).toMatch(/adjustment layer.*switch the Looks target to Document/);
    const locked = produce(doc, (d) => {
      d.layers[charId].locks.all = true;
    });
    expect(resolveTarget(locked, charId).blocked).toMatch(/locked/);
  });
});

describe('built-in looks', () => {
  it('ship 20+ looks including the reference styles', () => {
    expect(BUILTIN_LOOKS.length).toBeGreaterThanOrEqual(20);
    const ids = BUILTIN_LOOKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'gothic-paper',
      'sunburst-halftone',
      'noir-newspaper',
      'crimson-film',
      'toxic-green',
      'royal-purple',
      'ice-cold',
      'golden-hour',
      'vaporwave',
      'blood-moon',
      'teal-orange',
      'sepia-vintage',
      'ink-monochrome',
      'comic-pop',
      'cyber-neon',
      'inferno',
      'ghost-white',
      'midnight-blue',
      'retro-print',
      'anime-impact',
    ])
      expect(ids, id).toContain(id);
  });

  it('every look has a description, a swatch and at least one part', () => {
    for (const l of BUILTIN_LOOKS) {
      expect(l.description?.length ?? 0, l.id).toBeGreaterThan(10);
      expect(l.swatch.length, l.id).toBeGreaterThanOrEqual(2);
      for (const c of l.swatch) expect(c).toMatch(/^#[0-9a-f]{3,8}$/i);
      const parts = (l.layerFilters?.length ?? 0) + (l.layerEffects?.length ?? 0) + (l.adjustments?.length ?? 0) + (l.overlays?.length ?? 0);
      expect(parts, l.id).toBeGreaterThan(0);
    }
  });
});

/* ---------- review fixes ---------- */

function docWithCharacterGroup() {
  const { doc, charId, textId } = makeDoc();
  const g = makeGroupLayer({ name: 'Character' });
  insertLayerDraft(doc, g);
  // move the character raster into the group and tag it like the placeholder
  doc.rootIds = doc.rootIds.filter((id) => id !== charId);
  g.childIds.push(charId);
  doc.layers[charId].meta = { placeholder: true, kind: 'character' };
  const fx = makeRasterLayer({ name: 'FX', bitmapId: 'bm_fx', width: 10, height: 10 });
  insertLayerDraft(doc, fx, { parentId: g.id });
  return { doc, groupId: g.id, charId, textId, fxId: fx.id };
}

describe('group targets', () => {
  it('redirects a group target to the character inside it', () => {
    const { doc, groupId, charId } = docWithCharacterGroup();
    expect(characterInGroup(doc, groupId)).toBe(charId);
    const r = resolveTarget(doc, groupId);
    expect(r.targetId).toBe(charId);
    expect(r.note).toMatch(/inside group/);
  });

  it('keeps a group without an obvious character and reports the skipped filters', () => {
    const { doc, groupId, charId } = docWithCharacterGroup();
    const plain = produce(doc, (d) => {
      d.layers[charId].meta = undefined;
    });
    expect(characterInGroup(plain, groupId)).toBeNull(); // two rasters, none tagged
    expect(resolveTarget(plain, groupId).targetId).toBe(groupId);
    const b = buildLook(LOOK, plain, groupId, fakeOverlay);
    expect(b.filters).toEqual([]);
    expect(b.effects.map((e) => e.effectId)).toEqual(['t-shadow']);
    expect(b.targetSkipped).toEqual(['Cel', 'Rim']);
    expect(describeTargetSkips(b, plain.layers[groupId])).toMatch(/Cel and Rim skipped: groups can’t hold smart filters/);
  });

  it('explains what whole-document mode leaves out', () => {
    const { doc } = makeDoc();
    const b = buildLook(LOOK, doc, null, fakeOverlay);
    expect(b.targetSkipped).toEqual(['Rim', 'Shadow']);
    expect(describeTargetSkips(b, null)).toMatch(/Rim and Shadow need a character: add yours with Roblox/);
    const none = buildLook({ ...LOOK, layerFilters: [], layerEffects: [] }, doc, null, fakeOverlay);
    expect(describeTargetSkips(none, null)).toBe('');
  });

  it('knows whether a look touches the target', () => {
    const { doc, charId, adjId } = makeDoc();
    expect(lookTouchesTarget(LOOK, doc.layers[charId])).toBe(true);
    expect(lookTouchesTarget(LOOK, doc.layers[adjId])).toBe(false);
    expect(lookTouchesTarget({ ...LOOK, layerFilters: [], layerEffects: [] }, doc.layers[charId])).toBe(false);
    expect(lookTouchesTarget(LOOK, null)).toBe(false);
  });
});

describe('replacing and removing looks', () => {
  it('re-targeting a look removes the previous look from the other layer', () => {
    const { doc, charId, textId } = makeDoc();
    const first = produce(doc, (d) => {
      insertLookDraft(d, buildLook(LOOK, d, charId, fakeOverlay), charId);
    });
    const other: LookDef = { id: 'other', name: 'Other', category: 'Test', swatch: ['#111'], layerFilters: [{ filterId: 't-cel' }], adjustments: [{ filterId: 't-curves' }] };
    const second = produce(first, (d) => {
      insertLookDraft(d, buildLook(other, d, textId, fakeOverlay), textId);
    });
    expect(lookGroups(second).map((g) => g.meta?.lookId)).toEqual(['other']);
    expect(lookMetaOf(second.layers[charId])).toBeNull();
    expect(second.layers[charId].filters.map((f) => f.filterId)).toEqual(['user-filter']);
    expect(second.layers[charId].effects).toEqual([]);
    expect(lookMetaOf(second.layers[textId])?.lookId).toBe('other');
    expect(currentLookId(second, charId)).toBe('other'); // via the document's look group
  });

  it('records the look group children and keeps user layers dragged into it', () => {
    const { doc, charId } = makeDoc();
    const applied = produce(doc, (d) => {
      insertLookDraft(d, buildLook(LOOK, d, charId, fakeOverlay), charId);
    });
    const g = lookGroups(applied)[0];
    expect(g.meta?.lookLayerIds).toEqual(g.childIds);
    const userLayer = makeRasterLayer({ name: 'My Paint', bitmapId: 'bm_user', width: 5, height: 5 });
    const withUser = produce(applied, (d) => {
      insertLayerDraft(d, userLayer, { parentId: g.id, index: 1 });
    });
    const removed = produce(withUser, (d) => {
      stripLookDraft(d, charId);
    });
    expect(lookGroups(removed)).toHaveLength(0);
    expect(removed.layers[userLayer.id]).toBeTruthy();
    // it takes the group's place at the top of the root
    expect(removed.rootIds[removed.rootIds.length - 1]).toBe(userLayer.id);
    for (const id of g.childIds) expect(removed.layers[id]).toBeUndefined();
  });

  it('builds overlays with mask specs without a canvas (mask skipped)', () => {
    const { doc, charId } = makeDoc();
    const masked: LookDef = {
      ...LOOK,
      overlays: [{ assetId: 'paper', name: 'Paper', mask: { kind: 'edge-strips', width: 0.1 } } as NonNullable<LookDef['overlays']>[number]],
    };
    const b = buildLook(masked, doc, charId, fakeOverlay);
    expect(b.groupLayers.map((l) => l.name)).toContain('Paper');
  });
});

describe('edge strip masks', () => {
  it('cover narrow strips at the requested sides', () => {
    const both = edgeStripPolygons({ kind: 'edge-strips', width: 0.1 }, 1000, 500);
    expect(both).toHaveLength(2);
    const maxX = (p: [number, number][]) => Math.max(...p.map((q) => q[0]));
    const minX = (p: [number, number][]) => Math.min(...p.map((q) => q[0]));
    expect(maxX(both[0])).toBeLessThanOrEqual(100);
    expect(minX(both[1])).toBeGreaterThanOrEqual(900);
    expect(edgeStripPolygons({ kind: 'edge-strips', width: 0.1, sides: 'left' }, 1000, 500)).toHaveLength(1);
    // clamped to half the width
    expect(maxX(edgeStripPolygons({ kind: 'edge-strips', width: 3, sides: 'left' }, 1000, 500)[0])).toBeLessThanOrEqual(500);
  });
});

describe('preview content signature', () => {
  it('ignores selection/guides, follows layers and pixel versions', () => {
    const { doc, charId } = makeDoc();
    const sig = contentSignature(doc);
    const guides = produce(doc, (d) => {
      d.guides.push({ id: 'g1', orientation: 'vertical', position: 10 });
    });
    expect(contentSignature(guides)).toBe(sig);
    const moved = produce(doc, (d) => {
      d.layers[charId].opacity = 0.5;
    });
    expect(contentSignature(moved)).not.toBe(sig);
    bitmaps.add({ width: 1, height: 1 } as HTMLCanvasElement, 'bm_char');
    const withPixels = contentSignature(doc);
    bitmaps.touch('bm_char');
    expect(contentSignature(doc)).not.toBe(withPixels);
  });
});

/* ---------- placement, duplicates, whole-document character, ownership ---------- */

const ATMOS: ExtLookDef = {
  id: 'atmos',
  name: 'Atmos',
  category: 'Test',
  swatch: ['#000'],
  layerFilters: [{ filterId: 'halftone', scope: 'character' }],
  overlays: [
    { assetId: 'smoke', name: 'Smoke', placement: 'behind' },
    { assetId: 'scratches', name: 'Scratches' },
  ],
};

function docWithBackground() {
  const { doc, charId, textId } = makeDoc();
  const bg = makeRasterLayer({ name: 'Background', bitmapId: 'bm_bg', width: 100, height: 50 });
  insertLayerDraft(doc, bg, { parentId: null, index: 0 });
  return { doc, charId, textId, bgId: bg.id };
}

describe('look overlay placement', () => {
  it('puts behind-overlays in a second look group directly below the target', () => {
    const { doc, charId, bgId } = docWithBackground();
    const built = buildLook(ATMOS, doc, charId, fakeOverlay);
    expect(built.behindLayers?.map((l) => l.name)).toEqual(['Smoke']);
    expect(built.groupLayers.map((l) => l.name)).toEqual(['Scratches']);
    const out = produce(doc, (d) => {
      insertLookDraft(d, built, charId);
    });
    const groups = lookGroups(out);
    expect(groups).toHaveLength(2);
    const behind = groups.find((g) => g.meta?.lookPart === 'behind')!;
    // root order (bottom → top): Background, behind group, Character, …, top group
    expect(out.rootIds.indexOf(behind.id)).toBe(out.rootIds.indexOf(bgId) + 1);
    expect(out.rootIds.indexOf(behind.id)).toBe(out.rootIds.indexOf(charId) - 1);
    expect(out.rootIds[out.rootIds.length - 1]).not.toBe(behind.id);
    // stripping removes both groups
    const stripped = produce(out, (d) => {
      stripLookDraft(d, charId);
    });
    expect(lookGroups(stripped)).toHaveLength(0);
  });

  it('without a target every overlay stays in the top group', () => {
    const { doc } = docWithBackground();
    const built = buildLook(ATMOS, doc, null, fakeOverlay);
    expect(built.behindLayers).toEqual([]);
    expect(built.groupLayers.map((l) => l.name)).toContain('Smoke');
  });

  it('goes below the base of a clipping group', () => {
    const { doc, charId } = docWithBackground();
    const clipped = produce(doc, (d) => {
      const shade = makeRasterLayer({ name: 'Shade', bitmapId: 'bm_s', width: 10, height: 10 });
      shade.clipped = true;
      insertLayerDraft(d, shade, { aboveId: charId });
    });
    const shadeId = clipped.rootIds[clipped.rootIds.indexOf(charId) + 1];
    expect(behindInsertionPoint(clipped as Document, shadeId)).toEqual({ parentId: null, index: clipped.rootIds.indexOf(charId) });
  });

  it('keeps behind-overlays on top when the target still has its opaque background', () => {
    const { doc, charId } = docWithBackground();
    const built = buildLook(ATMOS, doc, charId, fakeOverlay, { hidesBehind: () => true });
    expect(built.behindLayers).toEqual([]);
    expect(built.groupLayers.map((l) => l.name)).toEqual(['Smoke', 'Scratches']);
    expect(built.behindOnTop).toEqual(['Smoke']);
    const out = produce(doc, (d) => {
      insertLookDraft(d, built, charId);
    });
    expect(lookGroups(out)).toHaveLength(1);
    expect(out.rootIds[out.rootIds.length - 1]).toBe(lookGroups(out)[0].id);
  });

  it('only fill layers and never-cut-out pixel layers hide what is behind them', () => {
    const fill = makeFillLayer({ fill: { type: 'solid', color: '#000000' } });
    expect(targetHidesBehind(fill)).toBe(true);
    // a pixel layer whose bitmap isn't loaded / is transparent around the subject
    expect(targetHidesBehind(makeRasterLayer({ name: 'cut', bitmapId: 'bm_missing', width: 10, height: 10 }))).toBe(false);
    // a Remove Background mask hides the background, so atmosphere behind it shows
    const masked = makeRasterLayer({ name: 'masked', bitmapId: 'bm_missing', width: 10, height: 10 });
    masked.mask = { bitmapId: 'bm_mask', enabled: true, density: 1, feather: 0, inverted: false };
    masked.meta = { cutoutMask: 'bm_mask' };
    expect(targetHidesBehind(masked)).toBe(false);
    expect(targetHidesBehind(makeTextLayer({ name: 'Title' }))).toBe(false);
  });

  it('skips overlays whose asset is already in the document', () => {
    const { doc, charId } = docWithBackground();
    const withScratches = produce(doc, (d) => {
      const l = makeRasterLayer({ name: 'My scratches', bitmapId: 'bm_x', width: 100, height: 50 });
      l.generator = { kind: 'asset:scratches', params: {} };
      insertLayerDraft(d, l);
    });
    const built = buildLook(ATMOS, withScratches, charId, fakeOverlay);
    expect(built.duplicates).toEqual(['Scratches']);
    expect(built.groupLayers).toEqual([]);
    expect(built.behindLayers?.map((l) => l.name)).toEqual(['Smoke']);
  });
});

describe('whole-document looks with a character', () => {
  it('target the document’s only character', () => {
    const { doc, charId } = docWithBackground();
    expect(documentCharacter(doc)).toBeNull();
    const tagged = produce(doc, (d) => {
      d.layers[charId].meta = { kind: 'character' };
    });
    expect(documentCharacter(tagged)).toBe(charId);
    const t = lookTargets(tagged, null);
    expect(t.targetId).toBe(charId);
    expect(t.character).toBe(true);
    // An explicit layer request is not redirected.
    expect(lookTargets(tagged, charId)).toEqual({ targetId: charId });
  });

  it('do not pick one of several characters', () => {
    const { doc, charId } = docWithBackground();
    const two = produce(doc, (d) => {
      d.layers[charId].meta = { placeholder: true };
      const other = makeRasterLayer({ name: 'Rival', bitmapId: 'bm_r', width: 10, height: 10 });
      other.meta = { placeholder: true };
      insertLayerDraft(d, other);
    });
    expect(documentCharacter(two)).toBeNull();
    expect(lookTargets(two, null).targetId).toBeNull();
  });
});

describe('look vs character styling ownership', () => {
  it('a look with filters replaces the template and styler treatment', () => {
    const { doc, charId } = docWithBackground();
    const styled = produce(doc, (d) => {
      const l = d.layers[charId];
      const t = makeFilterInstance('t-cel');
      const s = makeFilterInstance('t-rim');
      l.filters.push(t, s);
      l.meta = { placeholder: true, templateStyle: { filterIds: [t.id], effectIds: [] }, styler: { style: 'x', filters: { base: { id: s.id, filterId: 't-rim' } }, effects: {} } };
    });
    const out = produce(styled, (d) => {
      insertLookDraft(d, buildLook(ATMOS, d, charId, fakeOverlay), charId);
    });
    const l = out.layers[charId];
    expect(l.filters.map((f) => f.filterId)).toEqual(['user-filter', 'halftone']);
    expect(l.meta?.templateStyle).toBeUndefined();
    expect(l.meta?.styler).toBeUndefined();
    expect(lookMetaOf(l)?.lookId).toBe('atmos');
    // Remove Look brings the template and styler treatment back (same instances, same order).
    const removed = produce(out, (d) => {
      stripLookDraft(d, charId);
    });
    const r = removed.layers[charId];
    expect(r.filters).toEqual(styled.layers[charId].filters);
    expect(r.meta).toEqual(styled.layers[charId].meta);
    expect(lookMetaOf(r)).toBeNull();
  });

  it('a look that only adds effects keeps the styler filters and drops duplicate effect types', () => {
    const { doc, charId } = docWithBackground();
    const glowLook: LookDef = { id: 'glow', name: 'Glow', category: 'Test', swatch: ['#fff'], layerEffects: [{ effectId: 't-shadow' }] };
    const styled = produce(doc, (d) => {
      const l = d.layers[charId];
      const s = makeFilterInstance('t-rim');
      l.filters.push(s);
      l.effects.push({ id: 'se', effectId: 't-shadow', enabled: true, params: {} });
      l.meta = { styler: { style: 'x', filters: { base: { id: s.id, filterId: 't-rim' } }, effects: { glow: { id: 'se', effectId: 't-shadow' } } } };
    });
    const out = produce(styled, (d) => {
      insertLookDraft(d, buildLook(glowLook, d, charId, fakeOverlay), charId);
    });
    const l = out.layers[charId];
    expect(l.filters.map((f) => f.filterId)).toEqual(['user-filter', 't-rim']);
    expect(l.effects).toHaveLength(1);
    expect(l.effects[0].id).not.toBe('se');
  });
});

/* ---------- filter scope, additive looks, duplicate grades (final review round 2) ---------- */

/** Crimson-template-like document: background, styled placeholder, title, Vignette + Contrast. */
function crimsonTemplateDoc() {
  const { doc, charId, textId, bgId } = docWithBackground();
  const out = produce(doc, (d) => {
    const l = d.layers[charId];
    const gm = makeFilterInstance('gradient-map');
    const ht = makeFilterInstance('halftone');
    l.filters = [gm, ht];
    l.effects = [{ id: 'tglow', effectId: 'outer-glow', enabled: true, params: {} }];
    l.meta = { placeholder: true, kind: 'character', templateStyle: { filterIds: [gm.id, ht.id], effectIds: ['tglow'] } };
    insertLayerDraft(d, makeAdjustmentLayer({ name: 'Vignette', filterId: 'vignette' }));
    insertLayerDraft(d, makeAdjustmentLayer({ name: 'Contrast', filterId: 'brightness-contrast' }));
  });
  return { doc: out, charId, textId, bgId };
}

const builtin = (id: string) => BUILTIN_LOOKS.find((l) => l.id === id)!;

describe('look filter scope in whole-document mode', () => {
  it('Glitch Signal styles the whole document and keeps the template treatment', () => {
    const { doc, charId } = crimsonTemplateDoc();
    const t = lookTargets(doc, null);
    expect(t.targetId).toBe(charId);
    const built = buildLook(builtin('glitch-signal'), doc, t.targetId, fakeOverlay, { documentWide: !!t.character });
    expect(built.filters).toEqual([]);
    expect(built.restyles).toBe(false);
    const adjustments = built.groupLayers.filter((l) => l.type === 'adjustment').map((l) => (l as Extract<Layer, { type: 'adjustment' }>).adjustment.filterId);
    expect(adjustments).toEqual(expect.arrayContaining(['glitch', 'chromatic-aberration']));
    const out = produce(doc, (d) => {
      insertLookDraft(d, built, t.targetId);
    });
    const ch = out.layers[charId];
    expect(ch.filters).toEqual(doc.layers[charId].filters);
    expect(ch.effects).toEqual(doc.layers[charId].effects);
    expect(ch.meta?.templateStyle).toEqual(doc.layers[charId].meta?.templateStyle);
    expect(lookGroups(out)[0].childIds.some((id) => (out.layers[id] as { adjustment?: { filterId: string } }).adjustment?.filterId === 'glitch')).toBe(true);
  });

  it('a character-scope treatment (Crimson Film) still goes on the character', () => {
    const { doc, charId } = crimsonTemplateDoc();
    const built = buildLook(builtin('crimson-film'), doc, charId, fakeOverlay, { documentWide: true });
    expect(built.filters.map((f) => f.filterId)).toEqual(['gradient-map', 'halftone']);
    expect(built.restyles).toBe(true);
    expect(built.groupLayers.some((l) => l.type === 'adjustment' && l.adjustment.filterId === 'gradient-map')).toBe(false);
  });

  it('active-layer mode puts every look filter on the chosen layer', () => {
    const { doc, charId } = crimsonTemplateDoc();
    const built = buildLook(builtin('glitch-signal'), doc, charId, fakeOverlay);
    expect(built.filters.map((f) => f.filterId)).toEqual(['glitch', 'chromatic-aberration']);
    // additive filters keep the template's colors
    const out = produce(doc, (d) => {
      insertLookDraft(d, built, charId);
    });
    expect(out.layers[charId].filters.map((f) => f.filterId)).toEqual(['gradient-map', 'halftone', 'glitch', 'chromatic-aberration']);
  });
});

describe('additive looks and Remove Look', () => {
  it('a rim-light look replaces only the same effect type and Remove Look restores it', () => {
    const { doc, charId } = crimsonTemplateDoc();
    const built = buildLook(builtin('ice-cold'), doc, charId, fakeOverlay);
    expect(built.restyles).toBe(false);
    const out = produce(doc, (d) => {
      insertLookDraft(d, built, charId);
    });
    const ch = out.layers[charId];
    expect(ch.filters.map((f) => f.filterId)).toEqual(['gradient-map', 'halftone', 'rim-light']);
    expect(ch.effects.map((e) => e.id)).not.toContain('tglow'); // no double glow
    expect(ch.effects.filter((e) => e.effectId === 'outer-glow')).toHaveLength(1);
    expect(lookMetaOf(ch)?.replaced?.effects.map((e) => e.instance.id)).toEqual(['tglow']);
    const removed = produce(out, (d) => {
      stripLookDraft(d, charId);
    });
    expect(removed.layers[charId].filters).toEqual(doc.layers[charId].filters);
    expect(removed.layers[charId].effects).toEqual(doc.layers[charId].effects);
    expect(removed.layers[charId].meta).toEqual(doc.layers[charId].meta);
  });

  it('applying a second look restores what the first replaced before replacing again', () => {
    const { doc, charId } = crimsonTemplateDoc();
    const first = produce(doc, (d) => {
      insertLookDraft(d, buildLook(builtin('crimson-film'), d, charId, fakeOverlay), charId);
    });
    expect(first.layers[charId].meta?.templateStyle).toBeUndefined();
    const second = produce(first, (d) => {
      insertLookDraft(d, buildLook(builtin('glitch-signal'), d, charId, fakeOverlay), charId);
    });
    // the template treatment is back under the additive glitch look
    expect(second.layers[charId].meta?.templateStyle).toEqual(doc.layers[charId].meta?.templateStyle);
    expect(second.layers[charId].filters.map((f) => f.filterId)).toEqual(['gradient-map', 'halftone', 'glitch', 'chromatic-aberration']);
    const removed = produce(second, (d) => {
      stripLookDraft(d, charId);
    });
    expect(removed.layers[charId].filters).toEqual(doc.layers[charId].filters);
    expect(removed.layers[charId].effects).toEqual(doc.layers[charId].effects);
  });
});

describe('duplicate grades', () => {
  it('skips adjustments already in the document and treats vignette asset/adjustment as one', () => {
    const { doc, charId } = crimsonTemplateDoc();
    const built = buildLook(builtin('crimson-film'), doc, charId, fakeOverlay);
    expect(built.duplicates).toEqual(expect.arrayContaining(['Vignette', 'Contrast']));
    expect(built.groupLayers.map((l) => l.name)).not.toContain('Vignette');
    expect(built.groupLayers.some((l) => l.type === 'adjustment' && l.adjustment.filterId === 'brightness-contrast')).toBe(false);
    // a hidden duplicate doesn't count
    const hidden = produce(doc, (d) => {
      for (const l of Object.values(d.layers)) if (l.type === 'adjustment') l.visible = false;
    });
    const again = buildLook(builtin('crimson-film'), hidden, charId, fakeOverlay);
    expect(again.groupLayers.map((l) => l.name)).toEqual(expect.arrayContaining(['Vignette', 'Contrast']));
  });
});
