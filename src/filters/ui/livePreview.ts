/**
 * Live on-canvas previews for the filter dialog. None of them touches the committed document or
 * the layer's bitmaps: they go through the store's preview()/cancelPreview(), so the renderer
 * computes the filter at the viewport's resolution and caches it like any smart filter.
 *
 *  - SmartPreview: a temporary smart-filter instance appended to the layer's filter stack.
 *  - DestructivePreview: a temporary instance of an internal "live preview" filter placed FIRST in
 *    the stack (destructive filters bake into the pixels under the existing smart filters). It runs
 *    the real filter on the layer's own box only (edges clamp like on the bitmap, image-box
 *    centred filters centre on the layer) and limits it to the selection — what OK will produce.
 *  - MaskPreview: masks aren't filtered by the renderer, so the mask is filtered at reduced
 *    resolution into a temporary bitmap that the preview state swaps in.
 */
import { Eye } from 'lucide-react';
import type { ID, ParamValues, Rect } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../../core/canvas';
import { uid } from '../../core/ids';
import { filters, type FilterContext, type FilterDef } from '../../registry';
import { resolveParams, runFilter } from '../engine';
import { useEditor } from '../../state/editor';
import { getSelectionMask } from '../../editor/selection';
import { viewport } from '../../editor/viewport';
import { localRectToDoc, runDestructiveOn, selectionAlpha, selectionWorkRect, type FilterTarget } from './apply';
import { blendSelection } from './selectionBlend';
import { fitImage } from './preview';
import { LIVE_PREVIEW_FILTER_ID } from './galleryModel';

/* ------------------------------------------------------------------ */
/* Smart                                                               */
/* ------------------------------------------------------------------ */

/** Smart-filter preview: a temporary filter instance on the layer via store.preview(). */
export class SmartPreview {
  private readonly instId = uid('fxpv_');
  private active = false;
  constructor(
    private readonly layerId: ID,
    private readonly filterId: string,
  ) {}

  update(params: ParamValues) {
    const id = this.instId;
    const layerId = this.layerId;
    const filterId = this.filterId;
    const p = structuredClone(params);
    useEditor.getState().preview((d) => {
      const l = d.layers[layerId];
      if (!l) return;
      const i = l.filters.findIndex((f) => f.id === id);
      if (i >= 0) l.filters[i].params = p;
      else l.filters.push({ id, filterId, enabled: true, params: p });
    });
    this.active = true;
    viewport.requestRender();
  }

  clear() {
    if (!this.active) return;
    this.active = false;
    useEditor.getState().cancelPreview();
    viewport.requestRender();
  }
}

/* ------------------------------------------------------------------ */
/* Destructive (content)                                               */
/* ------------------------------------------------------------------ */

interface DestructiveSpec {
  def: FilterDef;
  params: ParamValues;
  /** Document-space rect the filter runs on: the layer box, or the selection work rect. */
  rect: Rect;
  /** Document-space selection mask (alpha = strength), null = no selection. */
  sel: HTMLCanvasElement | null;
}

const specs = new Map<string, DestructiveSpec>();

/** Selection alpha for an image region in document space (image px = doc px × s, top-left at doc (ox, oy)). */
function docSelectionAlpha(mask: HTMLCanvasElement, w: number, h: number, s: number, ox: number, oy: number): Uint8ClampedArray {
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  ctx.imageSmoothingEnabled = true;
  ctx.setTransform(s, 0, 0, s, -ox * s, -oy * s);
  ctx.drawImage(mask, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

/** Run a destructive preview spec on a document-space image (what the renderer hands smart filters). */
export function applyDestructiveSpec(img: ImageData, spec: DestructiveSpec, ctx: FilterContext): ImageData {
  const s = ctx.scale > 0 ? ctx.scale : 1;
  const W = img.width,
    H = img.height;
  const r = spec.rect;
  const x0 = Math.max(0, Math.min(W, Math.floor((r.x - ctx.offsetX) * s)));
  const y0 = Math.max(0, Math.min(H, Math.floor((r.y - ctx.offsetY) * s)));
  const x1 = Math.max(0, Math.min(W, Math.ceil((r.x + r.width - ctx.offsetX) * s)));
  const y1 = Math.max(0, Math.min(H, Math.ceil((r.y + r.height - ctx.offsetY) * s)));
  const cw = x1 - x0,
    ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return img;
  const full = x0 === 0 && y0 === 0 && cw === W && ch === H;
  let sub: ImageData;
  if (full) sub = img;
  else {
    sub = new ImageData(cw, ch);
    for (let y = 0; y < ch; y++) sub.data.set(img.data.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1) * 4), y * cw * 4);
  }
  const orig = spec.sel ? new Uint8ClampedArray(sub.data) : null;
  const subCtx: FilterContext = { ...ctx, offsetX: ctx.offsetX + x0 / s, offsetY: ctx.offsetY + y0 / s, scale: s };
  let out = runFilter(spec.def, sub, resolveParams(spec.def, spec.params), subCtx);
  if (out.width !== cw || out.height !== ch) out = sub;
  if (orig && spec.sel) blendSelection(orig, out.data, docSelectionAlpha(spec.sel, cw, ch, s, subCtx.offsetX, subCtx.offsetY));
  if (full) return out;
  for (let y = 0; y < ch; y++) img.data.set(out.data.subarray(y * cw * 4, (y + 1) * cw * 4), ((y0 + y) * W + x0) * 4);
  return img;
}

