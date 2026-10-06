/**
 * Layer ▸ Rasterize Layer Style must not change the image (release review e2e-flows-2): effects
 * the compositor draws behind the content with their own blend mode (a Screen glow / shadow, a
 * Multiply stroke) used to be flattened onto transparency — Screen over nothing is Normal, so a red
 * Screen shadow over a light backdrop became a visible red halo. They now go on layers of their own
 * below the layer, each with its blend mode, exactly as rendered. One undo step brings the styles back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Document, Layer, LayerEffect, ParamValues } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeRasterLayer } from '../core/document';
import { installSoftCanvas, pixelAt } from '../render/softCanvas';
import { invalidateRenderCache, renderDocument } from '../render/compositor';
import { setCropExactBackend } from '../render/backendProbe';
import { registerEffects } from '../render/effects';
import { useEditor } from '../state/editor';
import { useUI } from '../state/ui';
import { rasterizeStyleSelected } from './layerOps';

type RGBA = [number, number, number, number];
const S = 24;
let uninstall: () => void = () => {};

beforeAll(() => {
  uninstall = installSoftCanvas();
  setCropExactBackend(true);
  registerEffects();
});

afterAll(() => {
  for (const id of Object.keys(useEditor.getState().sessions)) useEditor.getState().closeDocument(id);
  invalidateRenderCache();
  uninstall();
});

function canvasOf(draw: (x: number, y: number) => RGBA): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const k = c.getContext('2d')!;
  const img = k.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.data.set(draw(x, y), (y * S + x) * 4);
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
const paper = () => canvasOf(() => [236, 232, 223, 255]);
const softBlob = () =>
  canvasOf((x, y) => {
    const r = Math.hypot(x - 11.5, y - 11.5);
    return [40 + 4 * x, 30 + 3 * y, 50, Math.max(0, Math.min(255, Math.round(((8 - r) / 5) * 255)))];
  });
const screenShadow = () => fx('drop-shadow', { color: '#ff1f1f', blendMode: 'screen', opacity: 0.6, angle: 90, distance: 3, spread: 0, size: 0 });
const multiplyStroke = () => fx('stroke', { size: 2, position: 'outside', blendMode: 'multiply', opacity: 1, fillType: 'color', color: '#3060ff' });
const normalShadow = () => fx('drop-shadow', { color: '#200040', blendMode: 'normal', opacity: 0.8, angle: 90, distance: 3, spread: 0, size: 0 });
const overlay = () => fx('color-overlay', { color: '#30ff60', blendMode: 'normal', opacity: 0.5 });
const centerStroke = () => fx('stroke', { size: 2, position: 'center', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#ffffff' });
/** A hard-edged disc (no soft edge: effects over it can't add coverage along it). */
const disc = () => canvasOf((x, y) => (Math.hypot(x - 11.5, y - 11.5) <= 7 ? [34, 34, 34, 255] : [0, 0, 0, 0]));
/** A texture clipped to the layer below it, covering the whole canvas. */
const texture = () => canvasOf((x, y) => [224, 192 - 4 * y, 32 + 6 * x, 255]);
const lastToast = () => useUI.getState().toasts.at(-1);

const session = () => {
  const st = useEditor.getState();
  return st.sessions[st.activeDocId!];
};

function pixels(doc: Document): RGBA[] {
  invalidateRenderCache();
  const c = renderDocument(doc, { background: false });
  const out: RGBA[] = [];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out.push(pixelAt(c, x, y));
  return out;
}

function maxDiff(a: RGBA[], b: RGBA[]): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs(a[i][3] - b[i][3]));
    for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs((a[i][k] * a[i][3]) / 255 - (b[i][k] * b[i][3]) / 255));
  }
  return max;
}

/** Open `doc` with `layerId` selected, rasterize its style; returns the document before and after. */
function rasterize(doc: Document, layerId: string) {
  for (const id of Object.keys(useEditor.getState().sessions)) useEditor.getState().closeDocument(id);
  useEditor.getState().openDocument(doc, { activeLayerId: layerId });
  const before = session().doc;
  rasterizeStyleSelected();
  return { before, after: session().doc };
}

