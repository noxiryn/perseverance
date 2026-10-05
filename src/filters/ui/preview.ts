/** In-dialog preview helpers: fitted/cropped source images and running a filter on a copy. */
import type { Layer, ParamValues, Rect } from '../../core/types';
import { createCanvas, ctxRead } from '../../core/canvas';
import type { FilterContext, FilterDef } from '../../registry';
import { resolveParams, runFilter } from '../engine';
import { getLayerBounds, renderLayerToDoc } from '../../render/compositor';
import type { FilterTarget } from './apply';

/** Downscale a canvas to fit maxW×maxH (never upscales). Returns the pixels and the factor. */
export function fitImage(src: HTMLCanvasElement, maxW: number, maxH: number): { img: ImageData; k: number } {
  const k = Math.min(1, maxW / Math.max(1, src.width), maxH / Math.max(1, src.height));
  const w = Math.max(1, Math.round(src.width * k)),
    h = Math.max(1, Math.round(src.height * k));
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  if (k < 1) {
    // step down in halves for big reductions (cleaner than one huge bilinear step)
    let cur: HTMLCanvasElement = src;
    while (cur.width * 0.5 > w * 1.01 && cur.height * 0.5 > h * 1.01) {
      const half = createCanvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
      const hc = ctxRead(half);
      hc.imageSmoothingQuality = 'high';
      hc.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, w, h);
  } else ctx.drawImage(src, 0, 0);
  return { img: ctx.getImageData(0, 0, w, h), k: w / Math.max(1, src.width) };
}

/** Pixels of a rect of a canvas (clamped to its bounds). */
export function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): ImageData {
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  ctx.drawImage(src, -x, -y);
  return ctx.getImageData(0, 0, w, h);
}

export function cloneImage(img: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

/** Run a filter on a copy of `base` (never mutates it). Returns the result and the time taken. */
export function runOnCopy(def: FilterDef, params: ParamValues, base: ImageData, ctx: FilterContext): { out: ImageData; ms: number } {
  const t0 = performance.now();
  const work = cloneImage(base);
  let out = runFilter(def, work, resolveParams(def, params), ctx);
  if (out.width !== base.width || out.height !== base.height) out = work;
  return { out, ms: performance.now() - t0 };
}

/** Stable key for a params object (used to match previews with the applied state). */
export function paramsKey(filterId: string, params: ParamValues, extra = ''): string {
  return `${filterId}|${extra}|${JSON.stringify(params)}`;
}

/* ------------------------------------------------------------------ */
/* Smart-filter previews in document space (exactly what the canvas shows) */
/* ------------------------------------------------------------------ */

/** Smart-mode preview frame: the layer's document bounds clipped to the canvas (doc px, integer). */
export function smartFrameOf(t: FilterTarget): Rect {
  const doc = t.doc;
  let b: Rect | null = null;
  try {
    b = getLayerBounds(doc, t.layer.id);
  } catch {
    b = null;
  }
  if (!b) b = { x: 0, y: 0, width: doc.width, height: doc.height };
  const x0 = Math.max(0, Math.floor(b.x)),
    y0 = Math.max(0, Math.floor(b.y));
  const x1 = Math.min(doc.width, Math.ceil(b.x + b.width)),
    y1 = Math.min(doc.height, Math.ceil(b.y + b.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    return { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.max(1, Math.ceil(b.width)), height: Math.max(1, Math.ceil(b.height)) };
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The target layer with one more smart filter on top of its stack (a detached copy). */
export function layerWithFilter(t: FilterTarget, instId: string, filterId: string, params: ParamValues): Layer {
  return { ...t.layer, filters: [...t.layer.filters, { id: instId, filterId, enabled: true, params: structuredClone(params) }] } as Layer;
}

/**
 * Render a layer's content + smart filters through the compositor in document space at `scale`
 * (same padding, image box and filter context as the canvas). Null when it draws nothing.
 */
export function renderSmart(t: FilterTarget, layer: Layer, scale: number): HTMLCanvasElement | null {
  try {
    return renderLayerToDoc(t.doc, layer, { scale, effects: false, mask: false });
  } catch (err) {
    console.error('[fx-filters] preview render failed', err);
    return null;
  }
}

/** Crop a document-space render made at `scale` to a doc rect (transparent when empty). */
export function cropDocRender(c: HTMLCanvasElement | null, r: Rect, scale: number): ImageData {
  const w = Math.max(1, Math.round(r.width * scale)),
    h = Math.max(1, Math.round(r.height * scale));
  if (!c) return new ImageData(w, h);
  return cropCanvas(c, Math.round(r.x * scale), Math.round(r.y * scale), w, h);
}
