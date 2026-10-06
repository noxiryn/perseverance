/**
 * Looks in Layer mode ("this layer only"): filters / effects go on the layer, grades and textures
 * are clipped to it, atmosphere is left out — the rest of the image must not change, whether the
 * layer is the character or a title.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import type { Document, Layer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeAdjustmentLayer, makeRasterLayer, makeTextLayer } from '../core/document';
import { effects, filters, type LookDef } from '../registry';
import { installSoftCanvas, pixelAt } from '../render/softCanvas';
import { invalidateRenderCache, renderDocument } from '../render/compositor';
import { setCropExactBackend } from '../render/backendProbe';
import {
  LOOK_META_KEY,
  buildLook,
  canRemoveLook,
  currentLookFor,
  describeConfinedSkips,
  insertLookDraft,
  isInsideLookGroup,
  lookClipLayers,
  lookGroups,
  lookMetaOf,
  lookScope,
  lookTargets,
  resolveTarget,
  stripConfinedLookDraft,
  stripLookDraft,
  type ExtLookDef,
  type OverlayFactory,
} from './engine';
import { parseLooksSettings } from './store';
import { captureLook } from './userLooks';

type RGBA = [number, number, number, number];
const W = 8;
const H = 8;
let uninstall: () => void = () => {};

const ident = (img: ImageData) => img;

beforeAll(() => {
  uninstall = installSoftCanvas();
  setCropExactBackend(true);
  filters.register({ id: 'c-cel', name: 'Cel', category: 'Stylize', params: [], apply: ident });
  filters.register({
    id: 'c-invert',
    name: 'Invert',
    category: 'Adjustments',
    adjustment: true,
    params: [],
    apply: (img) => {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i];
        d[i + 1] = 255 - d[i + 1];
        d[i + 2] = 255 - d[i + 2];
      }
      return img;
    },
  });
  effects.register({ id: 'c-shadow', name: 'Shadow', stage: 'behind', order: 1, params: [], render: () => {} });
});

afterAll(() => {
  invalidateRenderCache();
  filters.unregister('c-cel');
  filters.unregister('c-invert');
  effects.unregister('c-shadow');
  uninstall();
});

function solid(c: RGBA, w = W, h = H): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const k = cv.getContext('2d')!;
  const img = k.createImageData(w, h);
  for (let i = 0; i < w * h; i++) img.data.set(c, i * 4);
  k.putImageData(img, 0, 0);
  return cv;
}

/** Overlay factory: a solid blue texture over the whole document (real pixels for rendering). */
const blueTexture: OverlayFactory = (o, w, h) => makeRasterLayer({ name: o.name ?? o.assetId, bitmapId: bitmaps.add(solid([0, 0, 255, 255], w, h)), width: w, height: h });

const LOOK: ExtLookDef = {
  id: 'grade-look',
  name: 'Grade Look',
  category: 'Test',
  swatch: ['#000', '#fff'],
  layerFilters: [{ filterId: 'c-cel' }],
  layerEffects: [{ effectId: 'c-shadow' }],
  overlays: [
    { assetId: 'texture', name: 'Texture' },
    { assetId: 'smoke', name: 'Smoke', placement: 'behind' },
  ],
  adjustments: [{ filterId: 'c-invert', name: 'Invert' }],
};

/** Red background, a white "title" square (cols/rows 2..5) and a character layer above both. */
function makeDoc() {
  const doc = createDocument({ name: 'confine', width: W, height: H, background: null });
  const bg = makeRasterLayer({ name: 'Background', bitmapId: bitmaps.add(solid([255, 0, 0, 255])), width: W, height: H });
  const title = makeRasterLayer({ name: 'Title', bitmapId: bitmaps.add(solid([255, 255, 255, 255], 4, 4)), width: 4, height: 4 });
  title.transform = { ...title.transform, x: 2, y: 2 };
  const ch = makeRasterLayer({ name: 'Character', bitmapId: bitmaps.add(solid([0, 0, 0, 0], 1, 1)), width: 1, height: 1 });
  ch.meta = { placeholder: true };
  insertLayerDraft(doc, bg);
  insertLayerDraft(doc, title);
  insertLayerDraft(doc, ch);
  return { doc, bgId: bg.id, titleId: title.id, charId: ch.id };
}

function applyConfined(doc: Document, targetId: string, look: LookDef = LOOK): Document {
  const built = buildLook(look, doc, targetId, blueTexture, { confine: true, skipExisting: false });
  return produce(doc, (d) => {
    insertLookDraft(d, built, targetId);
  });
}

