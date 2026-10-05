/**
 * Clipping masks: Photoshop semantics — a clip stack's coverage is its base's (clipped layers never
 * add coverage) and each clipped layer blends "atop" what is below it:
 *   Co = αs·B(Cb, Cs) + (1 − αs)·Cb,  αo = αb.
 * The engine tests run the real compositor on the test-only software canvas (./softCanvas.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Document, Layer, LayerEffect, RasterLayer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeAdjustmentLayer, makeGroupLayer, makeRasterLayer } from '../core/document';
import { filters } from '../registry';
import { coreExceedsShape, normalizeClipBase } from './clip';
import { installSoftCanvas, pixelAt } from './softCanvas';
import { invalidateRenderCache, renderCacheInfo, renderClipBackdrop, renderDocument, renderDocumentLive, renderLayerToDoc } from './compositor';
import { setCropExactBackend } from './backendProbe';
import { registerEffects } from './effects';

type RGBA = [number, number, number, number];

describe('clip-base pixel math', () => {
  it('makes the base opaque inside its shape (core = shape)', () => {
    const k = new Uint8ClampedArray([200, 100, 50, 128, 10, 20, 30, 255, 99, 99, 99, 0]);
    normalizeClipBase(k, null);
    expect(Array.from(k)).toEqual([200, 100, 50, 255, 10, 20, 30, 255, 0, 0, 0, 0]);
  });

  it('keeps the fill opacity relative to the shape (core at 50% fill)', () => {
    const shape = new Uint8ClampedArray([0, 0, 255, 200]);
    const core = new Uint8ClampedArray([0, 0, 255, 100]);
    normalizeClipBase(core, shape);
    expect(Array.from(core)).toEqual([0, 0, 255, 128]);
    // 0% fill: nothing of the base itself
    const none = new Uint8ClampedArray([0, 0, 255, 0]);
    normalizeClipBase(none, shape);
    expect(none[3]).toBe(0);
  });

  it('reports and normalizes a core reaching beyond the shape (coverage + share)', () => {
    const shape = new Uint8ClampedArray([0, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 255]);
    const core = new Uint8ClampedArray([255, 0, 0, 192, 0, 255, 0, 255, 1, 2, 3, 255]);
    expect(coreExceedsShape(core, shape)).toBe(true);
    expect(coreExceedsShape(shape, shape)).toBe(false);
    const cover = new Uint8ClampedArray(12);
    const share = new Uint8ClampedArray(12);
    normalizeClipBase(core, shape, cover, share);
    expect([cover[3], cover[7], cover[11]]).toEqual([192, 255, 255]);
    expect([share[3], share[7], share[11]]).toEqual([170, 0, 255]); // 128/192, 0/255, 1
    expect([core[3], core[7], core[11]]).toEqual([255, 255, 255]);
  });
});

/* ------------------------------------------------------------------------------------------- */

const W = 8;
const H = 8;
let uninstall: () => void = () => {};

beforeAll(() => {
  uninstall = installSoftCanvas();
  setCropExactBackend(true);
  registerEffects();
  filters.register({
    id: 'test-invert',
    name: 'Invert (test)',
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
  filters.unregister('test-invert');
  uninstall();
});

function canvasOf(w: number, h: number, draw: (x: number, y: number) => RGBA): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const k = c.getContext('2d')!;
  const img = k.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) img.data.set(draw(x, y), (y * w + x) * 4);
  k.putImageData(img, 0, 0);
  return c;
}

const solid = (c: RGBA) => canvasOf(W, H, () => c);

function doc(): Document {
  return createDocument({ name: 'clip', width: W, height: H, background: null });
}

function raster(d: Document, px: RGBA | HTMLCanvasElement, props: Partial<Layer> = {}, parentId?: string): Layer & { bitmapId: string } {
  const c = px instanceof HTMLCanvasElement ? px : solid(px);
  const l = makeRasterLayer({ name: 'L', bitmapId: bitmaps.add(c), width: c.width, height: c.height });
  Object.assign(l, props);
  insertLayerDraft(d, l, parentId ? { parentId } : {});
  return l;
}

