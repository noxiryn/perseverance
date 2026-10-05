/**
 * PSD round trip of clip stacks whose adjustment has no Photoshop equivalent (baked into a pixel
 * layer, see psdBake.ts): export (buildPsd) → import (psdToDocument) → render both with the real
 * compositor on the test-only software canvas. With Photoshop clipping semantics in the renderer
 * (a clip stack keeps its base's coverage, src/render/clip.ts), the baked layer re-imports to the
 * same pixels — also over soft (semi-transparent) base edges, where the old renderer was off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Document, Layer, LayerEffect, ParamValues } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeAdjustmentLayer, makeRasterLayer } from '../core/document';
import { filters } from '../registry';
import { installSoftCanvas, pixelAt } from '../render/softCanvas';
import { invalidateRenderCache, renderDocument } from '../render/compositor';
import { setCropExactBackend } from '../render/backendProbe';
import { registerEffects } from '../render/effects';
import { buildPsd, psdToDocument } from './psd';

type RGBA = [number, number, number, number];
const W = 8;
const H = 8;
let uninstall: () => void = () => {};

beforeAll(() => {
  uninstall = installSoftCanvas();
  setCropExactBackend(true);
  registerEffects();
  filters.register({
    id: 'test-psd-invert',
    name: 'Invert (test, no Photoshop equivalent)',
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
});

afterAll(() => {
  invalidateRenderCache();
  filters.unregister('test-psd-invert');
  uninstall();
});

function canvasOf(draw: (x: number, y: number) => RGBA, w = W, h = H): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const k = c.getContext('2d')!;
  const img = k.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(draw(x, y), (y * w + x) * 4);
  k.putImageData(img, 0, 0);
  return c;
}

/** Soft-edged base: alpha ramps from 8 to 255 across the document, colour varies. */
const softBase = () => canvasOf((x, y) => [30 + 25 * x, 220 - 20 * y, 60 + 10 * x, Math.min(255, 8 + 35 * x)]);

function raster(d: Document, c: HTMLCanvasElement, props: Partial<Layer> = {}) {
  const l = makeRasterLayer({ name: props.name ?? 'Layer', bitmapId: bitmaps.add(c), width: c.width, height: c.height });
  Object.assign(l, props);
  insertLayerDraft(d, l, {});
  return l;
}

function invert(d: Document, props: Partial<Layer> = {}) {
  const a = makeAdjustmentLayer({ name: 'Invert', filterId: 'test-psd-invert' });
  Object.assign(a, props);
  insertLayerDraft(d, a, {});
  return a;
}

/** Export + re-import; both documents rendered (straight RGBA per pixel). */
function roundTrip(d: Document, bakeStyles = false) {
  invalidateRenderCache();
  const built = buildPsd(d, { bakeStyles });
  const back = psdToDocument(built.psd, 'back').doc;
  invalidateRenderCache();
  const a = renderDocument(d, { background: false });
  const b = renderDocument(back, { background: false });
  const px: { a: RGBA; b: RGBA }[] = [];
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) px.push({ a: pixelAt(a, x, y), b: pixelAt(b, x, y) });
  return { built, back, px };
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

const S = 24;
/** A soft round character (alpha ramps to 0 over its outer 5 px), colour varying across it. */
const softBlob = () =>
  canvasOf(
    (x, y) => {
      const r = Math.hypot(x - 11.5, y - 11.5);
      return [40 + 8 * x, 200 - 6 * y, 90 + 4 * x, Math.max(0, Math.min(255, Math.round(((9 - r) / 5) * 255)))];
    },
    S,
    S,
  );
const fx = (effectId: string, params: ParamValues): LayerEffect => ({ id: `fx-${effectId}`, effectId, enabled: true, params });
/**
 * Behind-stage effects (drawn below the clip stack): a drop shadow and an outside stroke. (A hard
 * shadow: the test-only software canvas has no CSS blur.)
 */
