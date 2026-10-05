/**
 * Compositor — renders a Document to canvases.
 *
 * THIS FILE IS THE CONTRACT used across the app (signatures are stable). The implementation lives
 * in ./engine.ts (layer pipeline, groups, clipping, adjustments, caching), ./text.ts (layout +
 * warp), ./shapes.ts, ./paint.ts (gradients/patterns), ./mask.ts and ./effects/* (layer styles).
 *
 * Returned canvases:
 *  - renderDocument / renderThumbnail return CACHED canvases: treat them as read-only (copy before
 *    drawing on them).
 *  - renderLayerToDoc / renderLayerContent / rasterizeLayer return fresh canvases you may keep.
 */
import type { Document, ID, Layer, Paint, Rect, Size, TextProps, TransformableLayer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d } from '../core/canvas';
import { transformedBounds } from '../core/geometry';
import { applyFilterStack, makeFilterContext } from '../filters/engine';
import { VOLATILE_ASSETS, bumpGeneration, px, renderCache, slots } from './cache';
import {
  compositeDocument,
  compositeDocumentLive,
  dropLiveComposites,
  effectsSidesOf,
  filterPad,
  flattenRender,
  geometrySig,
  lastLayerText,
  layerGeometry,
  layerSig,
  makeRC,
  onSettle,
  renderLayer,
  renderStats,
  settleApproximations,
  settlePending,
  type RC,
} from './engine';
import { maskValue } from './mask';
import { cropExactBackend, scheduleBackendProbe } from './backendProbe';
import { fillWithPaint as paintFill } from './paint';
import { renderShapeContent } from './shapes';
import { invalidateTextLayout, layoutTextProps, renderTextContent, requestTextFont, resetTextCaches, type LocalContent, type TextLayout } from './text';
import { clearPool, fresh } from './surface';

export type { TextLayout, TextLayoutLine, CaretInfo } from './text';
export { caretAt, caretPositions, indexAtPoint, selectionRects, fontString, textLocalBounds, invalidateTextLayout } from './text';
export { shapePath, shapeFillRule, shapeLocalBounds } from './shapes';
export { createGradient, paintStyle, assetImage } from './paint';
export { gradientGeometry } from './gradientMath';
export { renderStats } from './engine';

export interface RenderOptions {
  /** Output scale relative to document pixels (default 1). */
  scale?: number;
  /** Paint doc.background under the layers (default true). */
  background?: boolean;
  /** Layers to skip (e.g. the layer being edited by the text tool). */
  hidden?: Set<ID>;
  /** Render only layers strictly below this layer id (in global stacking order). */
  below?: ID;
}

/**
 * Composite the whole document. Returns a canvas of size (doc.width*scale, doc.height*scale).
 * The canvas is cached and shared: do not draw on it.
 */
export function renderDocument(doc: Document, opts: RenderOptions = {}): HTMLCanvasElement {
  return compositeDocument(doc, {
    scale: opts.scale ?? 1,
    background: opts.background !== false,
    hidden: opts.hidden ?? null,
    below: opts.below ?? null,
  });
}

/** Result of renderDocumentLive. */
export interface LiveRender {
  /** Live composite canvas: owned by the renderer and updated IN PLACE by later calls. */
  canvas: HTMLCanvasElement;
  /**
   * Area (output px = doc px × scale) that changed since the caller's previous result
   * (`opts.since`; without it: since the previous call for the same document/options): an empty
   * rect (width 0) when nothing changed, null when the whole canvas must be considered new
   * (first call, structure change, large change…).
   */
  dirty: Rect | null;
  /** Whether any pixel may have changed. */
  changed: boolean;
  /** Content version of the canvas: pass it as `opts.since` next time. */
  seq: number;
}

export interface LiveRenderOptions extends RenderOptions {
  /** `seq` of the caller's previous result: `dirty` then covers every change made since. */
  since?: number;
}

