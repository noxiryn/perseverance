/**
 * Render-cache regressions: cached / incremental renders must equal fresh renders after every edit
 * (release review render-paint-diff-1…5, e2e-flows-3). The engine tests run the real compositor
 * on the test-only software canvas (./softCanvas.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Document, FilterInstance, Layer, LayerEffect } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeAdjustmentLayer, makeGroupLayer, makeRasterLayer } from '../core/document';
import { filters } from '../registry';
import { installSoftCanvas, pixelAt } from './softCanvas';
import { invalidateRenderCache, renderCacheInfo, renderDocument, renderDocumentLive, settleRenderCaches } from './compositor';
import { setCropExactBackend } from './backendProbe';
import { SlotCache, hardCapFor, slots } from './cache';
import { registerEffects } from './effects';
import { boundsStats } from './contentBounds';

type RGBA = [number, number, number, number];

let uninstall: () => void = () => {};

beforeAll(() => {
  uninstall = installSoftCanvas();
  setCropExactBackend(true);
  registerEffects();
  filters.register({
    id: 'rc-invert',
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

/** Smart-filter apply() calls per test filter id (see the move tests). */
const applied: Record<string, number> = {};
const count = (id: string) => (applied[id] = (applied[id] ?? 0) + 1);

beforeAll(() => {
  // A neighbourhood filter that never reads the document position (3×3 box blur, like cel-shade
  // / blurs / edges).
  filters.register({
    id: 'rc-box',
    name: 'Box (test)',
    category: 'Blur',
    params: [{ key: 'radius', label: 'Radius', type: 'number', default: 1, min: 1, max: 1 }],
    apply: (img) => {
      count('rc-box');
      const { width: w, height: h, data: d } = img;
      const src = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let k = 0; k < 4; k++) {
            let sum = 0;
            for (let v = -1; v <= 1; v++)
              for (let u = -1; u <= 1; u++) {
                const xx = Math.min(w - 1, Math.max(0, x + u));
                const yy = Math.min(h - 1, Math.max(0, y + v));
                sum += src[(yy * w + xx) * 4 + k];
              }
            d[(y * w + x) * 4 + k] = Math.round(sum / 9);
          }
      return img;
    },
  });
  // A pixel-local adjustment with a dither pattern anchored to the image crop (like gradient-map).
  filters.register({
    id: 'rc-dither',
    name: 'Dither (test)',
    category: 'Adjustments',
    adjustment: true,
    params: [],
    apply: (img) => {
      count('rc-dither');
      const { width: w, data: d } = img;
      for (let i = 0; i < d.length; i += 4) {
        const x = (i / 4) % w;
        const y = Math.floor(i / 4 / w);
        const t = ((x & 3) * 4 + (y & 3)) * 3;
        d[i] = Math.min(255, d[i] + t);
      }
      return img;
    },
  });
  // A doc-anchored pattern (like halftone / grain): reads the document position.
  filters.register({
    id: 'rc-anchored',
    name: 'Anchored (test)',
    category: 'Stylize',
    params: [],
    apply: (img, _p, ctx) => {
      count('rc-anchored');
      const { width: w, data: d } = img;
      const ox = Math.round(ctx.offsetX * ctx.scale);
      const oy = Math.round(ctx.offsetY * ctx.scale);
      for (let i = 0; i < d.length; i += 4) {
        const x = (i / 4) % w;
        const y = Math.floor(i / 4 / w);
        if (((x + ox) >> 2) % 2 === ((y + oy) >> 2) % 2) d[i + 1] = 255 - d[i + 1];
      }
      return img;
    },
  });
});

afterAll(() => {
  invalidateRenderCache();
  filters.unregister('rc-invert');
  filters.unregister('rc-box');
  filters.unregister('rc-dither');
  filters.unregister('rc-anchored');
  uninstall();
});

function canvasOf(w: number, h: number, draw: (x: number, y: number) => RGBA): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const k = c.getContext('2d')!;
  const img = k.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(draw(x, y), (y * w + x) * 4);
  k.putImageData(img, 0, 0);
  return c;
}

function raster(d: Document, c: HTMLCanvasElement | [number, number, RGBA], props: Partial<Layer> = {}, parentId?: string): Layer & { bitmapId: string } {
  const cv = c instanceof HTMLCanvasElement ? c : canvasOf(c[0], c[1], () => c[2]);
  const l = makeRasterLayer({ name: 'L', bitmapId: bitmaps.add(cv), width: cv.width, height: cv.height });
  Object.assign(l, props);
  insertLayerDraft(d, l, parentId ? { parentId } : {});
  return l;
}

function group(d: Document, props: Partial<Layer> = {}, parentId?: string): Layer {
  const g = makeGroupLayer({ name: 'G' });
  Object.assign(g, props);
  insertLayerDraft(d, g, parentId ? { parentId } : {});
  return g;
}

function adjustment(d: Document, filterId: string, parentId?: string): Layer {
  const l = makeAdjustmentLayer({ name: 'A', filterId });
  insertLayerDraft(d, l, parentId ? { parentId } : {});
  return l;
}

/** A new document object with one layer replaced (what an undoable store edit produces). */
function edit(d: Document, id: string, patch: Partial<Layer>): Document {
  return { ...d, layers: { ...d.layers, [id]: { ...d.layers[id], ...patch } as Layer } };
}

function at(l: Layer, x: number, y: number): Partial<Layer> {
  return { transform: { ...(l as Layer & { transform: { x: number } }).transform, x, y } } as Partial<Layer>;
}

let clones = 0;
/** The same document with new layer / document ids: rendered from scratch, other caches untouched. */
function cloneDoc(d: Document): { doc: Document; id: (x: string) => string } {
  const n = ++clones;
  const id = (x: string) => `${x}~${n}`;
  const layers: Document['layers'] = {};
  for (const l of Object.values(d.layers)) {
    const c = { ...l, id: id(l.id) } as Layer;
    if (c.type === 'group' && l.type === 'group') c.childIds = l.childIds.map(id);
    layers[c.id] = c;
  }
  return { doc: { ...d, id: id(d.id), layers, rootIds: d.rootIds.map(id) }, id };
}

interface Diff {
  n: number;
  max: number;
  first: string;
}