function px(d: Document, x: number, y: number): RGBA {
  invalidateRenderCache();
  return pixelAt(renderDocument(d, { background: false }), x, y);
}

describe('Layer mode: the look styles only the target layer', () => {
  it('builds filters/effects for the target, clips grades/textures, leaves atmosphere out', () => {
    const { doc, titleId } = makeDoc();
    const b = buildLook(LOOK, doc, titleId, blueTexture, { confine: true, skipExisting: false });
    expect(b.confined).toBe(true);
    expect(b.filters.map((f) => f.filterId)).toEqual(['c-cel']);
    expect(b.effects.map((e) => e.effectId)).toEqual(['c-shadow']);
    expect(b.groupLayers.map((l) => l.name)).toEqual(['Texture', 'Invert']);
    expect(b.behindLayers).toEqual([]);
    expect(b.atmosphereSkipped).toEqual(['Smoke']);
    expect(describeConfinedSkips(b)).toMatch(/Smoke was left out .*Document/);
  });

  it('inserts the grades / textures clipped directly above the target — no look group at the top', () => {
    const { doc, titleId, charId } = makeDoc();
    const out = applyConfined(doc, titleId);
    expect(lookGroups(out)).toHaveLength(0);
    const ti = out.rootIds.indexOf(titleId);
    const clip = out.rootIds.slice(ti + 1, ti + 3).map((id) => out.layers[id]);
    expect(clip.map((l) => l.name)).toEqual(['Texture', 'Invert']);
    for (const l of clip) {
      expect(l.clipped).toBe(true);
      expect(l.meta).toMatchObject({ lookId: 'grade-look', lookPart: 'clip', lookTargetId: titleId });
      expect(isInsideLookGroup(out, l.id)).toBe(true);
    }
    expect(out.rootIds[out.rootIds.length - 1]).toBe(charId); // the character stays on top, untouched
    expect(out.layers[charId]).toBe(doc.layers[charId]);
    const meta = lookMetaOf(out.layers[titleId])!;
    expect(meta).toMatchObject({ lookId: 'grade-look', confined: true });
    expect(out.layers[titleId].filters.map((f) => f.filterId)).toEqual(['c-cel']);
  });

  it('changes only the target’s pixels when rendered (the whole image changes in Document mode)', () => {
    const { doc, titleId } = makeDoc();
    const before = { bg: px(doc, 0, 0), title: px(doc, 3, 3) };
    expect(before).toEqual({ bg: [255, 0, 0, 255], title: [255, 255, 255, 255] });
    const out = applyConfined(doc, titleId);
    // Title: blue texture, then inverted → yellow. Background: untouched red.
    expect(px(out, 3, 3)).toEqual([255, 255, 0, 255]);
    expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(out, 7, 7)).toEqual([255, 0, 0, 255]);
    // Document mode (no target): the same grade covers everything.
    const whole = produce(doc, (d) => {
      insertLookDraft(d, buildLook(LOOK, doc, null, blueTexture, { skipExisting: false }), null);
    });
    expect(px(whole, 0, 0)).toEqual([255, 255, 0, 255]);
  });

  it('goes on top of the target’s own clip stack', () => {
    const { doc, titleId } = makeDoc();
    const shade = makeRasterLayer({ name: 'Shade', bitmapId: bitmaps.add(solid([0, 0, 0, 255])), width: W, height: H });
    shade.clipped = true;
    const withShade = produce(doc, (d) => {
      insertLayerDraft(d, shade, { aboveId: titleId });
    });
    const out = applyConfined(withShade, titleId);
    const ti = out.rootIds.indexOf(titleId);
    expect(out.rootIds.slice(ti, ti + 4).map((id) => out.layers[id].name)).toEqual(['Title', 'Shade', 'Texture', 'Invert']);
  });

  it('leaves grades / textures out for a target that is itself clipped (they would grade its base)', () => {
    const { doc, titleId } = makeDoc();
    const clippedDoc = produce(doc, (d) => {
      d.layers[titleId].clipped = true;
    });
    const b = buildLook(LOOK, clippedDoc, titleId, blueTexture, { confine: true, skipExisting: false });
    expect(b.groupLayers).toEqual([]);
    expect(b.filters).toHaveLength(1);
    expect(describeConfinedSkips(b)).toMatch(/grades and textures were left out: “Title” is clipped/);
  });

  it('works on a text layer too', () => {
    const doc = createDocument({ name: 't', width: W, height: H, background: null });
    const text = makeTextLayer({ name: 'Name' });
    insertLayerDraft(doc, text);
    const out = applyConfined(doc, text.id);
    expect(lookGroups(out)).toHaveLength(0);
    expect(lookClipLayers(out, text.id).map((l) => l.name)).toEqual(['Texture', 'Invert']);
    expect(out.rootIds[0]).toBe(text.id);
  });
});