/**
 * Live document composite for continuous display (the viewport). Unlike renderDocument, the
 * returned canvas is updated in place: when only part of the document changed — e.g. a brush
 * frame touched a few hundred pixels of one layer (`bitmaps.touch(id, rect)`) — only that area
 * is re-composited (the layers below the painted one come from a cache, adjustments above it run
 * over the area only) and reported as `dirty`, so the caller can redraw just that part.
 * Do not keep the canvas expecting it to stay unchanged (copy it, or use renderDocument).
 * Work that is only approximate on GPU canvases is re-rendered exactly shortly after painting
 * stops: subscribe with onRenderSettle to redraw then.
 */
export function renderDocumentLive(doc: Document, opts: LiveRenderOptions = {}): LiveRender {
  const r = compositeDocumentLive(
    doc,
    {
      scale: opts.scale ?? 1,
      background: opts.background !== false,
      hidden: opts.hidden ?? null,
      below: opts.below ?? null,
    },
    opts.since,
  );
  return { canvas: r.canvas, changed: r.changed, seq: r.seq, dirty: r.dirty ? { x: r.dirty.x, y: r.dirty.y, width: r.dirty.w, height: r.dirty.h } : null };
}

/**
 * Called after approximate incremental work of LIVE composites (renderDocumentLive on GPU
 * canvases: blurs / resampling of crops during live painting) was dropped, so the next live
 * render re-composites that area exactly: displays should re-render. Returns the unsubscriber.
 * Every other render (renderDocument, renderLayerToDoc, thumbnails…) is always exact.
 */
export function onRenderSettle(fn: () => void): () => void {
  return onSettle(fn);
}

/**
 * Settle approximate live-composite work now instead of after the idle delay (tests). Returns
 * whether anything was approximate. Not needed before exports: renderDocument is always exact.
 */
export function settleRenderCaches(): boolean {
  return settleApproximations();
}

/**
 * Whether this canvas backend draws crops / clipped regions exactly like whole surfaces (the
 * software canvas does, GPU canvases usually not). Probed once at idle time (false until then);
 * call early to schedule the probe. Partial redraws are exact when true.
 */
export function canvasCropExact(): boolean {
  return cropExactBackend();
}

/** Schedule the canvas backend probe (see canvasCropExact) for the next idle time. */
export function probeCanvasBackend(): void {
  scheduleBackendProbe();
}

/**
 * Render one layer (content + smart filters + effects + mask, NOT opacity/blend) into a
 * doc-sized (× scale) canvas. Groups render their children composited. Null if nothing to draw.
 */
export function renderLayerToDoc(
  doc: Document,
  layer: Layer,
  opts: { scale?: number; effects?: boolean; mask?: boolean } = {},
): HTMLCanvasElement | null {
  const rc = makeRC(doc, opts.scale ?? 1);
  const R = renderLayer(rc, layer, { effects: opts.effects !== false, mask: opts.mask !== false, filters: true });
  if (!R) return null;
  return flattenRender(rc, R);
}