function diff(a: HTMLCanvasElement, b: HTMLCanvasElement): Diff {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  const pa = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data;
  const pb = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data;
  let n = 0;
  let max = 0;
  let first = '';
  for (let i = 0; i < pa.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(pa[i + k] - pb[i + k]));
    if (m > 1) {
      if (!n) first = `(${(i / 4) % a.width},${Math.floor(i / 4 / a.width)}) ${Array.from(pa.slice(i, i + 4))} vs ${Array.from(pb.slice(i, i + 4))}`;
      n++;
      max = Math.max(max, m);
    }
  }
  return { n, max, first };
}

/** renderDocument (cached / incremental) vs a fresh render of the same state. */
function expectFresh(d: Document, label: string, o: { below?: string; scale?: number; background?: boolean } = {}) {
  const cached = renderDocument(d, o);
  const c = cloneDoc(d);
  const fresh = renderDocument(c.doc, { ...o, below: o.below ? c.id(o.below) : undefined });
  const r = diff(cached, fresh);
  expect(r.n, `${label}: ${r.n} px off (max ${r.max}), first ${r.first}`).toBe(0);
}

/** The live (viewport) composite vs a fresh render. */
function expectLiveFresh(d: Document, label: string) {
  const live = renderDocumentLive(d).canvas;
  const fresh = renderDocument(cloneDoc(d).doc);
  const r = diff(live, fresh);
  expect(r.n, `${label} (live): ${r.n} px off (max ${r.max}), first ${r.first}`).toBe(0);
}

/* ------------------------------------------------------------------------------------------- */

describe('pass-through groups in clip stacks (render-paint-diff-1)', () => {
  const W = 40;
  const H = 30;

  /** Photo, then a pass-through group (opaque Body + a Multiply shade hanging past it), then a small Texture. */
  function scene(withAdjustment: boolean) {
    const d = createDocument({ name: 'clipgroup', width: W, height: H, background: '#ffffff' });
    raster(d, canvasOf(W, H, (x, y) => [40 + 5 * x, 200 - 4 * y, 120, 255]));
    const g = group(d, { blendMode: 'pass-through' });
    const body = raster(d, [12, 10, [30, 60, 200, 255]], {}, g.id);
    Object.assign(body, at(body, 6, 6));
    const shade = raster(d, [26, 18, [200, 40, 40, 255]], { blendMode: 'multiply' }, g.id);
    Object.assign(shade, at(shade, 4, 4));
    if (withAdjustment) adjustment(d, 'rc-invert', g.id);
    const tex = raster(d, [6, 6, [250, 230, 20, 255]]);
    Object.assign(tex, at(tex, 30, 2));
    return { d, g, tex };
  }

  for (const withAdjustment of [false, true]) {
    it(`create / release / eye toggle / clip the group itself, with undo and redo${withAdjustment ? ' (adjustment inside)' : ''}`, () => {
      invalidateRenderCache();
      const { d: d0, g, tex } = scene(withAdjustment);
      expectFresh(d0, 'initial');
      expectLiveFresh(d0, 'initial');
      // (a) Create Clipping Mask on the small layer above the group
      const d1 = edit(d0, tex.id, { clipped: true });
      expectFresh(d1, 'clip texture');
      expectLiveFresh(d1, 'clip texture');
      // (c) hide / show the only clipped layer (the group goes back to inline / isolated)
      const d2 = edit(d1, tex.id, { visible: false });
      expectFresh(d2, 'hide clipped');
      expectLiveFresh(d2, 'hide clipped');
      const d3 = edit(d2, tex.id, { visible: true });
      expectFresh(d3, 'show clipped');
      expectLiveFresh(d3, 'show clipped');
      // (b) Release Clipping Mask
      const d4 = edit(d3, tex.id, { clipped: false });
      expectFresh(d4, 'release');
      expectLiveFresh(d4, 'release');
      // (d) clip the group itself onto the photo
      const d5 = edit(d4, g.id, { clipped: true });
      expectFresh(d5, 'clip group');
      expectLiveFresh(d5, 'clip group');
      // undo … redo (the store swaps back to the previous immutable documents)
      for (const [doc, label] of [
        [d4, 'undo clip group'],
        [d3, 'undo release'],
        [d1, 'undo show/hide'],
        [d0, 'undo clip'],
        [d1, 'redo clip'],
        [d4, 'redo release'],
        [d5, 'redo clip group'],
      ] as const) {
        expectFresh(doc, label);
        expectLiveFresh(doc, label);
      }
    });
  }

  /**
   * Create / Release Clipping Mask on a layer of a clip stack changes the base of the layers
   * clipped above it (where they show). Photo, a small Body, a larger Shading above; the clipped
   * area stays under the incremental-composite thresholds so the plan must see the base change.
   */
  const CW = 80;
  const CH = 60;
  function stack() {
    const d = createDocument({ name: 'clipbase', width: CW, height: CH, background: '#ffffff' });
    const photo = raster(d, canvasOf(CW, CH, (x, y) => [30 + 2 * x, 110 + y, 215 - 2 * x, 255]));
    const body = raster(d, [24, 20, [224, 192, 160, 255]]);
    Object.assign(body, at(body, 28, 20));
    const shading = raster(d, [50, 36, [192, 32, 32, 255]]);
    Object.assign(shading, at(shading, 10, 8));
    return { d, photo, body, shading };
  }

  /** Each state, then back through the list (undo) and forward again (redo). */
  function walk(states: [Document, string][]) {
    invalidateRenderCache();
    const all = [...states, ...states.slice(0, -1).reverse().map(([d, l]) => [d, `undo → ${l}`] as [Document, string]), ...states.slice(1).map(([d, l]) => [d, `redo → ${l}`] as [Document, string])];
    for (const [doc, label] of all) {
      expectFresh(doc, label);
      expectLiveFresh(doc, label);
    }
  }

  it('clipping a layer that already has a layer clipped to it, with undo and redo', () => {
    const { d, body, shading } = stack();
    const d0 = edit(d, shading.id, { clipped: true });
    const d1 = edit(d0, body.id, { clipped: true });
    walk([
      [d0, 'shading clipped to body'],
      [d1, 'clip body (shading now clipped to the photo)'],
    ]);
  });

  it('releasing the middle layer of a three-layer clip stack, with undo and redo', () => {
    const { d, body, shading } = stack();
    const d0 = edit(edit(d, body.id, { clipped: true }), shading.id, { clipped: true });
    const d1 = edit(d0, body.id, { clipped: false });
    const d2 = edit(d1, shading.id, { clipped: false });
    walk([
      [d0, 'photo, body (clipped), shading (clipped)'],
      [d1, 'release body'],
      [d2, 'release shading'],
    ]);
  });

  it('clipping a hidden base whose clipped layer then shows over the layer below, with undo and redo', () => {
    const { d, body, shading } = stack();
    const d0 = edit(edit(d, shading.id, { clipped: true }), body.id, { visible: false });
    const d1 = edit(d0, body.id, { clipped: true });
    const d2 = edit(d1, body.id, { visible: true });
    walk([
      [d0, 'hidden body with shading clipped to it'],
      [d1, 'clip the hidden body'],
      [d2, 'show body'],
    ]);
  });

  it('clipping a pass-through group that has a shown clipped layer above it, with undo and redo', () => {
    const d = createDocument({ name: 'clipgroupbase', width: CW, height: CH, background: '#ffffff' });
    raster(d, canvasOf(CW, CH, (x, y) => [30 + 2 * x, 110 + y, 215 - 2 * x, 255]));
    const g = group(d, { blendMode: 'pass-through' });
    const body = raster(d, [24, 20, [224, 192, 160, 255]], {}, g.id);
    Object.assign(body, at(body, 28, 20));
    const shade = raster(d, [12, 20, [255, 48, 48, 255]], { blendMode: 'multiply' }, g.id);
    Object.assign(shade, at(shade, 34, 24));
    const tex = raster(d, [50, 36, [32, 192, 64, 255]]);
    Object.assign(tex, at(tex, 10, 8));
    const d0 = edit(d, tex.id, { clipped: true });
    const d1 = edit(d0, g.id, { clipped: true });
    const d2 = edit(d1, tex.id, { clipped: false });
    walk([
      [d0, 'texture clipped to the group'],
      [d1, 'clip the group (texture now clipped to the photo)'],
      [d2, 'release texture'],
    ]);
  });
});

