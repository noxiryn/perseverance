/**
 * gate-first-user-3: placing a Libraries ▸ Backgrounds asset (or any Normal asset that covers the
 * canvas) used to insert it above the active layer — right after Pose Studio / a template that is the
 * character, which the opaque backdrop then hid. Backdrops now go behind the artwork, just above the
 * background layers at the bottom (an opaque base, a template's background group, earlier backdrops).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Document, ID, Layer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeFillLayer, makeGroupLayer, makeRasterLayer } from '../core/document';
import { createCanvas } from '../core/canvas';
import { assets } from '../registry';
import type { AssetDef } from '../registry';
import { useEditor } from '../state/editor';
import { installSoftCanvas } from '../render/softCanvas';
import { behindSlot, placeAsset } from './place';

let uninstall: () => void = () => {};
const W = 64;
const H = 48;

/** A canvas filled with `color` over the rect (x, y, w, h) — the rest transparent. */
function painted(color: string, w = W, h = H, rect: [number, number, number, number] = [0, 0, w, h]) {
  const c = createCanvas(w, h);
  const k = c.getContext('2d')!;
  k.fillStyle = color;
  k.fillRect(...rect);
  return c;
}

function testAsset(id: string, category: string, draw: (w: number, h: number) => HTMLCanvasElement, defaultBlendMode?: AssetDef['defaultBlendMode']): AssetDef {
  return { id, name: id, category, sizing: 'document', params: [], defaultBlendMode, generate: (_p, s) => draw(s.width, s.height) } as AssetDef;
}

const IDS = ['t-gradient', 't-city', 't-studs', 't-paper', 't-smoke'];
beforeAll(() => {
  uninstall = installSoftCanvas();
  assets.register(testAsset('t-gradient', 'Backgrounds', (w, h) => painted('#5020a0', w, h)));
  // Lower half only (like City Silhouette): still a backdrop by category.
  assets.register(testAsset('t-city', 'Backgrounds', (w, h) => painted('#101018', w, h, [0, h / 2, w, h / 2])));
  // Opaque and canvas-covering, other category (Roblox Studs / Baseplate Grid / Concrete).
  assets.register(testAsset('t-studs', 'Roblox', (w, h) => painted('#3a8f3a', w, h)));
  // A Multiply texture and a partial Normal overlay stay above the active layer.
  assets.register(testAsset('t-paper', 'Paper & Grunge', (w, h) => painted('#e8e0d0', w, h), 'multiply'));
  assets.register(testAsset('t-smoke', 'Smoke & Atmosphere', (w, h) => painted('#c4141c', w, h, [0, 0, w / 3, h])));
});
afterAll(() => {
  for (const id of IDS) assets.unregister(id);
  uninstall();
});

beforeEach(() => {
  useEditor.setState({ sessions: {}, docOrder: [], activeDocId: null });
});

function raster(name: string, canvas: HTMLCanvasElement): Layer {
  return makeRasterLayer({ name, bitmapId: bitmaps.add(canvas), width: canvas.width, height: canvas.height });
}

/** Open a document with these root layers (bottom → top); the last one is active (the character). */
function open(layers: Layer[]): Document {
  const d = createDocument({ name: 'T', width: W, height: H, background: null });
  for (const l of layers) insertLayerDraft(d, l, { parentId: null });
  useEditor.getState().openDocument(d);
  useEditor.getState().setActiveLayer(layers[layers.length - 1].id);
  return d;
}

const names = () => {
  const st = useEditor.getState();
  const doc = st.sessions[st.activeDocId!].doc;
  return doc.rootIds.map((id) => doc.layers[id].name);
};
const character = () => raster('Roblox Character 1', painted('#d0a070', W, H, [20, 6, 24, 40]));

describe('backdrop assets go behind the artwork', () => {
  it('New Roblox Thumbnail + Pose Studio: Gradient Backdrop lands between Background and the character', () => {
    open([raster('Background', painted('#ffffff')), character()]);
    placeAsset('t-gradient');
    expect(names()).toEqual(['Background', 't-gradient', 'Roblox Character 1']);
    // The new layer is selected, as before.
    const st = useEditor.getState();
    const s = st.sessions[st.activeDocId!];
    expect(s.doc.layers[s.activeLayerId!].name).toBe('t-gradient');
  });

  it('a second backdrop stacks above the first; partial Backgrounds assets count by category', () => {
    open([raster('Background', painted('#ffffff')), character()]);
    placeAsset('t-gradient');
    useEditor.getState().setActiveLayer(useEditor.getState().sessions[useEditor.getState().activeDocId!].doc.rootIds[2]);
    placeAsset('t-city');
    expect(names()).toEqual(['Background', 't-gradient', 't-city', 'Roblox Character 1']);
  });

  it('opaque canvas-covering assets of other categories go behind too', () => {
    open([raster('Background', painted('#ffffff')), character()]);
    placeAsset('t-studs');
    expect(names()).toEqual(['Background', 't-studs', 'Roblox Character 1']);
  });

  it('a template background group counts as the background (placed above it, not under it)', () => {
    const paper = makeGroupLayer({ name: 'Paper' });
    const fill = makeFillLayer({ name: 'Paper Color', fill: { type: 'solid', color: '#e9e8e4' } });
    const tex = raster('Paper Texture', painted('#ddd'));
    tex.blendMode = 'multiply';
    const d = createDocument({ name: 'T', width: W, height: H, background: null });
    insertLayerDraft(d, paper, { parentId: null });
    insertLayerDraft(d, fill, { parentId: paper.id });
    insertLayerDraft(d, tex, { parentId: paper.id });
    const ch = character();
    insertLayerDraft(d, ch, { parentId: null });
    useEditor.getState().openDocument(d);
    useEditor.getState().setActiveLayer(ch.id);
    expect(behindSlot(useEditor.getState().sessions[d.id].doc)).toEqual({ aboveId: paper.id });
    placeAsset('t-gradient');
    expect(names()).toEqual(['Paper', 't-gradient', 'Roblox Character 1']);
  });

  it('no background at the bottom (a cut-out character alone): the very bottom', () => {
    open([character()]);
    placeAsset('t-gradient');
    expect(names()).toEqual(['t-gradient', 'Roblox Character 1']);
  });

  it('textures and partial overlays still go above the active layer', () => {
    open([raster('Background', painted('#ffffff')), character()]);
    placeAsset('t-smoke');
    expect(names()).toEqual(['Background', 'Roblox Character 1', 't-smoke']);
    const st = useEditor.getState();
    st.setActiveLayer(st.sessions[st.activeDocId!].doc.rootIds[1] as ID);
    placeAsset('t-paper', undefined, { blendMode: 'multiply' });
    expect(names()).toEqual(['Background', 'Roblox Character 1', 't-paper', 't-smoke']);
  });
});
