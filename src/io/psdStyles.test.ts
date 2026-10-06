/**
 * "Bake layer styles" PSD export of effects with their own blend mode (release review e2e-flows-2):
 * a Screen glow / shadow baked into one pixel layer over transparency turns into a plain coloured
 * halo (Screen over nothing is Normal), so the PSD showed a red ring the document doesn't have. Such
 * pieces now go on pixel layers of their own below the layer, each with its blend mode, drawn
 * exactly like the compositor draws them. Round trip: buildPsd → psdToDocument → render both with
 * the real compositor on the test-only software canvas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Document, Layer, LayerEffect, ParamValues } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeRasterLayer } from '../core/document';
import { installSoftCanvas, pixelAt } from '../render/softCanvas';
import { invalidateRenderCache, renderDocument } from '../render/compositor';
import { setCropExactBackend } from '../render/backendProbe';
import { registerEffects } from '../render/effects';
import { buildPsd, psdExportNotes, psdToDocument, type PsdBuildReport } from './psd';

type RGBA = [number, number, number, number];
const S = 24;
let uninstall: () => void = () => {};

beforeAll(() => {
  uninstall = installSoftCanvas();
  setCropExactBackend(true);
  registerEffects();
});

afterAll(() => {
  invalidateRenderCache();
  uninstall();
});

function canvasOf(draw: (x: number, y: number) => RGBA, w = S, h = S): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const k = c.getContext('2d')!;
  const img = k.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(draw(x, y), (y * w + x) * 4);
  k.putImageData(img, 0, 0);
  return c;
}

function raster(d: Document, c: HTMLCanvasElement, props: Partial<Layer> = {}) {
  const l = makeRasterLayer({ name: props.name ?? 'Layer', bitmapId: bitmaps.add(c), width: c.width, height: c.height });
  Object.assign(l, props);
  insertLayerDraft(d, l, {});
  return l;
}

const fx = (effectId: string, params: ParamValues): LayerEffect => ({ id: `fx-${effectId}`, effectId, enabled: true, params });
/** A light paper backdrop (a Screen glow over it is barely visible in the document). */
const paper = () => canvasOf(() => [236, 232, 223, 255]);
/** A soft round character (alpha ramps to 0 over its outer 5 px). */
const softBlob = () =>
  canvasOf((x, y) => {
    const r = Math.hypot(x - 11.5, y - 11.5);
    return [40 + 4 * x, 30 + 3 * y, 50, Math.max(0, Math.min(255, Math.round(((8 - r) / 5) * 255)))];
  });
/** Hard shadows / strokes (the software canvas has no CSS blur) with their own blend modes. */
const screenShadow = () => fx('drop-shadow', { color: '#ff1f1f', blendMode: 'screen', opacity: 0.6, angle: 90, distance: 3, spread: 0, size: 0 });
const multiplyStroke = () => fx('stroke', { size: 2, position: 'outside', blendMode: 'multiply', opacity: 1, fillType: 'color', color: '#3060ff' });
const normalShadow = () => fx('drop-shadow', { color: '#200040', blendMode: 'normal', opacity: 0.8, angle: 90, distance: 3, spread: 0, size: 0 });

function roundTrip(d: Document, bakeStyles: boolean) {
  invalidateRenderCache();
  const built = buildPsd(d, { bakeStyles });
  const back = psdToDocument(built.psd, 'back').doc;
  invalidateRenderCache();
  const a = renderDocument(d, { background: false });
  const b = renderDocument(back, { background: false });
  const px: { a: RGBA; b: RGBA }[] = [];
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) px.push({ a: pixelAt(a, x, y), b: pixelAt(b, x, y) });
  return { built, back, px, layers: back.rootIds.map((id) => back.layers[id]) };
}

