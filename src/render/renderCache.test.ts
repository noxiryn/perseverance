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
import { invalidateRenderCache, renderCacheInfo, renderDocument, renderDocumentLive } from './compositor';
import { setCropExactBackend } from './backendProbe';
import { SlotCache, hardCapFor, slots } from './cache';
import { registerEffects } from './effects';

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

afterAll(() => {
  invalidateRenderCache();
  filters.unregister('rc-invert');
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

  it('device memory sets the hard cap', () => {
    expect(hardCapFor(64, undefined)).toBe(192);
    expect(hardCapFor(64, 2)).toBe(96);
    expect(hardCapFor(64, 4)).toBe(160);
    expect(hardCapFor(64, 8)).toBe(256);
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
      const renders0 = renderCacheInfo().layerRenders;
      for (let f = 0; f < 12; f++) {
        const x = 2 + f * 3;
        k2.fillStyle = 'rgb(250,0,0)';
        k2.fillRect(x, 10 + (f % 3) * 6, 3, 3);
        bitmaps.touch(paint.bitmapId, { x, y: 10 + (f % 3) * 6, width: 3, height: 3 });
        seq = renderDocumentLive(d, { since: seq }).seq;
      }
      // painted layer updated in place every frame; nothing else re-rendered
      expect(renderCacheInfo().layerRenders - renders0).toBe(0);
      expectLiveFresh(d, 'after painting');
    } finally {
      slots.budget = budget;
      slots.hardCap = cap;
    }
  });
});
