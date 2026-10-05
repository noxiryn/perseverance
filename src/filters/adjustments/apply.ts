/**
 * Destructive pixel edits on the active raster layer or layer mask (Auto Tone/Contrast/Color,
 * Desaturate, the Image ▸ Adjustments dialog…), recorded as a BitmapPatch so they are undoable.
 * Respects the selection (soft edges blend). Also the live on-canvas previews of the dialog.
 */
import type { Document, ID, Layer, ParamValues } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { uid } from '../../core/ids';
import { makeFilterInstance } from '../../core/document';
import type { FilterContext, FilterDef } from '../../registry';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { invalidateRenderCache } from '../../render/compositor';
import { getSelectionMask } from '../../editor/selection';
import { createCanvas, ctx2d } from '../../core/canvas';
import { makeFilterContext, resolveParams } from '../engine';
import { layerSelectionMask, NO_DOC_MESSAGE } from './layers';

export interface RasterTarget {
  doc: Document;
  layer: Layer;
  /** 'mask' when the layer mask is the edit target (Photoshop applies adjustments to it). */
  kind: 'content' | 'mask';
  /** Bitmap that is analysed and edited (layer pixels or the doc-sized mask). */
  bitmapId: ID;
  /** Selection mapped to the bitmap's pixels (null = everything). */
  mask: Uint8ClampedArray | null;
}

/** Selection alpha of a doc-sized bitmap (masks live in document space). */
function docSelectionMask(doc: Document): Uint8ClampedArray | null {
  const sel = getSelectionMask(doc);
  if (!sel) return null;
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c, { willReadFrequently: true });
  ctx.drawImage(sel, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8ClampedArray(doc.width * doc.height);
  for (let p = 0, i = 3; p < out.length; p++, i += 4) out[p] = d[i];
  return out;
}

/** Validate that the active layer can be edited destructively; toasts a helpful message if not. */
export function activeRasterTarget(action: string): RasterTarget | null {
  const s = activeSession();
  if (!s) {
    toast(NO_DOC_MESSAGE, 'info');
    return null;
  }
  const layer = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!layer) {
    toast(`Select a layer to ${action}.`, 'info');
    return null;
  }
  if (s.editTarget === 'mask' && layer.mask) {
    if (layer.locks.all) {
      toast(`“${layer.name}” is locked. Unlock it in the Layers panel to ${action}.`, 'warning');
      return null;
    }
    if (!bitmaps.has(layer.mask.bitmapId)) {
      toast(`The mask of “${layer.name}” is not available.`, 'error');
      return null;
    }
    const mask = s.doc.selection ? docSelectionMask(s.doc) : null;
    if (mask && !mask.some((v) => v > 0)) {
      toast('The selection is empty.', 'info');
      return null;
    }
    return { doc: s.doc, layer, kind: 'mask', bitmapId: layer.mask.bitmapId, mask };
  }
  if (layer.type !== 'raster') {
    toast(`${cap(action)} needs a pixel layer. Rasterize “${layer.name}” first, or use an adjustment layer instead.`, 'warning');
    return null;
  }
  if (layer.locks.all || layer.locks.pixels) {
    toast(`“${layer.name}” has locked pixels. Unlock it in the Layers panel to ${action}.`, 'warning');
    return null;
  }
  if (!bitmaps.has(layer.bitmapId)) {
    toast(`The pixels of “${layer.name}” are not available.`, 'error');
    return null;
  }
  let mask: Uint8ClampedArray | null = null;
  if (s.doc.selection) {
    mask = layerSelectionMask(s.doc, layer);
    if (mask && !mask.some((v) => v > 0)) {
      toast(`The selection does not overlap “${layer.name}”.`, 'info');
      return null;
    }
  }
  return { doc: s.doc, layer, kind: 'content', bitmapId: layer.bitmapId, mask };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Limit an edit to a selection: blend `out` back toward `orig` by (1 − mask) per pixel, in place.
 * mask 255 keeps the edit, 0 restores the original, values between blend (soft selections).
 */
export function blendMasked(orig: ArrayLike<number>, out: Uint8ClampedArray, mask: ArrayLike<number>): void {
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const m = mask[p];
    if (m === 255) continue;
    if (m === 0) {
      out[i] = orig[i];
      out[i + 1] = orig[i + 1];
      out[i + 2] = orig[i + 2];
      out[i + 3] = orig[i + 3];
      continue;
    }
    const t = m / 255;
    out[i] = orig[i] + (out[i] - orig[i]) * t;
    out[i + 1] = orig[i + 1] + (out[i + 1] - orig[i + 1]) * t;
    out[i + 2] = orig[i + 2] + (out[i + 2] - orig[i + 2]) * t;
    out[i + 3] = orig[i + 3] + (out[i + 3] - orig[i + 3]) * t;
  }
}