/* ------------------------------------------------------------------------------------------- */

describe('below-renders after an edit inside a styled group (render-paint-diff-4)', () => {
  const W = 80;
  const H = 60;
  const strokeFx: LayerEffect = { id: 's', effectId: 'stroke', enabled: true, params: { size: 2, position: 'outside', color: '#202020', opacity: 1, blendMode: 'normal', fillType: 'color' } };

  for (const [label, props] of [
    ['effect (stroke) group', { blendMode: 'pass-through', effects: [strokeFx] }],
    ['normal-blend group', { blendMode: 'normal' }],
    ['normal group at 80%', { blendMode: 'normal', opacity: 0.8 }],
  ] as const) {
    for (const o of [{ background: true, scale: 1 }, { background: false, scale: 1 }, { background: true, scale: 0.5 }]) {
      it(`${label}, background ${o.background}, scale ${o.scale}`, () => {
        invalidateRenderCache();
        const d = createDocument({ name: 'below', width: W, height: H, background: '#ffffff' });
        raster(d, [W, H, [90, 90, 160, 255]]);
        const g = group(d, props as Partial<Layer>);
        const photo = raster(d, canvasOf(50, 36, (x, y) => [32, 100 + 4 * y, 20 + 4 * x, 255]), {}, g.id);
        Object.assign(photo, at(photo, 10, 8));
        const lv = adjustment(d, 'rc-invert', g.id);
        expectFresh(d, 'initial', { ...o, below: lv.id });
        // A patch edit (brush / fill) on the photo, then the histogram's below-render again.
        const k = bitmaps.get(photo.bitmapId).getContext('2d')!;
        k.fillStyle = 'rgb(10,10,10)';
        k.fillRect(2, 2, 6, 6);
        bitmaps.touch(photo.bitmapId, { x: 2, y: 2, width: 6, height: 6 });
        const before = renderCacheInfo().docRegionRenders;
        expectFresh(d, 'after patch', { ...o, below: lv.id });
        // still the incremental path (not a full re-render)
        expect(renderCacheInfo().docRegionRenders).toBeGreaterThan(before);
        // the next call (cache hit) is right too
        expectFresh(d, 'cache hit', { ...o, below: lv.id });
      });
    }
  }
});

/* ------------------------------------------------------------------------------------------- */

function strokeFx(size: number, position: 'inside' | 'center' | 'outside'): LayerEffect {
  return { id: 'st', effectId: 'stroke', enabled: true, params: { size, position, color: '#00ff00', opacity: 1, blendMode: 'normal', fillType: 'color' } };
}

describe('stroke size edits on semi-transparent content (render-paint-diff-2)', () => {
  const W = 72;
  const H = 48;

  function scene(position: 'inside' | 'center', size: number) {
    const d = createDocument({ name: 'soft', width: W, height: H, background: '#ffffff' });
    // 70% red block and an 85% blue anti-aliased disc
    const c = canvasOf(56, 36, (x, y) => {
      const disc = Math.max(0, Math.min(1, 0.5 - (Math.hypot(x + 0.5 - 40, y + 0.5 - 18) - 11)));
      if (disc > 0) return [40, 60, 220, Math.round(disc * 0.85 * 255)];
      return x >= 4 && x < 30 && y >= 6 && y < 30 ? [220, 30, 30, 179] : [0, 0, 0, 0];
    });
    const l = raster(d, c, { effects: [strokeFx(size, position)] });
    Object.assign(l, at(l, 8, 6));
    return { d, l };
  }

  for (const position of ['inside', 'center'] as const) {
    it(`${position}: 14 → 2 (plain edits) and a 2 → 14 drag match fresh renders`, () => {
      invalidateRenderCache();
      const { d: d0, l } = scene(position, 14);
      expectFresh(d0, 'size 14');
      let d = edit(d0, l.id, { effects: [strokeFx(2, position)] });
      expectFresh(d, 'size 14 → 2');
      expectLiveFresh(d, 'size 14 → 2');
      // dragging the slider up: a new document per step (preview), every render cached
      for (let size = 3; size <= 14; size++) {
        d = edit(d, l.id, { effects: [strokeFx(size, position)] });
        renderDocumentLive(d);
        renderDocument(d);
      }
      expectFresh(d, 'drag 2 → 14');
      expectLiveFresh(d, 'drag 2 → 14');
      // and back down
      for (let size = 13; size >= 1; size--) {
        d = edit(d, l.id, { effects: [strokeFx(size, position)] });
        renderDocumentLive(d);
        renderDocument(d);
      }
      expectFresh(d, 'drag 14 → 1');
      expectLiveFresh(d, 'drag 14 → 1');
    });
  }
});