function adjustment(d: Document, filterId: string, props: Partial<Layer> = {}): Layer {
  const l = makeAdjustmentLayer({ name: 'A', filterId });
  Object.assign(l, props);
  insertLayerDraft(d, l, {});
  return l;
}

function group(d: Document, props: Partial<Layer> = {}): Layer {
  const g = makeGroupLayer({ name: 'G' });
  Object.assign(g, props);
  insertLayerDraft(d, g, {});
  return g;
}

let clones = 0;
/** The same document with new layer / document ids: rendered from scratch, other caches untouched. */
function cloneDoc(d: Document): Document {
  const n = ++clones;
  const id = (x: string) => `${x}~${n}`;
  const layers: Document['layers'] = {};
  for (const l of Object.values(d.layers)) {
    const c = { ...l, id: id(l.id) } as Layer;
    if (c.type === 'group' && l.type === 'group') c.childIds = l.childIds.map(id);
    layers[c.id] = c;
  }
  return { ...d, id: id(d.id), layers, rootIds: d.rootIds.map(id) };
}

/** Straight RGBA at (x, y) of a fresh full render. */
function render(d: Document, x = 3, y = 3): RGBA {
  invalidateRenderCache();
  return pixelAt(renderDocument(d, { background: false }), x, y);
}

function near(got: RGBA, want: RGBA, tol = 1) {
  for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i]), `channel ${i}: got ${got} want ${want}`).toBeLessThanOrEqual(tol);
}