const behindFx = () => [
  fx('drop-shadow', { color: '#200040', blendMode: 'normal', opacity: 0.8, angle: 90, distance: 3, spread: 0, size: 0 }),
  fx('stroke', { size: 2, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#ffffff' }),
];

/** Largest premultiplied colour difference; alpha must match exactly. */
function maxColourDiff(px: { a: RGBA; b: RGBA }[]): number {
  let max = 0;
  for (const { a, b } of px) {
    expect(b[3], `alpha ${a} vs ${b}`).toBe(a[3]);
    for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs((a[k] * a[3]) / 255 - (b[k] * b[3]) / 255));
  }
  return max;
}

describe('PSD round trip of clipped baked adjustments over soft base edges', () => {
  it('a plain clipped bake re-imports to identical pixels', () => {
    const d = createDocument({ name: 'clip', width: W, height: H, background: null });
    raster(d, softBase(), { name: 'Base' });
    invert(d, { clipped: true });
    const { built, back, px } = roundTrip(d);
    expect(built.bakedAdjustments).toEqual(['Invert']);
    expect(built.approxAdjustments).toEqual([]);
    const baked = back.layers[back.rootIds[1]];
    expect(baked.type).toBe('raster');
    expect(baked.clipped).toBe(true);
    for (const { a, b } of px) expect(b).toEqual(a);
  });

  it('with an opacity and a clipped layer below it: coverage exact, colour within rounding', () => {
    const d = createDocument({ name: 'clip', width: W, height: H, background: null });
    raster(d, softBase(), { name: 'Base' });
    raster(
      d,
      canvasOf((x, y) => [255, 20 * y, 40, 90 + 20 * y]),
      { name: 'Shade', clipped: true, blendMode: 'multiply', opacity: 0.7 },
    );
    invert(d, { clipped: true, opacity: 0.6 });
    const { built, back, px } = roundTrip(d);
    expect(built.approxAdjustments).toEqual([]);
    expect(back.rootIds.map((id) => back.layers[id].clipped)).toEqual([false, true, true]);
    // The adjustment mixes with a lerp, the baked pixel layer with source-over: rounding only.
    expect(maxColourDiff(px)).toBeLessThanOrEqual(2);
  });

  it('a base at a lower Fill cannot be reproduced by a pixel layer: reported as approximate', () => {
    // The clip stack sits at the Fill's alpha inside the base's shape, which the adjustment keeps;
    // Photoshop composites the baked layer up to the shape (denser), so the export says so.
    const d = createDocument({ name: 'clip', width: W, height: H, background: null });
    raster(d, canvasOf(() => [40, 90, 200, 255]), { name: 'Base', fillOpacity: 0.5 });
    invert(d, { clipped: true });
    const { built, px } = roundTrip(d);
    expect(built.approxAdjustments).toEqual(['Invert']);
    // ours: the inverted base colour at the Fill's alpha; the re-import: at the shape's alpha
    const [r, g, b, a] = px[0].a;
    expect(a).toBe(128);
    for (const [got, want] of [[r, 215], [g, 165], [b, 55]]) expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
    expect(px[0].b[3]).toBe(255);
    // 0% Fill and nothing clipped below: nothing to adjust, nothing written — exact, not flagged.
    const z = createDocument({ name: 'clip', width: W, height: H, background: null });
    raster(z, canvasOf(() => [40, 90, 200, 255]), { name: 'Base', fillOpacity: 0 });
    invert(z, { clipped: true });
    const r0 = roundTrip(z);
    expect(r0.built.approxAdjustments).toEqual([]);
    for (const { a, b } of r0.px) expect(b).toEqual(a);
  });

  it('a base with behind-stage effects (drop shadow, outside stroke): baked from the clip stack, exact', () => {
    // The clip stack filters the base's own colour — its shadow and stroke are drawn below the
    // stack — so the bake must not see them, even where a soft content edge lies over the stroke.
    const d = createDocument({ name: 'clip', width: S, height: S, background: null });
    raster(d, softBlob(), { name: 'Base', effects: behindFx() });
    invert(d, { clipped: true });
    const { built, px } = roundTrip(d);
    expect(built.bakedAdjustments).toEqual(['Invert']);
    expect(built.approxAdjustments).toEqual([]);
    // The effects themselves round-trip (exported as Photoshop effects) …
    const plain = createDocument({ name: 'clip', width: S, height: S, background: null });
    raster(plain, softBlob(), { name: 'Base', effects: behindFx() });
    expect(maxDiff(roundTrip(plain).px)).toBe(0);
    // … and so does the stack over them, soft edges included (also where they lie over the
    // stroke: the composite is opaque there, the base's own alpha is not).
    for (const { a, b } of px) expect(b).toEqual(a);
    const shape = canvasOf(() => [0, 0, 0, 0], S, S);
    shape.getContext('2d')!.drawImage(softBlob(), 0, 0);
    let soft = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (pixelAt(shape, x, y)[3] % 255 !== 0) soft++;
    expect(soft).toBeGreaterThan(80);
  });

  it('behind-stage effects + a clipped layer below + opacity and a base opacity/blend: within rounding', () => {
    const d = createDocument({ name: 'clip', width: S, height: S, background: null });
    raster(d, softBlob(), { name: 'Base', effects: behindFx(), opacity: 0.85 });
    raster(d, canvasOf((x, y) => [255, 10 * y, 40, 60 + 8 * x], S, S), { name: 'Shade', clipped: true, blendMode: 'multiply', opacity: 0.7 });
    invert(d, { clipped: true, opacity: 0.6 });
    const { built, px } = roundTrip(d);
    expect(built.approxAdjustments).toEqual([]);
    expect(maxDiff(px)).toBeLessThanOrEqual(2);
  });

  it('an above-stage effect reaching beyond the content (centered stroke): reported as approximate', () => {
    // Clipped pixel layers can't paint over the outer half of a centered stroke; the adjustment
    // does (it filters the stack, which includes the base's above-stage effects).
    const d = createDocument({ name: 'clip', width: S, height: S, background: null });
    raster(d, canvasOf((x, y) => [40, 90, 200, Math.hypot(x - 11.5, y - 11.5) < 6 ? 255 : 0], S, S), {
      name: 'Base',
      effects: [fx('stroke', { size: 4, position: 'center', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#ffcc00' })],
    });
    invert(d, { clipped: true });
    expect(roundTrip(d).built.approxAdjustments).toEqual(['Invert']);
  });

  it('"Bake layer styles": a clip base\'s styles go into layers of their own below it, so the clip stays its shape', () => {
    // Baked into the base's pixels, the shadow and stroke would become the clip's shape and the
    // clipped layers would paint over them (like Photoshop's Create Layers instead). Layers that
    // are not clip bases are still baked whole.
    const d = createDocument({ name: 'clip', width: S, height: S, background: null });
    raster(d, canvasOf((x, y) => [200, 30, 30, x < 4 && y < 4 ? 255 : 0], S, S), {
      name: 'Badge',
      effects: [fx('stroke', { size: 1, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#00ff00' })],
    });
    raster(d, softBlob(), { name: 'Base', effects: behindFx(), opacity: 0.8, fillOpacity: 0.7 });
    raster(d, canvasOf((x, y) => [255, 10 * y, 40, 255], S, S), { name: 'Texture', clipped: true, blendMode: 'multiply' });
    invert(d, { clipped: true, opacity: 0.5 });
    const { built, back, px } = roundTrip(d, true);
    expect(built.splitClipBases).toEqual(['Base']);
    expect(built.editableClipBases).toEqual([]);
    expect(built.baked).toEqual([]);
    expect(built.approxAdjustments).toEqual([]);
    const layers = back.rootIds.map((id) => back.layers[id]);
    expect(layers.map((l) => l.name)).toEqual(['Badge', "Base's Styles 1", "Base's Styles 2", 'Base', 'Texture', 'Invert']);
    expect(layers.map((l) => l.clipped)).toEqual([false, false, false, false, true, true]);
    for (const l of layers) expect(l.effects).toEqual([]); // all baked
    expect(layers[1].opacity).toBeCloseTo(0.8, 2); // the base's opacity, on each piece
    expect(layers[3].fillOpacity).toBeCloseTo(0.7, 2); // the base's content, Fill left to Photoshop
    expect(maxDiff(px)).toBe(0);
  });

  it('a clip base with above-stage effects: baked into its pixels when that keeps its shape, else kept editable', () => {
    const overlay = fx('color-overlay', { color: '#30c060', opacity: 0.5, blendMode: 'normal' });
    const disc = () => canvasOf((x, y) => [40, 90, 200, Math.hypot(x - 11.5, y - 11.5) < 7 ? 255 : 0], S, S);
    const run = (content: HTMLCanvasElement, fill: number) => {
      const d = createDocument({ name: 'clip', width: S, height: S, background: null });
      raster(d, content, { name: 'Base', effects: [...behindFx(), overlay], fillOpacity: fill });
      raster(d, canvasOf((x, y) => [255, 10 * y, 40, 140], S, S), { name: 'Texture', clipped: true });
      const r = roundTrip(d, true);
      return { ...r, base: r.back.layers[r.back.rootIds[r.back.rootIds.length - 2]] };
    };
    // Hard-edged content at full Fill: the overlay stays inside it, the base's pixels carry it.
    const hard = run(disc(), 1);
    expect(hard.built.splitClipBases).toEqual(['Base']);
    expect(hard.base.effects).toEqual([]);
    expect(maxDiff(hard.px)).toBe(0);
    // A reduced Fill would fade the baked overlay in Photoshop too; over soft edges the overlay
    // adds coverage (baked, it would grow the clip): styles stay editable.
    for (const r of [run(disc(), 0.6), run(softBlob(), 1)]) {
      expect(r.built.editableClipBases).toEqual(['Base']);
      expect(r.base.effects.map((e) => e.effectId).sort()).toEqual(['color-overlay', 'drop-shadow', 'stroke']);
    }
  });

  it('editable styles: an unsupported style on a clip base is split off instead of baked into it', () => {
    const d = createDocument({ name: 'clip', width: S, height: S, background: null });
    raster(d, softBlob(), { name: 'Base', effects: [fx('long-shadow', { color: '#102030', blendMode: 'normal', opacity: 1, angle: 135, length: 4, fade: false })] });
    raster(d, canvasOf((x, y) => [255, 10 * y, 40, 255], S, S), { name: 'Texture', clipped: true });
    const { built, back, px } = roundTrip(d, false);
    expect(built.baked).toEqual(['Base (Long Shadow)']);
    expect(built.splitClipBases).toEqual(['Base']);
    expect(back.rootIds.map((id) => back.layers[id].name)).toEqual(["Base's Styles", 'Base', 'Texture']);
    expect(maxDiff(px)).toBe(0);
    // When no split can reproduce it (an overlay at a reduced Fill), the unsupported style forces
    // the old whole bake — the clip then follows the baked styles, and the report says so.
    const e = createDocument({ name: 'clip', width: S, height: S, background: null });
    raster(e, softBlob(), {
      name: 'Base',
      fillOpacity: 0.6,
      effects: [fx('long-shadow', { color: '#102030', blendMode: 'normal', opacity: 1, angle: 135, length: 4, fade: false }), fx('color-overlay', { color: '#30c060', opacity: 0.5, blendMode: 'normal' })],
    });
    raster(e, canvasOf((x, y) => [255, 10 * y, 40, 255], S, S), { name: 'Texture', clipped: true });
    const whole = roundTrip(e, false).built;
    expect(whole.splitClipBases).toEqual([]);
    expect(whole.editableClipBases).toEqual([]);
    expect(whole.baked).toEqual(['Base (Long Shadow; clipped layers now clip to them too)']);
  });
});