/* ------------------------------------------------------------------------------------------- */

describe('inside effects at the canvas edge (render-paint-diff-5)', () => {
  const W = 40;
  const H = 30;
  const bevel: LayerEffect = { id: 'bv', effectId: 'bevel', enabled: true, params: { style: 'inner', size: 5, depth: 1, soften: 0, angle: 120, altitude: 30 } };

  /** The layer (20×20, opaque, a soft column) at (x, y) on a doc of height h. */
  function scene(h: number, fx: LayerEffect, x: number, y: number) {
    const d = createDocument({ name: 'edge', width: W, height: h, background: '#ffffff' });
    const l = raster(d, canvasOf(20, 20, (u) => [48, 96, 192, u === 19 ? 128 : 255]), { effects: [fx] });
    Object.assign(l, at(l, x, y));
    return { d, l };
  }

  /** The top W×H of a canvas. */
  function crop(c: HTMLCanvasElement): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    out.getContext('2d')!.drawImage(c, 0, 0);
    return out;
  }

  for (const [name, fx] of [
    ['inside stroke', strokeFx(4, 'inside')],
    ['center stroke', strokeFx(4, 'center')],
    ['inner bevel', bevel],
  ] as const) {
    it(`${name}: a layer hanging off the canvas renders like the same layer on a taller canvas`, () => {
      invalidateRenderCache();
      // 8 px off the bottom edge, 6 px off the right edge
      const { d } = scene(H, fx, 26, 18);
      const tall = scene(H + 30, fx, 26, 18).d;
      const want = crop(renderDocument(tall));
      const r = diff(renderDocument(d), want);
      expect(r.n, `${name}: ${r.n} px off (max ${r.max}), first ${r.first}`).toBe(0);
    });

    it(`${name}: moving a layer across the canvas edge (translation reuse) matches a fresh render`, () => {
      invalidateRenderCache();
      const { d: d0, l } = scene(H, fx, 10, 4);
      renderDocumentLive(d0);
      renderDocument(d0);
      const hits = renderCacheInfo().translateHits;
      let d = d0;
      for (const y of [8, 12, 16, 18]) {
        d = edit(d, l.id, at(d.layers[l.id], 10, y));
        renderDocumentLive(d);
        expectFresh(d, `${name} moved to y=${y}`);
      }
      expectLiveFresh(d, `${name} moved`);
      // the moves reused the render (not re-rendered from scratch)
      expect(renderCacheInfo().translateHits).toBeGreaterThan(hits);
    });
  }
});

/* ------------------------------------------------------------------------------------------- */