function drawLocalAt(ctx: CanvasRenderingContext2D, lc: LocalContent) {
  ctx.save();
  ctx.setTransform(1 / lc.k, 0, 0, 1 / lc.k, lc.ox, lc.oy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(lc.canvas, 0, 0);
  ctx.restore();
}

/**
 * Render a transformable layer's local content (bitmap / rasterized text / rasterized shape)
 * with smart filters applied, in its local box. Size equals getLayerSize(layer).
 */
export function renderLayerContent(doc: Document, layer: TransformableLayer): HTMLCanvasElement {
  const size = getLayerSize(layer);
  let out = createCanvas(Math.max(1, Math.round(size.width)), Math.max(1, Math.round(size.height)));
  const ctx = ctx2d(out);
  if (layer.type === 'raster') {
    const bmp = bitmaps.tryGet(layer.bitmapId);
    if (bmp) ctx.drawImage(bmp, 0, 0);
  } else if (layer.type === 'text') {
    drawLocalAt(ctx, renderTextContent(layer.text, 1, 0, 0));
  } else {
    drawLocalAt(ctx, renderShapeContent(layer.shape, 1, 0, 0));
  }
  if (layer.filters?.some((f) => f.enabled)) {
    out = applyFilterStack(out, layer.filters, makeFilterContext({ docWidth: doc.width, docHeight: doc.height, offsetX: layer.transform.x, offsetY: layer.transform.y, scale: 1 }));
  }
  return out;
}

/** Local content box size of a transformable layer (text is measured). */
export function getLayerSize(layer: TransformableLayer): Size {
  if (layer.type === 'raster') return { width: layer.width, height: layer.height };
  if (layer.type === 'shape') return { width: Math.max(1, layer.shape.width), height: Math.max(1, layer.shape.height) };
  const l = layoutTextProps(layer.text);
  return { width: l.width, height: l.height };
}

/**
 * Measure/lay out text (wrapping when boxWidth is set). Exactly the layout the renderer draws:
 * lines carry x/y/width/baseline and their [start, end) range in the (case-transformed) content.
 * See caretAt / caretPositions / indexAtPoint / selectionRects for caret math.
 */
export function measureText(text: TextProps): TextLayout {
  requestTextFont(text);
  return layoutTextProps(text);
}

function unionR(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Doc-space bounds of a layer's content (transformed box; groups = union; fills = canvas). */
export function getLayerBounds(doc: Document, layerId: ID): Rect | null {
  const l = doc.layers[layerId];
  if (!l) return null;
  if (l.type === 'raster' || l.type === 'text' || l.type === 'shape') {
    const s = getLayerSize(l);
    return transformedBounds(l.transform, s.width, s.height);
  }
  if (l.type === 'group') {
    // Hidden children draw nothing: they must not enlarge the group's box / selection outline.
    let r: Rect | null = null;
    for (const c of l.childIds) {
      const cl = doc.layers[c];
      if (!cl || !cl.visible || cl.type === 'adjustment') continue;
      r = unionR(r, getLayerBounds(doc, c));
    }
    return r;
  }
  return { x: 0, y: 0, width: doc.width, height: doc.height };
}

/**
 * Doc-space bounds of everything a layer can draw: content including text/stroke/warp overflow,
 * smart-filter growth and layer effects (shadows, glows, strokes). Null for adjustment layers.
 */
export function getLayerVisualBounds(doc: Document, layerId: ID): Rect | null {
  const l = doc.layers[layerId];
  if (!l || l.type === 'adjustment') return null;
  const fpad = filterPad(l.filters, 1);
  const sides = effectsSidesOf(l, 1);
  let r: Rect | null = null;
  const geom = layerGeometry(l, 1);
  if (geom) {
    const pts = [
      geom.m.transformPoint({ x: geom.local.x, y: geom.local.y }),
      geom.m.transformPoint({ x: geom.local.x + geom.local.width, y: geom.local.y }),
      geom.m.transformPoint({ x: geom.local.x + geom.local.width, y: geom.local.y + geom.local.height }),
      geom.m.transformPoint({ x: geom.local.x, y: geom.local.y + geom.local.height }),
    ];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    r = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  } else if (l.type === 'fill') {
    r = { x: 0, y: 0, width: doc.width, height: doc.height };
  } else if (l.type === 'group') {
    for (const c of l.childIds) {
      const cl = doc.layers[c];
      if (cl && cl.visible) r = unionR(r, getLayerVisualBounds(doc, c));
    }
  }
  if (!r) return null;
  const gl = sides.l + fpad;
  const gt = sides.t + fpad;
  return { x: r.x - gl, y: r.y - gt, width: r.width + gl + sides.r + fpad, height: r.height + gt + sides.b + fpad };
}

function alphaAt(c: HTMLCanvasElement | null, x: number, y: number): number {
  if (!c || x < 0 || y < 0 || x >= c.width || y >= c.height) return 0;
  try {
    return ctx2d(c).getImageData(x, y, 1, 1).data[3];
  } catch {
    return 0;
  }
}

/** Rendered alpha (0..255) of a layer at a doc point (content + effects, mask applied). */
function sampleLayer(rc: RC, l: Layer, x: number, y: number, shapeOnly = false): number {
  const R = renderLayer(rc, l);
  if (!R) return 0;
  const lx = Math.floor(x * rc.s) - R.region.x;
  const ly = Math.floor(y * rc.s) - R.region.y;
  if (lx < 0 || ly < 0 || lx >= R.region.w || ly >= R.region.h) return 0;
  if (shapeOnly) return alphaAt(R.shape, lx, ly);
  let a = alphaAt(R.core, lx, ly);
  if (a > 10) return a;
  for (const b of R.behind) a = Math.max(a, alphaAt(b.canvas, lx, ly));
  return a;
}

/** Visibility (0..255) of an enabled layer mask at a doc point (feather ignored). */
function maskVisibilityAt(doc: Document, l: Layer, x: number, y: number): number {
  const m = l.mask;
  if (!m || !m.enabled) return 255;
  const bmp = bitmaps.tryGet(m.bitmapId);
  if (!bmp) return 255;
  const mx = Math.min(bmp.width - 1, Math.max(0, Math.floor((x * bmp.width) / doc.width)));
  const my = Math.min(bmp.height - 1, Math.max(0, Math.floor((y * bmp.height) / doc.height)));
  let lum = 255;
  try {
    const d = ctx2d(bmp).getImageData(mx, my, 1, 1).data;
    lum = (d[0] * d[3]) / 255;
  } catch {
    return 255;
  }
  return maskValue(lum, !!m.inverted, Number.isFinite(m.density) ? m.density : 1);
}

/** Base layer of a clipped layer at index i in a sibling list (null when none). */
function clipBaseOf(doc: Document, ids: ID[], i: number): Layer | null {
  let k = i - 1;
  while (k >= 0 && doc.layers[ids[k]]?.clipped) k--;
  const base = k >= 0 ? doc.layers[ids[k]] : undefined;
  return base && base.type !== 'adjustment' ? base : null;
}

/**
 * Topmost visible leaf layer (descending into visible groups; skipping fill/adjustment and fully
 * locked layers) whose rendered alpha at doc (x, y) exceeds ~10/255. Layers hidden at the point
 * by an ancestor group (its mask, 0% opacity/fill, an isolated group's own result, or the base of
 * a clipped group) are skipped.
 */
export function hitTestLayer(doc: Document, x: number, y: number): ID | null {
  if (!(x >= 0 && y >= 0 && x < doc.width && y < doc.height)) return null;
  const rc = makeRC(doc, 1);
  const clipOk = (ids: ID[], i: number, l: Layer): boolean => {
    if (!l.clipped) return true;
    const base = clipBaseOf(doc, ids, i);
    if (!base) return true;
    return base.visible && sampleLayer(rc, base, x, y, true) > 10;
  };
  const visit = (ids: ID[]): ID | null => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const l = doc.layers[ids[i]];
      if (!l || !l.visible) continue;
      if (l.type === 'group') {
        // Everything inside a fully locked group is locked too.
        if (l.locks?.all) continue;
        const a = Math.max(0, Math.min(1, l.opacity)) * Math.max(0, Math.min(1, Number.isFinite(l.fillOpacity) ? l.fillOpacity : 1));
        if (a <= 0.02) continue;
        if (maskVisibilityAt(doc, l, x, y) <= 10) continue;
        if (!clipOk(ids, i, l)) continue;
        // An isolated group (blend mode, effects or smart filters) shows exactly its own render:
        // nothing inside is visible where that render is clear.
        const isolated = l.blendMode !== 'pass-through' || !!l.effects?.some((e) => e.enabled) || !!l.filters?.some((f) => f.enabled);
        if (isolated && sampleLayer(rc, l, x, y) <= 10) continue;
        const r = visit(l.childIds);
        if (r) return r;
        continue;
      }
      if (l.type === 'fill' || l.type === 'adjustment' || l.locks?.all) continue;
      if (!(l.opacity > 0.02)) continue;
      const vb = getLayerVisualBounds(doc, l.id);
      if (!vb || x < vb.x || y < vb.y || x > vb.x + vb.width || y > vb.y + vb.height) continue;
      if (sampleLayer(rc, l, x, y) <= 10) continue;
      if (!clipOk(ids, i, l)) continue;
      return l.id;
    }
    return null;
  };
  return visit(doc.rootIds);
}