describe('Layer-mode looks belong to their layer', () => {
  it('replacing the look of one layer leaves the other layer’s look alone', () => {
    const { doc, titleId, charId } = makeDoc();
    const a = applyConfined(doc, titleId);
    const b = applyConfined(a, charId, { ...LOOK, id: 'other', name: 'Other' });
    expect(lookClipLayers(b, titleId)).toHaveLength(2);
    expect(lookClipLayers(b, charId)).toHaveLength(2);
    // Again on the title: its old clip layers are replaced, not stacked.
    const c = applyConfined(b, titleId, { ...LOOK, id: 'third', name: 'Third' });
    expect(lookClipLayers(c, titleId).map((l) => l.meta?.lookId)).toEqual(['third', 'third']);
    expect(c.layers[titleId].filters.map((f) => f.filterId)).toEqual(['c-cel']);
    expect(lookClipLayers(c, charId).map((l) => l.meta?.lookId)).toEqual(['other', 'other']);
  });

  it('a document look keeps other layers’ confined looks; stripping one layer leaves the document look', () => {
    const { doc, titleId, charId } = makeDoc();
    const a = applyConfined(doc, titleId);
    const whole = produce(a, (d) => {
      insertLookDraft(d, buildLook({ ...LOOK, id: 'doc-look' }, a, charId, blueTexture, { documentWide: true, skipExisting: false }), charId);
    });
    expect(lookGroups(whole).length).toBeGreaterThan(0);
    expect(lookClipLayers(whole, titleId)).toHaveLength(2);
    expect(lookMetaOf(whole.layers[titleId])?.lookId).toBe('grade-look');
    const stripped = produce(whole, (d) => {
      stripConfinedLookDraft(d, titleId);
    });
    expect(lookClipLayers(stripped, titleId)).toHaveLength(0);
    expect(lookMetaOf(stripped.layers[titleId])).toBeNull();
    expect(stripped.layers[titleId].filters).toEqual([]);
    expect(lookGroups(stripped).length).toBe(lookGroups(whole).length);
    // Removing every look takes the confined looks too.
    const all = produce(whole, (d) => {
      stripLookDraft(d, null, 'all');
    });
    expect(lookClipLayers(all)).toHaveLength(0);
    expect(Object.values(all.layers).some((l: Layer) => !!l.meta?.[LOOK_META_KEY])).toBe(false);
    // Document-mode removal: the document look goes, the title's Layer-mode look stays.
    const docOnly = produce(whole, (d) => {
      stripLookDraft(d, null, 'document');
    });
    expect(lookGroups(docOnly)).toHaveLength(0);
    expect(lookMetaOf(docOnly.layers[charId])).toBeNull();
    expect(lookClipLayers(docOnly, titleId)).toHaveLength(2);
    expect(lookMetaOf(docOnly.layers[titleId])?.lookId).toBe('grade-look');
  });

  it('Document-mode Remove keeps Layer-mode looks in a document without a character too', () => {
    // File ▸ New (no character), a Layer look on the title, then a Document look.
    const { doc, titleId, charId } = makeDoc();
    const noChar = produce(doc, (d) => {
      d.layers[charId].meta = undefined;
      d.layers[charId].visible = false;
    });
    const a = applyConfined(noChar, titleId);
    const both = produce(a, (d) => {
      insertLookDraft(d, buildLook({ ...LOOK, id: 'doc-look', name: 'Doc Look' }, a, null, blueTexture, { skipExisting: false }), null);
    });
    expect(lookGroups(both).length).toBeGreaterThan(0);
    expect(lookClipLayers(both, titleId)).toHaveLength(2); // applying a Document look keeps it
    expect(canRemoveLook(both, null)).toBe(true);
    const removed = produce(both, (d) => {
      stripLookDraft(d, null, 'document');
    });
    expect(lookGroups(removed)).toHaveLength(0);
    expect(lookClipLayers(removed, titleId)).toHaveLength(2);
    expect(lookMetaOf(removed.layers[titleId])?.lookId).toBe('grade-look');
    // Nothing document-scope left: Document-mode Remove has nothing to do, Layer mode still does.
    expect(canRemoveLook(removed, null)).toBe(false);
    expect(canRemoveLook(removed, titleId)).toBe(true);
    expect(currentLookFor(removed, null)).toBeNull();
    expect(currentLookFor(removed, titleId)).toBe('grade-look');
  });

  it('a look clip layer targets the layer it styles (Remove / Apply act on that layer’s look only)', () => {
    const { doc, titleId, charId } = makeDoc();
    const both = applyConfined(applyConfined(doc, titleId), charId, { ...LOOK, id: 'char-look', name: 'Char Look' });
    const titleClip = lookClipLayers(both, titleId)[0];
    const r = lookScope(both, titleClip.id);
    expect(r).toMatchObject({ targetId: titleId, layerOnly: true });
    expect(r.blocked).toBeUndefined();
    expect(resolveTarget(both, titleClip.id).note).toMatch(/part of the look on “Title”/);
    expect(currentLookFor(both, titleClip.id)).toBe('grade-look');
    expect(canRemoveLook(both, titleClip.id)).toBe(true);
    // What removeLook / applyLook do for that request: only the title's look changes.
    const removed = produce(both, (d) => {
      stripConfinedLookDraft(d, r.targetId!);
    });
    expect(lookClipLayers(removed, titleId)).toHaveLength(0);
    expect(lookClipLayers(removed, charId)).toHaveLength(2);
    expect(lookMetaOf(removed.layers[charId])?.lookId).toBe('char-look');
    const t = lookTargets(both, titleClip.id);
    expect(t.targetId).toBe(titleId);
    expect(t.character).toBeFalsy();
  });

  it('Layer mode never widens to the whole document: adjustment layers and document-look layers are blocked', () => {
    const { doc, titleId } = makeDoc();
    const adj = makeAdjustmentLayer({ name: 'Vignette', filterId: 'c-invert' });
    const withAdj = produce(doc, (d) => {
      insertLayerDraft(d, adj);
    });
    for (const id of [adj.id]) {
      const r = lookScope(withAdj, id);
      expect(r.targetId).toBeNull();
      expect(r.layerOnly).toBe(true);
      expect(r.blocked).toMatch(/select a pixel, text or shape layer/);
      expect(canRemoveLook(withAdj, id)).toBe(false);
      expect(currentLookFor(withAdj, id)).toBeNull();
    }
    // A layer inside a document look group.
    const whole = produce(withAdj, (d) => {
      insertLookDraft(d, buildLook(LOOK, withAdj, null, blueTexture, { skipExisting: false }), null);
    });
    const member = lookGroups(whole)[0].childIds[0];
    expect(lookScope(whole, member).blocked).toMatch(/belongs to the document’s look/);
    expect(canRemoveLook(whole, member)).toBe(false);
    // ...while the title itself is still a fine target.
    expect(lookScope(whole, titleId)).toMatchObject({ targetId: titleId, layerOnly: true });
  });

  it('Save as Look takes the target’s own grades, not another layer’s Layer-mode look', () => {
    const { doc, titleId, charId } = makeDoc();
    const both = applyConfined(applyConfined(doc, charId, { ...LOOK, id: 'char-look' }), titleId);
    // Above the title: its own clip layers, the character and the character's clip layers.
    const { look } = captureLook(both, titleId, 'Mine', 'user-look:t');
    expect(look.adjustments!.map((a) => a.name)).toEqual(['Invert']);
  });

  it('the panel helpers follow the mode (Layer: this layer’s look; Document: the document’s)', () => {
    const { doc, titleId, bgId } = makeDoc();
    const a = applyConfined(doc, titleId);
    expect(currentLookFor(a, titleId)).toBe('grade-look');
    expect(currentLookFor(a, bgId)).toBeNull();
    expect(canRemoveLook(a, titleId)).toBe(true);
    expect(canRemoveLook(a, bgId)).toBe(false);
  });
});

describe('Looks settings', () => {
  it('defaults to Document and moves settings saved before Layer meant "this layer only" to Document', () => {
    expect(parseLooksSettings({}).target).toBe('doc');
    expect(parseLooksSettings(null).target).toBe('doc');
    expect(parseLooksSettings({ target: 'layer', previews: false, category: 'Noir' })).toEqual({ target: 'doc', previews: false, category: 'Noir' });
    expect(parseLooksSettings({ v: 2, target: 'layer' }).target).toBe('layer');
    expect(parseLooksSettings({ v: 2, target: 'doc' }).target).toBe('doc');
  });
});