describe('soft render-cache budget (render-paint-diff-3)', () => {
  it('keeps a working set larger than the budget while it is in use (no LRU thrash), up to the hard cap', () => {
    let t = 0;
    const c = new SlotCache(100, 2, { hardCap: 300, recentMs: 1500, trimMs: 2000, now: () => t });
    // A cyclic access pattern over 5 × 30 px (a frame re-compositing every layer): plain LRU with
    // a 100 px budget would miss every time.
    for (let k = 0; k < 5; k++) c.set(`L${k}`, 's', k, 30);
    let misses = 0;
    for (let frame = 0; frame < 20; frame++) {
      t += 16;
      for (let k = 0; k < 5; k++) {
        if (c.get(`L${k}`, 's') === undefined) {
          misses++;
          c.set(`L${k}`, 's', k, 30);
        }
      }
    }
    expect(misses).toBe(0);
    expect(c.pixels).toBe(150);
    // Past the hard cap the least recently used go, down to the cap.
    for (let k = 5; k < 12; k++) c.set(`L${k}`, 's', k, 30);
    expect(c.pixels).toBeLessThanOrEqual(300);
    expect(c.get('L11', 's')).toBe(11);
    expect(c.get('L0', 's')).toBeUndefined();
  });

  it('evicts slots outside the working set first, and shrinks back to the budget when idle', () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const c = new SlotCache(100, 2, { hardCap: 300, recentMs: 1500, trimMs: 2000, now: () => t });
      c.set('old', 's', 'old', 40);
      t += 5000;
      for (let k = 0; k < 3; k++) c.set(`L${k}`, 's', k, 30);
      // 'old' (unused for 5 s) made room; the recent ones stay although they exceed the budget
      expect(c.get('old', 's')).toBeUndefined();
      expect(c.pixels).toBe(90);
      for (let k = 3; k < 5; k++) c.set(`L${k}`, 's', k, 30);
      expect(c.pixels).toBe(150);
      // still busy: the idle trim waits
      t += 1000;
      c.get('L4', 's');
      vi.advanceTimersByTime(2000);
      t += 1000;
      expect(c.pixels).toBe(150);
      // idle for 2 s: back within the budget, least recently used first
      t += 2500;
      vi.advanceTimersByTime(5000);
      expect(c.pixels).toBeLessThanOrEqual(100);
      expect(c.get('L4', 's')).toBe(4);
      expect(c.get('L0', 's')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps what displayed documents need (keep-alive) through idle trims, bounded by the hard cap', () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const c = new SlotCache(100, 2, { hardCap: 200, recentMs: 1500, trimMs: 2000, now: () => t });
      const live = new Set(['a', 'b', 'c']);
      c.setKeepAlive((id, scale) => scale === '1.00000' && live.has(id));
      for (const id of ['a', 'b', 'c']) c.set(`L|${id}`, 's', id, 40, { layerId: id, scale: '1.00000' });
      c.set('L|a@0.5', 's', 'a-half', 40, { layerId: 'a', scale: '0.50000' });
      c.set('T|x', 's', 'thumb', 10, { layerId: 'x' });
      t += 10_000;
      vi.advanceTimersByTime(20_000);
      // only the kept-alive renders survive the idle trim
      expect(c.get('L|a@0.5', 's')).toBeUndefined();
      expect(c.get('T|x', 's')).toBeUndefined();
      for (const id of ['a', 'b', 'c']) expect(c.get(`L|${id}`, 's')).toBe(id);
      // the document is no longer displayed: its renders go at the next trim
      live.clear();
      t += 10_000;
      vi.advanceTimersByTime(20_000);
      expect(c.pixels).toBeLessThanOrEqual(100);
      // kept-alive slots never grow the cache past the hard cap
      live.add('d').add('e').add('f').add('g').add('h');
      for (const id of ['d', 'e', 'f', 'g', 'h']) c.set(`L|${id}`, 's', id, 60, { layerId: id, scale: '1.00000' });
      expect(c.pixels).toBeLessThanOrEqual(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every slot a render pass uses until the pass ends, however long it takes', () => {
    let t = 0;
    const c = new SlotCache(100, 2, { hardCap: 300, recentMs: 1500, trimMs: 2000, now: () => t });
    c.beginPass();
    // a slow first composite: 5 layer renders 1 s apart (the first ones are no longer "recent")
    for (let k = 0; k < 5; k++) {
      c.set(`L${k}`, 's', k, 30);
      t += 1000;
    }
    c.beginPass(); // nested composite joins the pass
    c.endPass();
    for (let k = 0; k < 5; k++) expect(c.get(`L${k}`, 's'), `L${k} during the pass`).toBe(k);
    c.endPass();
    // after the pass, an insert over budget evicts what is no longer in use
    t += 5000;
    c.set('X', 's', 'x', 30);
    expect(c.pixels).toBeLessThanOrEqual(100);
    expect(c.get('X', 's')).toBe('x');
  });

  it('device memory sets the hard cap', () => {
    expect(hardCapFor(64, undefined)).toBe(192);
    expect(hardCapFor(64, 2)).toBe(96);
    expect(hardCapFor(64, 4)).toBe(128);
    expect(hardCapFor(64, 8)).toBe(192);
  });

  it('painting over many full-canvas layers with effects never re-renders them once the working set exceeds the budget', () => {
    const W = 48;
    const H = 36;
    const budget = slots.budget;
    const cap = slots.hardCap;
    invalidateRenderCache();
    try {
      const d = createDocument({ name: 'thrash', width: W, height: H, background: '#ffffff' });
      raster(d, [W, H, [200, 200, 200, 255]]);
      const shadow: LayerEffect = { id: 'sh', effectId: 'stroke', enabled: true, params: { size: 3, position: 'outside', color: '#000000', opacity: 1, blendMode: 'normal', fillType: 'color' } };
      for (let k = 0; k < 6; k++) {
        raster(d, canvasOf(W, H, (x, y) => (Math.hypot(x - 8 - 6 * k, y - 18) < 6 ? [40 * k, 90, 200, 255] : [0, 0, 0, 0])), { effects: [shadow, strokeFx(2, 'inside')] });
      }
      const paint = raster(d, [W, H, [0, 0, 0, 0]], { effects: [strokeFx(2, 'outside')] });
      renderDocumentLive(d);
      // the working set is several times the budget: a plain LRU budget would thrash
      slots.budget = Math.ceil(slots.pixels / 4);
      slots.hardCap = slots.pixels * 4;
      let seq = renderDocumentLive(d).seq;
      const k2 = bitmaps.get(paint.bitmapId).getContext('2d')!;
      const others = otherLayerRenders(paint.id);
      try {
        for (let f = 0; f < 12; f++) {
          const x = 2 + f * 3;
          k2.fillStyle = 'rgb(250,0,0)';
          k2.fillRect(x, 10 + (f % 3) * 6, 3, 3);
          bitmaps.touch(paint.bitmapId, { x, y: 10 + (f % 3) * 6, width: 3, height: 3 });
          seq = renderDocumentLive(d, { since: seq }).seq;
        }
      } finally {
        others.stop();
      }
      // painted layer updated in place every frame; nothing else re-rendered
      expect(others.keys).toEqual([]);
      expectLiveFresh(d, 'after painting');
    } finally {
      slots.budget = budget;
      slots.hardCap = cap;
    }
  });

  /**
   * Past the hard cap (the layer renders alone do not fit): the brush frame composites the layers
   * below the painted one into the below cache once — their renders are the first evicted and never
   * needed again during the stroke — and the below cache / live state are never evicted to make
   * room for layer renders.
   */
  it('past the hard cap, painting re-renders no other layer after the first frame (graceful degradation)', () => {
    const W = 48;
    const H = 36;
    const budget = slots.budget;
    const cap = slots.hardCap;
    invalidateRenderCache();
    try {
      const d = createDocument({ name: 'pastcap', width: W, height: H, background: '#ffffff' });
      raster(d, [W, H, [200, 200, 200, 255]]);
      for (let k = 0; k < 8; k++) {
        // content covering the canvas (not croppable)
        raster(d, canvasOf(W, H, (x, y) => (Math.hypot(x - 6 - 5 * k, y - 18) < 14 ? [30 * k, 90, 200, 255] : [10, 10, 10, 40])), { effects: [strokeFx(2, 'outside'), strokeFx(1, 'inside')] });
      }
      const paint = raster(d, [W, H, [0, 0, 0, 0]]);
      renderDocumentLive(d);
      const all = slots.pixels;
      // budget and cap far below the layer renders (≈ 3 renders fit), then a full composite
      invalidateRenderCache();
      slots.budget = Math.ceil(all / 8);
      slots.hardCap = Math.ceil(all / 3);
      let seq = renderDocumentLive(d).seq;
      // full composite past the cap: some layer renders are cached, the others evicted
      const fxIds = d.rootIds.slice(1, -1);
      const missing = fxIds.filter((id) => !slots.values(`L|${id}|${(1).toFixed(5)}|emf`).length).length;
      expect(missing).toBeGreaterThan(0);
      expect(missing).toBeLessThan(fxIds.length);
      const k2 = bitmaps.get(paint.bitmapId).getContext('2d')!;
      const perFrame: number[] = [];
      const others = otherLayerRenders(paint.id);
      try {
        for (let f = 0; f < 12; f++) {
          const x = 2 + f * 3;
          const n0 = others.keys.length;
          k2.fillStyle = 'rgb(250,0,0)';
          k2.fillRect(x, 4 + (f % 4) * 8, 3, 3);
          bitmaps.touch(paint.bitmapId, { x, y: 4 + (f % 4) * 8, width: 3, height: 3 });
          seq = renderDocumentLive(d, { since: seq }).seq;
          perFrame.push(others.keys.length - n0);
          expect(slots.pixels, `frame ${f}: within the hard cap`).toBeLessThanOrEqual(slots.hardCap);
        }
      } finally {
        others.stop();
      }
      // the first frame re-renders the layers evicted before the stroke (filling the whole below
      // cache) — only those, once: the ones still cached are not evicted to make room — later frames none
      expect(perFrame[0], `re-renders per frame: ${perFrame}`).toBeLessThanOrEqual(missing);
      expect(perFrame.slice(1).every((n) => n === 0), `re-renders per frame: ${perFrame}`).toBe(true);
      expect(new Set(others.keys).size).toBe(others.keys.length);
      expectLiveFresh(d, 'after painting past the cap');
      expectFresh(d, 'export after painting past the cap');
    } finally {
      slots.budget = budget;
      slots.hardCap = cap;
    }
  });

  it('past the hard cap, layer renders are evicted before composites', () => {
    let t = 0;
    const c = new SlotCache(100, 2, { hardCap: 200, recentMs: 1500, trimMs: 2000, now: () => t });
    c.beginPass();
    c.set('SB|doc', 's', 'below', 60, { composite: true });
    for (let k = 0; k < 6; k++) c.set(`L${k}`, 's', k, 40);
    c.endPass();
    expect(c.pixels).toBeLessThanOrEqual(200);
    // the composite inserted first survived; the oldest layer renders went
    expect(c.get('SB|doc', 's')).toBe('below');
    expect(c.get('L5', 's')).toBe(5);
    expect(c.get('L0', 's')).toBeUndefined();
  });
});

/** Layer renders stored for layers other than `id` (re-renders), recorded until stop(). */
function otherLayerRenders(id: string): { keys: string[]; stop: () => void } {
  const keys: string[] = [];
  const orig = slots.set;
  slots.set = function (this: typeof slots, key: string, ...rest: unknown[]) {
    if (key.startsWith('L|') && !key.startsWith(`L|${id}|`)) keys.push(key);
    return (orig as (...a: unknown[]) => unknown).call(this, key, ...rest);
  } as typeof slots.set;
  return { keys, stop: () => void (slots.set = orig) };
}

/* ------------------------------------------------------------------------------------------- */

describe('moving a layer with smart filters (e2e-flows-3)', () => {
  const W = 64;
  const H = 48;
  // (the software test canvas has no CSS blur: a stroke stands in for the templates' glow)
  const glow = strokeFx(3, 'outside');

  /** A character-like layer (soft disc + stripes) with smart filters and an outline at (x, y). */
  function scene(filterIds: string[], x: number, y: number) {
    const d = createDocument({ name: 'move', width: W, height: H, background: '#ffffff' });
    raster(d, canvasOf(W, H, (u, v) => [30 + 3 * u, 60 + 2 * v, 140, 255]));
    const c = canvasOf(20, 24, (u, v) => {
      const a = Math.max(0, Math.min(1, 10.5 - Math.hypot(u + 0.5 - 10, v + 0.5 - 12)));
      return [180 + (u % 3) * 20, 40 + 7 * v, (u * 13) % 255, Math.round(a * 255)];
    });
    const fl: FilterInstance[] = filterIds.map((filterId, i) => ({ id: `f${i}`, filterId, enabled: true, params: {}, opacity: 1, blendMode: 'normal' }) as FilterInstance);
    const l = raster(d, c, { filters: fl, effects: [glow] });
    Object.assign(l, at(l, x, y));
    return { d, l };
  }

  const calls = (ids: string[]) => ids.reduce((n, id) => n + (applied[id] ?? 0), 0);

  for (const ids of [['rc-dither'], ['rc-box'], ['rc-dither', 'rc-box']]) {
    it(`[${ids}]: whole-pixel moves inside the canvas reuse the filtered render, exactly`, () => {
      invalidateRenderCache();
      const { d: d0, l } = scene(ids, 20, 10);
      renderDocumentLive(d0);
      expectFresh(d0, 'initial');
      const c0 = calls(ids);
      const hits = renderCacheInfo().translateHits;
      let d = d0;
      // A drag: a new document per pointermove (live composite), plus exact renders in between.
      for (const [x, y] of [
        [23, 10],
        [27, 12],
        [31, 15],
        [26, 9],
        [18, 14],
      ]) {
        d = edit(d, l.id, at(d.layers[l.id], x, y));
        renderDocumentLive(d);
        renderDocument(d);
      }
      // the smart filters never ran again (the fresh reference renders below run them)
      expect(calls(ids)).toBe(c0);
      expect(renderCacheInfo().translateHits).toBeGreaterThan(hits);
      expectFresh(d, 'moved');
      expectLiveFresh(d, 'moved');
      // a sub-pixel move changes the resampling: exact renders re-render, the live composite shows
      // the render shifted by the rounded delta until the settle
      const r0 = renderCacheInfo().layerRenders;
      d = edit(d, l.id, at(d.layers[l.id], 18.5, 14));
      renderDocumentLive(d);
      expect(renderCacheInfo().layerRenders).toBe(r0);
      expect(renderCacheInfo().settlePending).toBe(true);
      renderDocument(d);
      expect(renderCacheInfo().layerRenders).toBeGreaterThan(r0);
      expectFresh(d, 'sub-pixel');
      settleRenderCaches();
      expectLiveFresh(d, 'sub-pixel (settled)');
    });

    it(`[${ids}]: moves across the canvas edge stay exact (filters see the crop a fresh render sees)`, () => {
      invalidateRenderCache();
      const { d: d0, l } = scene(ids, 20, 10);
      renderDocumentLive(d0);
      renderDocument(d0);
      let d = d0;
      for (const [x, y] of [
        [20, 20],
        [20, 30],
        [20, 34],
        [-6, 34],
        [-9, 30],
        [50, 4],
        [52, -9],
        [30, 12],
      ]) {
        d = edit(d, l.id, at(d.layers[l.id], x, y));
        renderDocumentLive(d);
        expectFresh(d, `moved to ${x},${y}`);
      }
      settleRenderCaches();
      expectLiveFresh(d, 'moved across the edge (settled)');
    });
  }

  it('a doc-anchored filter: the viewport drags the shifted render (approximate), exports and the settled viewport are exact', () => {
    invalidateRenderCache();
    const ids = ['rc-anchored', 'rc-dither'];
    const { d: d0, l } = scene(ids, 20, 10);
    renderDocumentLive(d0);
    expectFresh(d0, 'initial');
    let d = d0;
    const c0 = calls(['rc-anchored']);
    for (const x of [22, 25, 29, 31]) {
      d = edit(d, l.id, at(d.layers[l.id], x, 13));
      renderDocumentLive(d);
    }
    // live composites (the viewport while dragging) never re-ran the doc-anchored filter…
    expect(calls(['rc-anchored'])).toBe(c0);
    expect(renderCacheInfo().settlePending).toBe(true);
    // …exact renders (export, thumbnails) do, and are right
    expectFresh(d, 'export after the drag');
    // the settle re-renders the viewport exactly
    expect(settleRenderCaches()).toBe(true);
    expectLiveFresh(d, 'settled');
  });

  it('a layer hanging off the canvas dragged back in: the viewport shifts it (approximate), exports re-render, the settle is exact', () => {
    invalidateRenderCache();
    const ids = ['rc-dither', 'rc-box'];
    // 10 px off the bottom edge: the render (and its margin) is cut by the canvas
    const { d: d0, l } = scene(ids, 20, 34);
    renderDocumentLive(d0);
    expectFresh(d0, 'initial');
    let d = d0;
    const r0 = renderCacheInfo().layerRenders;
    const c0 = calls(ids);
    for (const y of [33, 31, 30]) {
      d = edit(d, l.id, at(d.layers[l.id], 20, y));
      renderDocumentLive(d);
    }
    // dragging up brings content of the cut margin back: the live composite still shifts the render
    expect(renderCacheInfo().layerRenders).toBe(r0);
    expect(calls(ids)).toBe(c0);
    expect(renderCacheInfo().settlePending).toBe(true);
    expectFresh(d, 'export after the drag');
    expect(settleRenderCaches()).toBe(true);
    expectLiveFresh(d, 'settled');
    // moved in so far that visible content is missing: re-rendered (exactly) even while dragging
    d = edit(d, l.id, at(d.layers[l.id], 20, 4));
    renderDocumentLive(d);
    expectLiveFresh(d, 'dragged far up');
  });

  it('on GPU canvases a larger shifted region is exact only with CPU-exact effects (blurs differ by canvas size)', () => {
    const shadow: LayerEffect = { id: 'ds', effectId: 'drop-shadow', enabled: true, params: { distance: 3, size: 0, spread: 0, opacity: 0.6, angle: 90, color: '#000000', blendMode: 'normal' } };
    try {
      for (const [label, effects, gpuExact] of [
        ['stroke', [strokeFx(3, 'outside')], true],
        ['drop shadow', [shadow], false],
      ] as const) {
        for (const cropExact of [true, false]) {
          setCropExactBackend(cropExact);
          invalidateRenderCache();
          const d0 = createDocument({ name: 'gpu', width: W, height: H, background: '#ffffff' });
          const l = raster(d0, canvasOf(20, 20, () => [200, 60, 60, 255]), { effects: [...effects] });
          Object.assign(l, at(l, 20, 10));
          renderDocument(d0);
          // across the bottom edge: the shifted base region is larger than a fresh render's
          const d1 = edit(d0, l.id, at(d0.layers[l.id], 20, 40));
          const r0 = renderCacheInfo().layerRenders;
          renderDocument(d1);
          const reRendered = renderCacheInfo().layerRenders > r0;
          expect(reRendered, `${label}, crop-exact ${cropExact}`).toBe(!cropExact && !gpuExact);
          expectFresh(d1, `${label}, crop-exact ${cropExact}`);
        }
      }
    } finally {
      setCropExactBackend(true);
    }
  });

  it('editing the filters of a moved layer is not served from the shifted render', () => {
    invalidateRenderCache();
    const { d: d0, l } = scene(['rc-dither'], 20, 10);
    renderDocumentLive(d0);
    renderDocument(d0);
    let d = edit(d0, l.id, at(d0.layers[l.id], 24, 12));
    renderDocumentLive(d);
    renderDocument(d);
    const fl = [...(d.layers[l.id].filters ?? []), { id: 'fb', filterId: 'rc-box', enabled: true, params: {}, opacity: 1, blendMode: 'normal' } as FilterInstance];
    d = edit(d, l.id, { filters: fl });
    renderDocumentLive(d);
    expectFresh(d, 'filter added after a move');
    expectLiveFresh(d, 'filter added after a move');
    d = edit(d, l.id, at(d.layers[l.id], 28, 12));
    renderDocumentLive(d);
    d = edit(d, l.id, { filters: fl.map((f) => ({ ...f, enabled: f.filterId !== 'rc-dither' })) });
    renderDocumentLive(d);
    expectFresh(d, 'filter disabled after a move');
    expectLiveFresh(d, 'filter disabled after a move');
  });
});

/* ------------------------------------------------------------------------------------------- */

describe('renders of layers with effects are cropped to their content (render-paint-diff-3)', () => {
  const W = 320;
  const H = 256;
  const fxList = (): LayerEffect[] => [strokeFx(3, 'outside'), { ...strokeFx(2, 'inside'), id: 'st2', params: { ...strokeFx(2, 'inside').params, color: '#ff00ff' } }];
  const disc = (cx: number, cy: number, r: number) => (x: number, y: number): RGBA => {
    const a = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
    return a > 0 ? [220, 120, 40, Math.round(a * 255)] : [0, 0, 0, 0];
  };

  /** A document-sized layer (Layer ▸ New Layer) holding a small soft disc, with an outline. */
  function scene() {
    const d = createDocument({ name: 'crop', width: W, height: H, background: '#ffffff' });
    raster(d, canvasOf(W, H, (x, y) => [40 + ((x * 3) % 160), 90 + ((y * 5) % 120), 150, 255]));
    const l = raster(d, canvasOf(W, H, disc(70, 80, 12)), { effects: fxList() });
    return { d, l };
  }

  /** The cached full-scale render of a layer (its canvases are region-sized). */
  const cachedRender = (id: string) => slots.values<{ region: { w: number; h: number } } | null>(`L|${id}|${(1).toFixed(5)}|emf`)[0];

  it('a small blob on a document-sized layer holds a crop, and renders like the same blob on a small layer', () => {
    invalidateRenderCache();
    const { d, l } = scene();
    const got = renderDocument(d);
    // its canvases cover the crop (the disc + slack + outline), not the document
    const R = cachedRender(l.id);
    expect(R).toBeTruthy();
    expect(R!.region.w * R!.region.h).toBeLessThan(0.5 * W * H);
    // reference: the same disc on a 40×40 layer at (50, 60)
    const ref = createDocument({ name: 'crop-ref', width: W, height: H, background: '#ffffff' });
    raster(ref, canvasOf(W, H, (x, y) => [40 + ((x * 3) % 160), 90 + ((y * 5) % 120), 150, 255]));
    const small = raster(ref, canvasOf(40, 40, (x, y) => disc(20, 20, 12)(x, y)), { effects: fxList() });
    Object.assign(small, at(small, 50, 60));
    const r = diff(got, renderDocument(ref));
    expect(r.n, `cropped vs small layer: ${r.n} px off (max ${r.max}), first ${r.first}`).toBe(0);
  });

  it('painting near the content updates the crop in place; painting far outside it renders a larger crop (live and export exact)', () => {
    invalidateRenderCache();
    const { d, l } = scene();
    let seq = renderDocumentLive(d).seq;
    renderDocument(d);
    const k = bitmaps.get(l.bitmapId).getContext('2d')!;
    let rebuilt = 0;
    let updates = 0;
    // a stroke from the disc outwards to the far corner
    for (let f = 0; f < 14; f++) {
      const x = 74 + f * 16;
      const y = 84 + f * 11;
      k.fillStyle = 'rgba(30,200,90,0.8)';
      k.fillRect(x, y, 6, 6);
      bitmaps.touch(l.bitmapId, { x, y, width: 6, height: 6 });
      const i0 = renderCacheInfo();
      seq = renderDocumentLive(d, { since: seq }).seq;
      rebuilt += renderCacheInfo().layerRenders - i0.layerRenders;
      updates += renderCacheInfo().regionUpdates - i0.regionUpdates;
      if (f % 3 === 0) {
        expectLiveFresh(d, `stroke frame ${f}`);
        expectFresh(d, `stroke frame ${f}`);
      }
    }
    expectLiveFresh(d, 'after the stroke');
    expectFresh(d, 'after the stroke');
    // most frames updated the render in place; leaving the crop re-rendered it a few times only
    expect(updates).toBeGreaterThan(rebuilt);
    expect(rebuilt).toBeGreaterThan(0);
    expect(rebuilt).toBeLessThan(5);
    // erase the disc: the crop stays (conservative bounds), the render stays exact
    k.clearRect(50, 60, 40, 40);
    bitmaps.touch(l.bitmapId, { x: 50, y: 60, width: 40, height: 40 });
    renderDocumentLive(d, { since: seq });
    expectLiveFresh(d, 'after erasing');
    expectFresh(d, 'after erasing');
  });

  it('painting the layer mask outside the crop updates the render in place (no rebuild), exactly', () => {
    invalidateRenderCache();
    const { d: d0, l } = scene();
    const maskId = bitmaps.add(canvasOf(W, H, () => [255, 255, 255, 255]));
    const d = edit(d0, l.id, { mask: { bitmapId: maskId, enabled: true, density: 1, feather: 0, inverted: false } } as Partial<Layer>);
    let seq = renderDocumentLive(d).seq;
    renderDocument(d);
    const k = bitmaps.get(maskId).getContext('2d')!;
    let rebuilt = 0;
    for (const [x, y] of [
      [250, 200],
      [270, 210],
      [64, 76],
    ]) {
      k.fillStyle = '#000000';
      k.fillRect(x, y, 8, 8);
      bitmaps.touch(maskId, { x, y, width: 8, height: 8 });
      const i0 = renderCacheInfo();
      seq = renderDocumentLive(d, { since: seq }).seq;
      rebuilt += renderCacheInfo().layerRenders - i0.layerRenders;
      expectLiveFresh(d, `mask dab at ${x},${y}`);
      expectFresh(d, `mask dab at ${x},${y}`);
    }
    expect(rebuilt).toBe(0);
  });

  it('a change of unknown extent rescans the bitmap; renders stay exact', () => {
    invalidateRenderCache();
    const { d, l } = scene();
    renderDocumentLive(d);
    const scans = boundsStats.scans;
    const k = bitmaps.get(l.bitmapId).getContext('2d')!;
    k.fillStyle = '#2040ff';
    k.fillRect(250, 200, 30, 20);
    bitmaps.touch(l.bitmapId);
    renderDocumentLive(d);
    expect(boundsStats.scans).toBe(scans + 1);
    expectLiveFresh(d, 'after a full touch');
    expectFresh(d, 'after a full touch');
  });

  it('moving a cropped layer reuses its render (translation), exactly', () => {
    invalidateRenderCache();
    const { d: d0, l } = scene();
    renderDocumentLive(d0);
    renderDocument(d0);
    const hits = renderCacheInfo().translateHits;
    let d = d0;
    for (const [x, y] of [
      [7, 3],
      [19, 11],
      [33, 20],
      [-40, 30],
    ]) {
      d = edit(d, l.id, at(d.layers[l.id], x, y));
      renderDocumentLive(d);
      expectFresh(d, `moved to ${x},${y}`);
    }
    expectLiveFresh(d, 'moved');
    expect(renderCacheInfo().translateHits).toBeGreaterThan(hits);
  });

  it('an empty layer with effects draws nothing until painted, then holds a small crop', () => {
    invalidateRenderCache();
    const d = createDocument({ name: 'empty', width: W, height: H, background: '#ffffff' });
    raster(d, [W, H, [128, 128, 128, 255]]);
    const l = raster(d, [W, H, [0, 0, 0, 0]], { effects: fxList() });
    let seq = renderDocumentLive(d).seq;
    expect(cachedRender(l.id)).toBeNull();
    const k = bitmaps.get(l.bitmapId).getContext('2d')!;
    for (let f = 0; f < 6; f++) {
      k.fillStyle = '#d02020';
      k.fillRect(100 + f * 4, 120, 5, 5);
      bitmaps.touch(l.bitmapId, { x: 100 + f * 4, y: 120, width: 5, height: 5 });
      seq = renderDocumentLive(d, { since: seq }).seq;
    }
    const R = cachedRender(l.id);
    expect(R!.region.w * R!.region.h).toBeLessThan(0.5 * W * H);
    expectLiveFresh(d, 'painted empty layer');
    expectFresh(d, 'painted empty layer');
  });
});