describe('Rasterize Layer Style keeps the image', () => {
  it('a Screen shadow and a Multiply stroke over a light backdrop: one layer each below, with its blend mode', () => {
    const d = createDocument({ name: 'glow', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    const char = raster(d, softBlob(), { name: 'Char', effects: [screenShadow(), multiplyStroke()] });
    const { before, after } = rasterize(d, char.id);
    expect(maxDiff(pixels(before), pixels(after))).toBeLessThanOrEqual(2);
    const layers = after.rootIds.map((id) => after.layers[id]);
    expect(layers.map((l) => l.name)).toEqual(['Paper', "Char's Drop Shadow", "Char's Stroke", 'Char']);
    expect(layers.map((l) => l.blendMode)).toEqual(['normal', 'screen', 'multiply', 'normal']);
    for (const l of layers) expect(l.effects).toEqual([]);
    // one undo step restores the styles
    useEditor.getState().undo();
    expect(session().doc).toBe(before);
  });

  it('a layer blend mode with Normal effects: exact (the pieces are not knocked out twice)', () => {
    const d = createDocument({ name: 'blend', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    const char = raster(d, softBlob(), { name: 'Char', effects: [normalShadow(), multiplyStroke()], blendMode: 'multiply' });
    const { before, after } = rasterize(d, char.id);
    const layers = after.rootIds.map((id) => after.layers[id]);
    expect(layers.map((l) => l.blendMode)).toEqual(['normal', 'normal', 'multiply', 'multiply']);
    expect(maxDiff(pixels(before), pixels(after))).toBeLessThanOrEqual(2);
  });

  it('a Screen shadow at a reduced opacity and Fill: split, each piece at the layer opacity', () => {
    const d = createDocument({ name: 'opacity', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    const char = raster(d, softBlob(), { name: 'Char', effects: [screenShadow()], opacity: 0.7, fillOpacity: 0.6 });
    const { before, after } = rasterize(d, char.id);
    const layers = after.rootIds.map((id) => after.layers[id]);
    expect(layers.map((l) => l.name)).toEqual(['Paper', "Char's Drop Shadow", 'Char']);
    expect(layers[1].opacity).toBeCloseTo(0.7, 5);
    expect(layers[2].opacity).toBeCloseTo(0.7, 5);
    // nothing drawn over the content: it stays at full Fill and keeps its Fill (like PSD export)
    expect(layers[2].fillOpacity).toBeCloseTo(0.6, 5);
    expect(maxDiff(pixels(before), pixels(after))).toBeLessThanOrEqual(2);
  });

  it('Normal effects on a Normal layer stay one pixel layer', () => {
    const d = createDocument({ name: 'plain', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    const char = raster(d, softBlob(), { name: 'Char', effects: [normalShadow()] });
    const { before, after } = rasterize(d, char.id);
    expect(after.rootIds.map((id) => after.layers[id].name)).toEqual(['Paper', 'Char']);
    expect(maxDiff(pixels(before), pixels(after))).toBeLessThanOrEqual(2);
  });

  it('a clipped layer with a Screen shadow (the compositor flattens clipped layers): one pixel layer, exact', () => {
    const d = createDocument({ name: 'clipped', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    const char = raster(d, softBlob(), { name: 'Char', effects: [screenShadow()], clipped: true });
    const { before, after } = rasterize(d, char.id);
    expect(after.rootIds.map((id) => after.layers[id].name)).toEqual(['Paper', 'Char']);
    expect(maxDiff(pixels(before), pixels(after))).toBeLessThanOrEqual(2);
  });
});

/**
 * A clipping-mask base clips the layers above to its content at full Fill: baking its Fill into
 * its pixels (or effects that reach past the content) would change what they show.
 */
describe('Rasterize Layer Style on a clipping-mask base', () => {
  const clipDoc = (base: Partial<Layer>) => {
    const d = createDocument({ name: 'clip', width: S, height: S, background: null });
    raster(d, paper(), { name: 'Paper' });
    const b = raster(d, disc(), { name: 'Base', ...base });
    raster(d, texture(), { name: 'Tex', clipped: true });
    return { d, b };
  };

  it('reduced Fill with a Screen shadow behind: the content keeps full Fill and its Fill, exact', () => {
    const { d, b } = clipDoc({ effects: [screenShadow()], fillOpacity: 0.4 });
    const { before, after } = rasterize(d, b.id);
    const layers = after.rootIds.map((id) => after.layers[id]);
    expect(layers.map((l) => l.name)).toEqual(['Paper', "Base's Drop Shadow", 'Base', 'Tex']);
    expect(layers[1].blendMode).toBe('screen');
    expect(layers[2].fillOpacity).toBeCloseTo(0.4, 5);
    expect(layers[2].effects).toEqual([]);
    expect(layers[3].clipped).toBe(true);
    expect(maxDiff(pixels(before), pixels(after))).toBeLessThanOrEqual(2);
    expect(lastToast()?.kind).not.toBe('warning');
  });

  it('reduced Fill with a Normal shadow and an enabled mask: exact, the mask applied with the style', () => {
    const { d, b } = clipDoc({ effects: [normalShadow()], fillOpacity: 0.5 });
    const m = canvasOf((x) => (x < 14 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    b.mask = { bitmapId: bitmaps.add(m), enabled: true, density: 1, feather: 0, inverted: false } as Layer['mask'];
    const { before, after } = rasterize(d, b.id);
    const base = after.layers[after.rootIds[2]];
    expect(base.name).toBe('Base');
    expect(base.mask).toBeNull();
    expect(base.fillOpacity).toBeCloseTo(0.5, 5);
    expect(maxDiff(pixels(before), pixels(after))).toBeLessThanOrEqual(2);
  });

  it('an effect over the content at 100% Fill (inside the content): exact, no warning', () => {
    const { d, b } = clipDoc({ effects: [screenShadow(), overlay()] });
    const { before, after } = rasterize(d, b.id);
    expect(after.rootIds.map((id) => after.layers[id].name)).toEqual(['Paper', "Base's Drop Shadow", 'Base', 'Tex']);
    expect(maxDiff(pixels(before), pixels(after))).toBeLessThanOrEqual(2);
    expect(lastToast()?.kind).not.toBe('warning');
  });

  it('an effect over the content with a reduced Fill: no exact pixel form, so the change is reported', () => {
    const { d, b } = clipDoc({ effects: [overlay()], fillOpacity: 0.4 });
    rasterize(d, b.id);
    const t = lastToast();
    expect(t?.kind).toBe('warning');
    expect(t?.message).toContain('Layers clipped to “Base” now fade with its 40% Fill');
    expect(t?.message).toContain('Undo (Ctrl+Z)');
    useEditor.getState().undo();
    expect(session().doc.layers[b.id].effects).toHaveLength(1);
  });

  it('a centered stroke reaching past the content: reported (clipped layers now cover it)', () => {
    const { d, b } = clipDoc({ effects: [centerStroke()] });
    rasterize(d, b.id);
    const t = lastToast();
    expect(t?.kind).toBe('warning');
    expect(t?.message).toContain('Layers clipped to “Base” now also cover its effects past its edge');
    expect(t?.message).not.toContain('Fill');
  });

  it('with pieces split off too, the note does not claim the clipping looks the same', () => {
    const { d, b } = clipDoc({ effects: [screenShadow(), overlay()], fillOpacity: 0.5 });
    rasterize(d, b.id);
    const t = lastToast();
    expect(t?.message).toContain('were placed on “Base\'s Drop Shadow” below it.');
    expect(t?.message).not.toContain('clipping keep looking the same');
    expect(t?.message).toContain('now fade with its 50% Fill');
  });
});