/**
 * Run `fn` over the layer's pixels (in place on an ImageData), blend through the selection mask
 * and commit one history step.
 */
export function editRasterPixels(target: RasterTarget, label: string, fn: (img: ImageData) => void): void {
  const { layer, mask, bitmapId } = target;
  const patch = bitmaps.edit(bitmapId, (ctx, canvas) => {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const orig = mask ? img.data.slice() : null;
    fn(img);
    if (mask && orig) blendMasked(orig, img.data, mask);
    ctx.putImageData(img, 0, 0);
  });
  invalidateRenderCache(layer.id);
  useEditor.getState().commit(target.kind === 'mask' ? `${label} (Mask)` : label, undefined, { patches: [patch] });
  viewport.requestRender();
}

/** Filter context for a destructive target (layer-local pixels, or the document-sized mask). */
export function targetFilterContext(target: RasterTarget): FilterContext {
  const { doc, layer } = target;
  const offset = target.kind === 'content' && layer.type === 'raster' ? { offsetX: layer.transform.x, offsetY: layer.transform.y } : {};
  return makeFilterContext({ docWidth: doc.width, docHeight: doc.height, ...offset });
}

/** Run a filter definition in place on `img` (copies the result back when it returns new ImageData). */
export function runAdjustment(def: FilterDef, img: ImageData, params: ParamValues, ctx: FilterContext): void {
  const out = def.apply(img, resolveParams(def, params), ctx);
  if (out && out !== img && out.width === img.width && out.height === img.height) img.data.set(out.data);
}

/**
 * Live destructive preview: writes the adjusted pixels straight into the bitmap so the canvas
 * shows the exact result (selection included), restoring the saved original on cancel. Commit by
 * calling `restore()` and then `editRasterPixels`, which records a proper before/after patch.
 */
export class PixelPreview {
  readonly before: ImageData;
  private dirty = false;

  constructor(private readonly target: RasterTarget) {
    this.before = bitmaps.read(target.bitmapId);
  }

  update(fn: (img: ImageData) => void): void {
    const { width, height } = this.before;
    const img = new ImageData(new Uint8ClampedArray(this.before.data), width, height);
    fn(img);
    if (this.target.mask) blendMasked(this.before.data, img.data, this.target.mask);
    this.put(img);
    this.dirty = true;
  }

  restore(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.put(this.before);
  }

  private put(img: ImageData) {
    const c = bitmaps.tryGet(this.target.bitmapId);
    if (!c) return;
    ctx2d(c).putImageData(img, 0, 0);
    bitmaps.touch(this.target.bitmapId);
    invalidateRenderCache(this.target.layer.id);
    viewport.requestRender();
  }
}

/** Live smart-filter preview (text / shape layers): a temporary filter instance via store.preview(). */
export class SmartFilterPreview {
  private readonly instId = uid('adjpv_');
  private active = false;

  constructor(
    private readonly layerId: ID,
    private readonly filterId: string,
  ) {}

  update(params: ParamValues): void {
    const { instId, layerId, filterId } = this;
    const p = structuredClone(params);
    useEditor.getState().preview((d) => {
      const l = d.layers[layerId];
      if (!l) return;
      const i = l.filters.findIndex((f) => f.id === instId);
      if (i >= 0) l.filters[i].params = p;
      else l.filters.push({ id: instId, filterId, enabled: true, params: p });
    });
    this.active = true;
    viewport.requestRender();
  }

  clear(): void {
    if (!this.active) return;
    this.active = false;
    useEditor.getState().cancelPreview();
    viewport.requestRender();
  }
}

/** Add `def` with `params` to a layer's smart filters (one history step). */
export function addSmartFilter(def: FilterDef, params: ParamValues, layerId: ID): void {
  useEditor.getState().commit(`${def.name} (Smart Filter)`, (d) => {
    const l = d.layers[layerId];
    if (l) l.filters.push(makeFilterInstance(def.id, structuredClone(params)));
  });
  viewport.requestRender();
}

/** Read the target's pixels used for analysis (full bitmap). */
export function readTargetPixels(target: RasterTarget): ImageData {
  return bitmaps.read(target.bitmapId);
}
