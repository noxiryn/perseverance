/**
 * PSD round trip of clip stacks whose adjustment has no Photoshop equivalent (baked into a pixel
 * layer, see psdBake.ts): export (buildPsd) → import (psdToDocument) → render both with the real
 * compositor on the test-only software canvas. With Photoshop clipping semantics in the renderer
 * (a clip stack keeps its base's coverage, src/render/clip.ts), the baked layer re-imports to the
 * same pixels — also over soft (semi-transparent) base edges, where the old renderer was off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Document, Layer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeAdjustmentLayer, makeRasterLayer } from '../core/document';
import { filters } from '../registry';
import { installSoftCanvas, pixelAt } from '../render/softCanvas';
import { invalidateRenderCache, renderDocument } from '../render/compositor';
import { setCropExactBackend } from '../render/backendProbe';
import { buildPsd, psdToDocument } from './psd';

type RGBA = [number, number, number, number];
const W = 8;
const H = 8;
let uninstall: () => void = () => {};

beforeAll(() => {
  uninstall = installSoftCanvas();
  setCropExactBackend(true);
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

function canvasOf(draw: (x: number, y: number) => RGBA): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const k = c.getContext('2d')!;
  const img = k.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.data.set(draw(x, y), (y * W + x) * 4);
  k.putImageData(img, 0, 0);
  return c;
}

/** Soft-edged base: alpha ramps from 8 to 255 across the document, colour varies. */
const softBase = () => canvasOf((x, y) => [30 + 25 * x, 220 - 20 * y, 60 + 10 * x, Math.min(255, 8 + 35 * x)]);

function raster(d: Document, c: HTMLCanvasElement, props: Partial<Layer> = {}) {
  const l = makeRasterLayer({ name: props.name ?? 'Layer', bitmapId: bitmaps.add(c), width: W, height: H });
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
function roundTrip(d: Document) {
  invalidateRenderCache();
  const built = buildPsd(d, { bakeStyles: false });
  const back = psdToDocument(built.psd, 'back').doc;
  invalidateRenderCache();
  const a = renderDocument(d, { background: false });
  const b = renderDocument(back, { background: false });
  const px: { a: RGBA; b: RGBA }[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.push({ a: pixelAt(a, x, y), b: pixelAt(b, x, y) });
  return { built, back, px };
}

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
});