describe('clip stacks (compositor)', () => {
  it('a clipped layer over a 50% base keeps the base alpha and shows its own colour', () => {
    const d = doc();
    raster(d, [0, 0, 255, 128]);
    raster(d, [255, 0, 0, 255], { clipped: true });
    near(render(d), [255, 0, 0, 128]);
  });

  it('clipped multiply / screen blend with the base colour atop it', () => {
    const m = doc();
    raster(m, [200, 100, 50, 128]);
    raster(m, [128, 128, 128, 255], { clipped: true, blendMode: 'multiply' });
    // B = Cb·Cs
    near(render(m), [100, 50, 25, 128], 2);
    const s = doc();
    raster(s, [200, 100, 50, 128]);
    raster(s, [128, 128, 128, 255], { clipped: true, blendMode: 'screen' });
    // B = Cb + Cs − Cb·Cs
    near(render(s), [228, 178, 153, 128], 2);
  });

  it('a clipped layer at 50% opacity (or fill) mixes half-way, alpha unchanged', () => {
    for (const props of [{ opacity: 0.5 }, { fillOpacity: 0.5 }]) {
      const d = doc();
      raster(d, [0, 0, 255, 128]);
      raster(d, [255, 0, 0, 255], { clipped: true, ...props });
      near(render(d), [128, 0, 128, 128], 2);
    }
    // a semi-transparent clipped layer: αs = 0.25
    const d = doc();
    raster(d, [0, 0, 255, 128]);
    raster(d, [255, 0, 0, 64], { clipped: true });
    near(render(d), [64, 0, 191, 128], 2);
  });

  it('a clipped adjustment over a soft base keeps its alpha (also with a blend mode)', () => {
    const d = doc();
    raster(d, [200, 100, 50, 128]);
    adjustment(d, 'test-invert', { clipped: true });
    near(render(d), [55, 155, 205, 128], 2);
    const b = doc();
    raster(b, [200, 100, 50, 128]);
    adjustment(b, 'test-invert', { clipped: true, blendMode: 'multiply' });
    // B = Cb·(1 − Cb)
    near(render(b), [43, 61, 40, 128], 2);
  });

  it('an adjustment with a blend mode never changes coverage outside clip stacks either', () => {
    const d = doc();
    raster(d, [200, 100, 50, 128]);
    adjustment(d, 'test-invert', { blendMode: 'screen', opacity: 0.5 });
    // screen(Cb, 1 − Cb) mixed half-way with Cb
    const scr = (c: number) => c + (255 - c) - (c * (255 - c)) / 255;
    near(render(d), [(200 + scr(200)) / 2, (100 + scr(100)) / 2, (50 + scr(50)) / 2, 128].map(Math.round) as RGBA, 2);
  });

  it('a clipped adjustment and its PSD bake (filtered colour at full alpha, clipped) render alike', () => {
    // src/io/psdBake.ts: clipped adjustments without a Photoshop equivalent are written as pixel
    // layers holding the filtered backdrop at full alpha wherever it has coverage.
    const soft = canvasOf(W, H, (x, y) => [30 + 25 * x, 220 - 20 * y, 60 + 10 * x, Math.min(255, 8 + 31 * x)]);
    // The backdrop as the exporter reads it (getImageData: straight colour of stored pixels).
    const bd = soft.getContext('2d')!.getImageData(0, 0, W, H).data;
    const baked = canvasOf(W, H, (x, y) => {
      const i = (y * W + x) * 4;
      return bd[i + 3] ? [255 - bd[i], 255 - bd[i + 1], 255 - bd[i + 2], 255] : [0, 0, 0, 0];
    });
    const orig = doc();
    raster(orig, soft);
    adjustment(orig, 'test-invert', { clipped: true, opacity: 0.6 });
    const back = doc();
    raster(back, soft);
    raster(back, baked, { clipped: true, opacity: 0.6 });
    invalidateRenderCache();
    const a = renderDocument(orig, { background: false });
    const b = renderDocument(back, { background: false });
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const pa = pixelAt(a, x, y);
        const pb = pixelAt(b, x, y);
        expect(pb[3]).toBe(pa[3]);
        // Premultiplied (the straight colour of soft pixels is quantized by their alpha); the
        // adjustment mixes with a lerp, the pixel layer with source-over: rounding only.
        for (let k = 0; k < 3; k++) expect(Math.abs((pa[k] * pa[3]) / 255 - (pb[k] * pb[3]) / 255)).toBeLessThanOrEqual(2);
      }
  });

  it('two stacked clipped layers composite in order over the base', () => {
    const d = doc();
    raster(d, [0, 0, 255, 128]);
    raster(d, [255, 0, 0, 255], { clipped: true, opacity: 0.5 });
    raster(d, [0, 255, 0, 128], { clipped: true });
    // (0.5 red + 0.5 blue), then green at 50%
    near(render(d), [64, 128, 64, 128], 2);
  });

  it('base opacity, fill and mask scale the stack, a 0% fill base still clips', () => {
    const op = doc();
    raster(op, [0, 0, 255, 128], { opacity: 0.5 });
    raster(op, [255, 0, 0, 255], { clipped: true });
    near(render(op), [255, 0, 0, 64]);
    // Fill 0: the base itself draws nothing, clipped content shows inside its shape.
    const f0 = doc();
    raster(f0, [0, 0, 255, 128], { fillOpacity: 0 });
    raster(f0, [255, 0, 0, 255], { clipped: true });
    near(render(f0), [255, 0, 0, 128]);
    // Fill 50% over an opaque shape: the base is half there, a 50% clipped red over it.
    const f5 = doc();
    raster(f5, [0, 0, 255, 255], { fillOpacity: 0.5 });
    raster(f5, [255, 0, 0, 128], { clipped: true });
    near(render(f5), [170, 0, 85, 191], 2);
    // A layer mask (left half hidden, right half 50%) limits the coverage.
    const mk = doc();
    const maskId = bitmaps.add(canvasOf(W, H, (x) => (x < W / 2 ? [0, 0, 0, 255] : [128, 128, 128, 255])));
    raster(mk, [0, 0, 255, 255], { mask: { bitmapId: maskId, enabled: true, density: 1, feather: 0, inverted: false } });
    raster(mk, [255, 0, 0, 255], { clipped: true });
    near(render(mk, 1, 3), [0, 0, 0, 0]);
    near(render(mk, 6, 3), [255, 0, 0, 128]);
  });

  it('a hidden base hides its whole clipping group', () => {
    const d = doc();
    raster(d, [0, 0, 255, 128], { visible: false });
    raster(d, [255, 0, 0, 255], { clipped: true });
    near(render(d), [0, 0, 0, 0], 0);
  });

  it('groups: a group base, and clip stacks inside isolated and pass-through groups', () => {
    const gb = doc();
    const g = group(gb, { blendMode: 'normal' });
    raster(gb, [0, 0, 255, 128], {}, g.id);
    raster(gb, [255, 0, 0, 255], { clipped: true });
    near(render(gb), [255, 0, 0, 128]);
    for (const blendMode of ['normal', 'pass-through'] as const) {
      const d = doc();
      const p = group(d, { blendMode });
      raster(d, [0, 0, 255, 128], {}, p.id);
      raster(d, [255, 0, 0, 255], { clipped: true }, p.id);
      near(render(d), [255, 0, 0, 128]);
      // merged copy of the group (renderLayerToDoc) agrees
      invalidateRenderCache();
      near(pixelAt(renderLayerToDoc(d, d.layers[p.id])!, 3, 3), [255, 0, 0, 128]);
    }
  });

  it('a base whose above-stage effect adds coverage: clipped layers never add any beyond the base render', () => {
    const fx: LayerEffect = { id: 'e1', effectId: 'color-overlay', enabled: true, params: { color: '#00ff00', opacity: 1, blendMode: 'normal' } };
    const alone = doc();
    raster(alone, [0, 0, 255, 128], { effects: [fx] });
    const a0 = render(alone);
    const d = doc();
    raster(d, [0, 0, 255, 128], { effects: [fx] });
    raster(d, [255, 0, 0, 255], { clipped: true });
    const got = render(d);
    expect(got[3]).toBe(a0[3]);
    // Base core: 50% blue under a green overlay → α 0.75, colour (0, 2/3, 1/3). The clipped red
    // paints its share α_shape / α_core = 2/3 of that coverage: 2/3 red + 1/3 base colour.
    near(a0, [0, 170, 85, 192]);
    near(got, [170, 57, 28, 192], 2);
  });

  it('live (incremental) composites match full renders while painting the base or a clipped layer', () => {
    // Soft-edged base (alpha ramp), clipped multiply + clipped adjustment above.
    const ramp = canvasOf(W, H, (x, y) => [40 + 20 * x, 200 - 10 * y, 90, Math.min(255, 16 + 34 * x)]);
    // Zero-copy base (the bitmap is the render) and a base with its own render canvases (80% fill).
    for (const baseProps of [{}, { fillOpacity: 0.8 }]) {
      const d = doc();
      const base = raster(d, ramp, baseProps);
      const top = raster(d, canvasOf(W, H, (x, y) => [255, 30 * y, 0, 64 + 24 * y]), { clipped: true, blendMode: 'multiply' });
      adjustment(d, 'test-invert', { clipped: true, opacity: 0.4 });
      invalidateRenderCache();
      let seq = renderDocumentLive(d, { background: false }).seq;
      renderDocument(d, { background: false });
      const paint = (id: string, x: number, y: number, c: RGBA) => {
        const k = bitmaps.get(id).getContext('2d')!;
        k.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
        k.fillRect(x, y, 2, 2);
        bitmaps.touch(id, { x, y, width: 2, height: 2 });
      };
      const strokes: [string, number, number, RGBA][] = [
        [top.bitmapId, 1, 1, [0, 0, 255, 255]],
        [base.bitmapId, 4, 2, [255, 255, 255, 40]],
        [base.bitmapId, 0, 5, [10, 200, 10, 255]],
        [top.bitmapId, 5, 5, [0, 255, 0, 128]],
      ];
      for (const [id, x, y, c] of strokes) {
        paint(id, x, y, c);
        const before = renderCacheInfo().liveRegionRenders;
        const live = renderDocumentLive(d, { background: false, since: seq });
        seq = live.seq;
        // updated in place over the painted area, not re-rendered whole
        expect(renderCacheInfo().liveRegionRenders).toBe(before + 1);
        expect(live.dirty).not.toBeNull();
        const full = renderDocument(cloneDoc(d), { background: false });
        for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) expect(pixelAt(live.canvas, xx, yy), `live (${xx},${yy}) after painting at ${x},${y}`).toEqual(pixelAt(full, xx, yy));
        // the shared (cached) composite is brought up to date incrementally as well
        const shared = renderDocument(d, { background: false });
        for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) expect(pixelAt(shared, xx, yy), `shared (${xx},${yy})`).toEqual(pixelAt(full, xx, yy));
      }
    }
  });

  it('renderClipBackdrop: the stack a clipped layer sees — normalized base + clipped below, no behind effects', () => {
    const d = doc();
    // Soft base (alpha 128) with an outside stroke (a behind-stage effect) over the edge pixels.
    const base = raster(d, canvasOf(W, H, (x, y) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? [200, 40, 90, x === 2 ? 128 : 255] : [0, 0, 0, 0])), {
      effects: [{ id: 's', effectId: 'stroke', enabled: true, params: { size: 1, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#ffffff' } }],
    });
    const shade = raster(d, [0, 0, 255, 255], { clipped: true, opacity: 0.5 });
    raster(d, [0, 255, 0, 255], { clipped: true, visible: false });
    const adj = adjustment(d, 'test-invert', { clipped: true });
    const bd = renderClipBackdrop(d, adj.id);
    if (!bd || bd === 'empty') throw new Error('expected a clip stack');
    const at = (c: HTMLCanvasElement, x: number, y: number) => pixelAt(c, x - bd.x, y - bd.y);
    // Inside the base: its colour made opaque (even on the soft column, which the stroke lies
    // under), the 50% blue shade composited on it; the hidden green layer is skipped.
    for (const x of [2, 4]) {
      const [r, g, b, a] = at(bd.stack, x, 3);
      expect(a).toBe(255);
      expect(Math.abs(r - 100)).toBeLessThanOrEqual(1);
      expect(Math.abs(g - 20)).toBeLessThanOrEqual(1);
      expect(Math.abs(b - 173)).toBeLessThanOrEqual(1);
    }
    // Coverage: the base's shape (soft column 128), nothing where only the stroke is.
    expect(at(bd.cover, 2, 3)[3]).toBe(128);
    expect(at(bd.cover, 4, 3)[3]).toBe(255);
    expect(at(bd.cover, 1, 3)[3]).toBe(0);
    expect(bd.share).toBeNull();
    // The layer right above the base sees the base alone.
    const first = renderClipBackdrop(d, shade.id);
    if (!first || first === 'empty') throw new Error('expected a clip stack');
    expect(pixelAt(first.stack, 4 - first.x, 3 - first.y)).toEqual([200, 40, 90, 255]);
    // Not in a clip stack: the base itself, an unclipped layer, a layer clipped above an adjustment.
    expect(renderClipBackdrop(d, base.id)).toBeNull();
    const e = doc();
    adjustment(e, 'test-invert');
    const overAdj = raster(e, [9, 9, 9, 255], { clipped: true });
    expect(renderClipBackdrop(e, overAdj.id)).toBeNull();
    // A base with nothing to render (moved off the canvas): the whole stack is empty.
    const f = doc();
    const off = raster(f, [255, 0, 0, 255]) as RasterLayer;
    off.transform = { ...off.transform, x: 100 };
    const z = adjustment(f, 'test-invert', { clipped: true });
    expect(renderClipBackdrop(f, z.id)).toBe('empty');
    // A transparent base still has a (transparent) stack: nothing to filter, nothing baked.
    const t = doc();
    raster(t, [0, 0, 0, 0]);
    const tz = adjustment(t, 'test-invert', { clipped: true });
    const tb = renderClipBackdrop(t, tz.id);
    if (!tb || tb === 'empty') throw new Error('expected a clip stack');
    expect(pixelAt(tb.stack, 3, 3)[3]).toBe(0);
  });
});