/** Internal filter carrying a destructive preview (registered only while a preview is live). */
const livePreviewDef: FilterDef = {
  id: LIVE_PREVIEW_FILTER_ID,
  name: 'Filter Preview',
  category: 'Other',
  hidden: true,
  icon: Eye,
  description: 'Temporary on-canvas preview of the filter dialog.',
  params: [],
  apply(img, p, ctx) {
    const spec = typeof p.token === 'string' ? specs.get(p.token) : undefined;
    return spec ? applyDestructiveSpec(img, spec, ctx) : img;
  },
};

let liveUsers = 0;
function acquireLiveDef() {
  if (liveUsers++ === 0) filters.register(livePreviewDef);
}
function releaseLiveDef() {
  if (liveUsers > 0 && --liveUsers === 0) filters.unregister(LIVE_PREVIEW_FILTER_ID);
}

/**
 * Destructive preview of a content target (raster layer): the renderer shows exactly what OK will
 * bake (layer box only, selection-limited, under the existing smart filters).
 */
export class DestructivePreview {
  private readonly instId = uid('fxdp_');
  private active = false;
  private acquired = false;
  private rev = 0;
  private tokens: string[] = [];
  private readonly box: Rect;
  private readonly localW: number;
  private readonly localH: number;
  private selLocal: Uint8ClampedArray | null | undefined;

  constructor(
    private readonly target: FilterTarget,
    source: HTMLCanvasElement,
  ) {
    this.localW = source.width;
    this.localH = source.height;
    this.box = localRectToDoc(target, { x: 0, y: 0, width: this.localW, height: this.localH });
  }

  /** Document rect to filter for these params: the layer box, or (with a selection) its work rect. */
  private rectFor(def: FilterDef, params: ParamValues): Rect | null {
    const t = this.target;
    if (!t.doc.selection) return this.box;
    if (this.selLocal === undefined) this.selLocal = selectionAlpha(t, this.localW, this.localH, 1);
    const sel = this.selLocal;
    if (!sel) return this.box;
    const r = selectionWorkRect(def, params, t, sel, this.localW, this.localH, 1);
    if (r === null) return null;
    return r === undefined ? this.box : localRectToDoc(t, r);
  }

  update(def: FilterDef, params: ParamValues) {
    const rect = this.rectFor(def, params);
    if (!rect) {
      // the selection doesn't touch the layer: the result is the original
      this.clear();
      return;
    }
    if (!this.acquired) {
      acquireLiveDef();
      this.acquired = true;
    }
    const token = `${this.instId}:${++this.rev}`;
    specs.set(token, { def, params: structuredClone(params), rect, sel: getSelectionMask(this.target.doc) });
    this.tokens.push(token);
    while (this.tokens.length > 3) specs.delete(this.tokens.shift()!);
    const id = this.instId;
    const layerId = this.target.layer.id;
    useEditor.getState().preview((d) => {
      const l = d.layers[layerId];
      if (!l) return;
      const i = l.filters.findIndex((f) => f.id === id);
      if (i >= 0) l.filters[i].params = { token };
      else l.filters.unshift({ id, filterId: LIVE_PREVIEW_FILTER_ID, enabled: true, params: { token } });
    });
    this.active = true;
    viewport.requestRender();
  }

  clear() {
    if (this.active) {
      this.active = false;
      useEditor.getState().cancelPreview();
      viewport.requestRender();
    }
  }

  /** Clear and release the internal filter (call once when the dialog goes away). */
  dispose() {
    this.clear();
    for (const t of this.tokens) specs.delete(t);
    this.tokens = [];
    if (this.acquired) {
      this.acquired = false;
      releaseLiveDef();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Destructive (layer mask)                                            */
/* ------------------------------------------------------------------ */

/** Pixel budget of the reduced-resolution mask preview. */
const MASK_PREVIEW_PX = 1_000_000;

/**
 * Mask preview: the mask is filtered at reduced resolution (≤ ~1 MP) and upscaled into a temporary
 * bitmap that the preview state uses as the layer's mask. OK recomputes at full resolution.
 */
export class MaskPreview {
  private tempId: ID | null = null;
  private active = false;
  private small: { img: ImageData; k: number; sel: Uint8ClampedArray | null } | null = null;

  constructor(
    private readonly target: FilterTarget,
    private readonly source: HTMLCanvasElement,
  ) {}

  update(def: FilterDef, params: ParamValues) {
    const t = this.target;
    const src = this.source;
    if (!this.small) {
      const k0 = Math.min(1, Math.sqrt(MASK_PREVIEW_PX / Math.max(1, src.width * src.height)));
      const f = k0 < 1 ? fitImage(src, Math.round(src.width * k0), Math.round(src.height * k0)) : fitImage(src, src.width, src.height);
      this.small = { img: f.img, k: f.k, sel: selectionAlpha(t, f.img.width, f.img.height, f.k) };
    }
    const { img, k, sel } = this.small;
    const out = runDestructiveOn(def, params, t, img, k, 0, 0, sel);
    const tmp = createCanvas(out.width, out.height);
    ctx2d(tmp).putImageData(out, 0, 0);
    if (!this.tempId || !bitmaps.has(this.tempId)) this.tempId = bitmaps.add(createCanvas(src.width, src.height));
    const c = bitmaps.get(this.tempId);
    const g = ctx2d(c);
    g.clearRect(0, 0, c.width, c.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(tmp, 0, 0, c.width, c.height);
    bitmaps.touch(this.tempId);
    const tempId = this.tempId;
    const layerId = t.layer.id;
    if (!this.active) {
      useEditor.getState().preview((d) => {
        const l = d.layers[layerId];
        if (l?.mask) l.mask.bitmapId = tempId;
      });
      this.active = true;
    }
    viewport.requestRender();
  }

  clear() {
    if (!this.active) return;
    this.active = false;
    useEditor.getState().cancelPreview();
    viewport.requestRender();
  }

  dispose() {
    this.clear();
  }
}