/** Rasterize any layer into a doc-sized canvas (content + filters + effects + mask). */
export function rasterizeLayer(doc: Document, layerId: ID): HTMLCanvasElement | null {
  const l = doc.layers[layerId];
  return l ? renderLayerToDoc(doc, l) : null;
}

/**
 * Small thumbnail of a layer (or the whole doc when layerId is null) fitting size×size.
 * Layer thumbnails show the content with smart filters (no effects, no mask — like Photoshop).
 * Cached per layer version; the canvas is shared: do not draw on it.
 */
export function renderThumbnail(doc: Document, layerId: ID | null, size: number): HTMLCanvasElement {
  const s = Math.max(1e-4, Math.min(size / doc.width, size / doc.height));
  if (!layerId) return renderDocument(doc, { scale: s });
  const l = doc.layers[layerId];
  const rc = makeRC(doc, s);
  if (!l) return fresh(rc.W, rc.H);
  const key = `T|${layerId}|${Math.round(size)}`;
  const sig = `${layerSig(rc, l)}|${geometrySig(rc)}`;
  const hit = slots.get<HTMLCanvasElement>(key, sig);
  if (hit) return hit;
  const out = fresh(rc.W, rc.H);
  if (l.type !== 'adjustment') {
    const R = renderLayer(rc, l, { effects: false, mask: false, filters: true });
    if (R?.shape) ctx2d(out).drawImage(R.shape, R.region.x, R.region.y);
  }
  slots.set(key, sig, out, px(out), { layerId, max: 1 });
  return out;
}