/** Largest straight-alpha / premultiplied-colour difference over the pixels. */
function maxDiff(px: { a: RGBA; b: RGBA }[]): number {
  let max = 0;
  for (const { a, b } of px) {
    max = Math.max(max, Math.abs(a[3] - b[3]));
    for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs((a[k] * a[3]) / 255 - (b[k] * b[3]) / 255));
  }
  return max;
}

describe('PSD export with "Bake layer styles": effects with their own blend mode', () => {
  it('a Screen shadow and a Multiply stroke over a light backdrop go on layers of their own, with their blend modes', () => {
    const d = createDocument({ name: 'glow', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    raster(d, softBlob(), { name: 'Char', effects: [screenShadow(), multiplyStroke()] });
    const { built, layers, px } = roundTrip(d, true);
    expect(built.styleLayers).toEqual(['Char']);
    expect(built.baked).toEqual([]);
    expect(layers.map((l) => l.name)).toEqual(['Paper', "Char's Drop Shadow", "Char's Stroke", 'Char']);
    expect(layers.map((l) => l.blendMode)).toEqual(['normal', 'screen', 'multiply', 'normal']);
    for (const l of layers) expect(l.effects).toEqual([]); // all baked
    expect(maxDiff(px)).toBeLessThanOrEqual(2);
  });

  it('the same document flattened into one pixel layer would show a halo (what the split fixes)', () => {
    // Guard on the test itself: the document's Screen shadow is barely visible over the paper,
    // the same pixels drawn plainly are not.
    const d = createDocument({ name: 'glow', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    raster(d, softBlob(), { name: 'Char', effects: [screenShadow()] });
    const flat = createDocument({ name: 'flat', width: S, height: S, background: null });
    raster(flat, paper(), { name: 'Paper' });
    raster(flat, softBlob(), { name: 'Char', effects: [{ ...screenShadow(), params: { ...screenShadow().params, blendMode: 'normal' } }] });
    invalidateRenderCache();
    const a = renderDocument(d, { background: false });
    const pa: RGBA[] = [];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) pa.push(pixelAt(a, x, y));
    invalidateRenderCache();
    const b = renderDocument(flat, { background: false });
    let max = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) max = Math.max(max, Math.abs(pa[y * S + x][1] - pixelAt(b, x, y)[1]));
    expect(max).toBeGreaterThan(40);
    // … and the export matches the document, not the flattened version.
    expect(maxDiff(roundTrip(d, true).px)).toBeLessThanOrEqual(2);
  });

  it('a layer blend mode or a reduced opacity with Normal effects: split too, exact', () => {
    for (const props of [{ blendMode: 'multiply' as const }, { opacity: 0.6 }]) {
      const d = createDocument({ name: 'blend', width: S, height: S, background: null });
      raster(d, paper(), { name: 'Paper' });
      raster(d, softBlob(), { name: 'Char', effects: [normalShadow()], ...props });
      const { built, layers, px } = roundTrip(d, true);
      expect(built.styleLayers).toEqual(['Char']);
      expect(layers.map((l) => l.name)).toEqual(['Paper', "Char's Drop Shadow", 'Char']);
      expect(layers[1].blendMode).toBe('normal');
      expect(layers[1].opacity).toBeCloseTo(props.opacity ?? 1, 2);
      expect(layers[2].blendMode).toBe(props.blendMode ?? 'normal');
      expect(maxDiff(px)).toBeLessThanOrEqual(2);
    }
  });

  it('a plain Normal layer with Normal effects stays one baked layer', () => {
    const d = createDocument({ name: 'plain', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    raster(d, softBlob(), { name: 'Char', effects: [normalShadow()] });
    const { built, layers, px } = roundTrip(d, true);
    expect(built.styleLayers).toEqual([]);
    expect(layers.map((l) => l.name)).toEqual(['Paper', 'Char']);
    expect(maxDiff(px)).toBeLessThanOrEqual(2);
  });

  it('a clipped layer is drawn flattened by the compositor: one baked layer reproduces it', () => {
    const d = createDocument({ name: 'clipped', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    raster(d, softBlob(), { name: 'Char', effects: [screenShadow()], clipped: true });
    const { built, layers, px } = roundTrip(d, true);
    expect(built.styleLayers).toEqual([]);
    expect(layers.map((l) => l.name)).toEqual(['Paper', 'Char']);
    expect(layers[1].clipped).toBe(true);
    expect(maxDiff(px)).toBeLessThanOrEqual(2);
  });

  it('a masked layer: baked effects follow the masked content (mask not applied twice)', () => {
    const d = createDocument({ name: 'masked', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    const mask = canvasOf((x) => (x < 12 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    // One baked layer: its pixels carry the mask, the PSD keeps it switched off. Split: the pieces
    // carry it, the content layer keeps the mask (editable, applied by Photoshop).
    for (const [effects, maskOn] of [
      [[normalShadow()], false],
      [[screenShadow(), multiplyStroke()], true],
    ] as const) {
      const doc = structuredClone(d);
      raster(doc, softBlob(), { name: 'Char', effects: [...effects], mask: { bitmapId: bitmaps.add(mask), enabled: true, inverted: false, density: 1, feather: 0, linked: true } as Layer['mask'] });
      const { layers, px } = roundTrip(doc, true);
      const char = layers[layers.length - 1];
      expect(char.mask?.enabled).toBe(maskOn);
      expect(maxDiff(px)).toBeLessThanOrEqual(2);
    }
  });

  it('editable styles are unaffected (blend modes travel as Photoshop effects)', () => {
    const d = createDocument({ name: 'editable', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    raster(d, softBlob(), { name: 'Char', effects: [screenShadow()] });
    const { built, layers } = roundTrip(d, false);
    expect(built.styleLayers).toEqual([]);
    expect(layers.map((l) => l.name)).toEqual(['Paper', 'Char']);
    expect(layers[1].effects.map((e) => [e.effectId, e.params.blendMode])).toEqual([['drop-shadow', 'screen']]);
  });
});

describe('export toast notes', () => {
  const empty: PsdBuildReport = { skipped: [], bakedAdjustments: [], approxAdjustments: [], rasterizedFills: [], baked: [], splitClipBases: [], editableClipBases: [], styleLayers: [], lostGroupStyles: [] };

  it('names each layer once, with a count for repeated names', () => {
    // Simulator Bright: six "Coin" layers had their styles split off.
    const styleLayers = ['Coin', 'Coin', 'Coin', 'Coin', 'Coin', 'Coin', 'Your Character (replace me)', 'Tag', 'Multiplier'];
    expect(psdExportNotes({ ...empty, styleLayers })).toEqual([
      'styles written as separate layers below their layer (like Photoshop’s Create Layers): Coin ×6, Your Character (replace me), Tag…',
    ]);
    expect(psdExportNotes({ ...empty, baked: ['A', 'B', 'A'] })).toEqual(['styles baked into pixels on A ×2, B']);
    expect(psdExportNotes(empty)).toEqual([]);
  });

  it('layers split for their own blend mode, opacity or as a clipping-mask base share one general note', () => {
    const d = createDocument({ name: 'notes', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    raster(d, softBlob(), { name: 'Multiply', effects: [normalShadow()], blendMode: 'multiply' });
    raster(d, softBlob(), { name: 'Faded', effects: [normalShadow()], opacity: 0.6 });
    raster(d, softBlob(), { name: 'Base', effects: [normalShadow()] });
    raster(d, paper(), { name: 'Texture', clipped: true });
    invalidateRenderCache();
    const built = buildPsd(d, { bakeStyles: true });
    expect(built.styleLayers).toEqual(['Multiply', 'Faded', 'Base']);
    expect(built.splitClipBases).toEqual(['Base']);
    const notes = psdExportNotes(built);
    expect(notes).toEqual(['styles written as separate layers below their layer (like Photoshop’s Create Layers): Multiply, Faded, Base']);
    expect(notes.join(' ')).not.toContain('blend mode');
  });
});