/** Grayscale thumbnail of a layer's mask fitting size×size (null when the layer has no mask). */
export function renderMaskThumbnail(doc: Document, layerId: ID, size: number): HTMLCanvasElement | null {
  const l = doc.layers[layerId];
  const bmp = l?.mask ? bitmaps.tryGet(l.mask.bitmapId) : null;
  if (!l?.mask || !bmp) return null;
  const s = Math.max(1e-4, Math.min(size / doc.width, size / doc.height));
  const W = Math.max(1, Math.round(doc.width * s));
  const H = Math.max(1, Math.round(doc.height * s));
  const key = `MT|${layerId}|${Math.round(size)}`;
  const sig = `${l.mask.bitmapId}|${bitmaps.version(l.mask.bitmapId)}|${W}x${H}`;
  const hit = slots.get<HTMLCanvasElement>(key, sig);
  if (hit) return hit;
  const out = fresh(W, H);
  const ctx = ctx2d(out);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, W, H);
  slots.set(key, sig, out, px(out), { layerId, max: 1 });
  return out;
}

/** Fill a rect with a Paint (solid/gradient/pattern) in the given context's current transform. */
export function fillWithPaint(ctx: CanvasRenderingContext2D, paint: Paint, box: Rect, path?: Path2D) {
  paintFill(ctx, paint, box, path);
}

/**
 * Drop cached renders (all, or for one layer — composites are always dropped). For a text
 * layer the cached layout and rasters of its text go too (e.g. after a font slice loaded).
 */
export function invalidateRenderCache(layerId?: ID) {
  // Live composites only track signatures: an invalidation (same signatures, new pixels) must
  // rebuild them like the cached composites.
  dropLiveComposites();
  if (layerId !== undefined) {
    const t = lastLayerText(layerId);
    if (t) invalidateTextLayout(t);
    slots.clear(layerId);
    return;
  }
  slots.clear();
  // Procedural asset tiles are pure functions of (definition, size, params) and stay cached;
  // user-image assets may have been generated before their image decoded, so they go.
  renderCache.clear(VOLATILE_ASSETS);
  resetTextCaches();
  clearPool();
  bumpGeneration();
}

/** Cache statistics (debugging / performance checks). */
export function renderCacheInfo() {
  return { slots: slots.size, slotPixels: slots.pixels, assets: renderCache.size, assetPixels: renderCache.pixels, settlePending: settlePending(), cropExact: cropExactBackend(), ...renderStats };
}
