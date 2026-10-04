/**
 * Applying filters to the document: target resolution (which layer / mask, what is allowed),
 * filter contexts in layer-local space, selection masks mapped into layer space, destructive
 * application with history patches, smart-filter insertion, and the live on-canvas previews
 * used by the filter dialog.
 */
import type { Document, ID, Layer, ParamValues, Rect, TransformableLayer } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctxRead } from '../../core/canvas';
import { transformMatrix } from '../../core/geometry';
import { makeFilterInstance } from '../../core/document';
import { uid } from '../../core/ids';
import { filters, type FilterContext, type FilterDef } from '../../registry';
import { makeFilterContext, resolveParams, runFilter } from '../engine';
import { activeSession, useEditor } from '../../state/editor';
import { getSelectionMask } from '../../editor/selection';
import { viewport } from '../../editor/viewport';
import { getLayerSize, renderLayerContent } from '../../render/compositor';
import { blendSelection } from './selectionBlend';

export type ApplyMode = 'smart' | 'destructive';

export interface FilterTarget {
  /** Committed document (never a live preview state). */
  doc: Document;
  layer: Layer & TransformableLayer;
  /** 'mask' when the user is editing the layer mask (destructive only). */
  kind: 'content' | 'mask';
  canSmart: boolean;
  canDestructive: boolean;
  /** Why destructive application is unavailable (shown in the dialog). */
  destructiveNote?: string;
  /** Default mode for 'auto'. */
  autoMode: ApplyMode;
}

/** Committed document of the active session (ignores an in-flight preview). */
export function committedDoc(): Document | null {
  const s = activeSession();
  if (!s) return null;
  return s.history.entries[s.history.index]?.doc ?? s.doc;
}

/** Work out what the active layer allows. Returns a user-facing error message when nothing can be filtered. */
export function resolveTarget(): { target: FilterTarget } | { error: string } {
  const s = activeSession();
  if (!s) return { error: 'Open a document first to apply filters.' };
  const doc = committedDoc()!;
  const layer = s.activeLayerId ? doc.layers[s.activeLayerId] : null;
  if (!layer) return { error: 'Select a layer in the Layers panel to apply a filter to.' };
  if (layer.type === 'group') return { error: 'Filters can’t be applied to a group. Select a layer inside it, or merge the group first.' };
  if (layer.type === 'adjustment') return { error: 'Adjustment layers can’t be filtered. Select a pixel, text or shape layer.' };
  if (layer.type === 'fill') return { error: 'Fill layers can’t be filtered. Rasterize the layer (Layer ▸ Rasterize) first.' };
  if (layer.locks.all) return { error: `“${layer.name}” is locked. Unlock it to apply filters.` };
  if (s.editTarget === 'mask' && layer.mask) {
    if (layer.locks.pixels) return { error: `“${layer.name}” has locked pixels.` };
    return { target: { doc, layer, kind: 'mask', canSmart: false, canDestructive: true, autoMode: 'destructive', destructiveNote: 'Editing the layer mask: the filter is applied to the mask.' } };
  }
  if (layer.type === 'raster') {
    const locked = layer.locks.pixels;
    return {
      target: {
        doc,
        layer,
        kind: 'content',
        canSmart: true,
        canDestructive: !locked,
        destructiveNote: locked ? 'Layer pixels are locked — the filter is added as a Smart Filter.' : undefined,
        // generated layers (library assets, Pose Studio renders) keep re-editability by default
        autoMode: locked || layer.generator ? 'smart' : 'destructive',
      },
    };
  }
  return {
    target: {
      doc,
      layer,
      kind: 'content',
      canSmart: true,
      canDestructive: false,
      destructiveNote: `${layer.type === 'text' ? 'Text' : 'Shape'} layers stay editable: filters are added as Smart Filters (rasterize the layer to bake them in).`,
      autoMode: 'smart',
    },
  };
}

/** Resolve the effective mode for a target and a requested mode. */
export function effectiveMode(t: FilterTarget, requested: 'auto' | ApplyMode | undefined): ApplyMode {
  if (t.kind === 'mask') return 'destructive';
  if (requested === 'smart') return t.canSmart ? 'smart' : 'destructive';
  if (requested === 'destructive') return t.canDestructive ? 'destructive' : 'smart';
  return t.autoMode;
}

/**
 * Filter context for the target's local pixel space at `previewScale` (image px per local px).
 * Exact for unrotated layers: patterns line up with the document grid and size params are in
 * document px whatever the layer's scale.
 */
export function targetContext(t: FilterTarget, previewScale = 1, cropX = 0, cropY = 0): FilterContext {
  const doc = t.doc;
  if (t.kind === 'mask') {
    return makeFilterContext({ docWidth: doc.width, docHeight: doc.height, offsetX: cropX / previewScale, offsetY: cropY / previewScale, scale: previewScale });
  }
  const size = getLayerSize(t.layer);
  const tr = t.layer.transform;
  const sx = Math.abs(tr.scaleX) || 1,
    sy = Math.abs(tr.scaleY) || 1;
  const ls = Math.sqrt(sx * sy);
  const scale = previewScale / ls;
  return makeFilterContext({
    docWidth: doc.width,
    docHeight: doc.height,
    offsetX: tr.x + (size.width * (1 - sx)) / 2 + cropX / scale,
    offsetY: tr.y + (size.height * (1 - sy)) / 2 + cropY / scale,
    scale,
  });
}

/** Bitmap id written by a destructive application (layer pixels or mask). */
export function targetBitmapId(t: FilterTarget): ID | null {
  if (t.kind === 'mask') return t.layer.mask?.bitmapId ?? null;
  return t.layer.type === 'raster' ? t.layer.bitmapId : null;
}

/**
 * Source pixels the filter sees, as a canvas in the target's local space:
 *  - destructive: the raw bitmap (layer content or mask);
 *  - smart: the layer content with its existing smart filters (new filters stack on top).
 */
export function targetSource(t: FilterTarget, mode: ApplyMode): HTMLCanvasElement {
  const bmp = mode === 'destructive' ? targetBitmapId(t) : null;
  if (bmp) {
    const src = bitmaps.get(bmp);
    const c = createCanvas(src.width, src.height);
    ctxRead(c).drawImage(src, 0, 0);
    return c;
  }
  try {
    return renderLayerContent(t.doc, t.layer);
  } catch (err) {
    console.error('[fx-filters] could not render layer content', err);
    const size = getLayerSize(t.layer);
    return createCanvas(size.width, size.height);
  }
}

/**
 * The document selection as an alpha plane (0..255) in the target's local pixel space at
 * `previewScale`, cropped at (cropX, cropY) with size w×h. Null when nothing is selected.
 */
export function selectionAlpha(t: FilterTarget, w: number, h: number, previewScale = 1, cropX = 0, cropY = 0): Uint8ClampedArray | null {
  const mask = getSelectionMask(t.doc);
  if (!mask) return null;
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  ctx.imageSmoothingEnabled = true;
  ctx.setTransform(previewScale, 0, 0, previewScale, -cropX, -cropY);
  if (t.kind === 'content') {
    const size = getLayerSize(t.layer);
    const inv = transformMatrix(t.layer.transform, size.width, size.height).inverse();
    ctx.transform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
  }
  ctx.drawImage(mask, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

/** Bounding box of non-zero alpha (or null). */
export function alphaBounds(a: Uint8ClampedArray, w: number, h: number): Rect | null {
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (a[row + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Compute the destructive result for a target: filter the full-resolution source, then limit it
 * to the selection. Returns the new pixels and the dirty rect (null rect = nothing changes).
 */
export function computeDestructive(def: FilterDef, params: ParamValues, t: FilterTarget, source: ImageData): { out: ImageData; rect: Rect | null } {
  const w = source.width,
    h = source.height;
  const orig = new Uint8ClampedArray(source.data);
  const work = new ImageData(new Uint8ClampedArray(orig), w, h);
  let out = runFilter(def, work, resolveParams(def, params), targetContext(t, 1));
  if (out.width !== w || out.height !== h) out = work; // contract violation guard
  const sel = selectionAlpha(t, w, h, 1);
  if (!sel) return { out, rect: { x: 0, y: 0, width: w, height: h } };
  const rect = alphaBounds(sel, w, h);
  if (!rect) return { out: new ImageData(orig, w, h), rect: null };
  blendSelection(orig, out.data, sel);
  return { out, rect };
}

/** Apply a filter destructively and commit one history step. Returns false when nothing changed. */
export function applyDestructive(def: FilterDef, params: ParamValues, t: FilterTarget, precomputed?: { out: ImageData; rect: Rect | null; before?: ImageData }): boolean {
  const id = targetBitmapId(t);
  if (!id || !bitmaps.has(id)) return false;
  let res = precomputed;
  if (!res) {
    const src = bitmaps.read(id);
    res = computeDestructive(def, params, t, src);
  }
  const rect = res.rect;
  if (!rect) return false;
  let patch;
  if (res.before) {
    // live preview already wrote the pixels: build the patch from the saved before-image
    const before = cropImageData(res.before, rect);
    const after = cropImageData(res.out, rect);
    const c = bitmaps.get(id);
    ctxRead(c).putImageData(res.out, 0, 0, rect.x, rect.y, rect.width, rect.height);
    bitmaps.touch(id);
    patch = { bitmapId: id, x: rect.x, y: rect.y, before, after };
  } else {
    const out = res.out;
    patch = bitmaps.edit(id, (ctx) => ctx.putImageData(out, 0, 0, rect.x, rect.y, rect.width, rect.height), rect);
  }
  useEditor.getState().commit(t.kind === 'mask' ? `${def.name} (Mask)` : def.name, undefined, { patches: [patch] });
  viewport.requestRender();
  return true;
}

export function cropImageData(img: ImageData, r: Rect): ImageData {
  if (r.x === 0 && r.y === 0 && r.width === img.width && r.height === img.height) return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const out = new ImageData(r.width, r.height);
  const src = img.data,
    dst = out.data;
  for (let y = 0; y < r.height; y++) {
    const so = ((r.y + y) * img.width + r.x) * 4;
    dst.set(src.subarray(so, so + r.width * 4), y * r.width * 4);
  }
  return out;
}

/** Add a smart filter instance to a layer (one history step). */
export function applySmart(def: FilterDef, params: ParamValues, layerId: ID): void {
  useEditor.getState().commit(`${def.name} (Smart Filter)`, (d) => {
    const l = d.layers[layerId];
    if (!l) return;
    l.filters.push(makeFilterInstance(def.id, structuredClone(params)));
  });
  viewport.requestRender();
}

/** Apply without a dialog (filter.last, gallery, parameterless filters). */
export function applyFilterNow(filterId: string, params: ParamValues, requested: 'auto' | ApplyMode = 'auto'): { ok: boolean; mode?: ApplyMode; error?: string } {
  const def = filters.get(filterId);
  if (!def) return { ok: false, error: `Filter “${filterId}” is not available.` };
  const r = resolveTarget();
  if ('error' in r) return { ok: false, error: r.error };
  const mode = effectiveMode(r.target, requested);
  if (mode === 'smart') {
    applySmart(def, params, r.target.layer.id);
    return { ok: true, mode };
  }
  const ok = applyDestructive(def, params, r.target);
  return ok ? { ok, mode } : { ok: false, error: 'The selection doesn’t overlap this layer — nothing was filtered.' };
}

/* ------------------------------------------------------------------ */
/* Live on-canvas previews                                             */
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

/**
 * Destructive preview: writes the filtered pixels straight into the live bitmap (restoring the
 * saved original on cancel), so the canvas shows the exact result — selection included — even
 * before the compositor supports smart filters.
 */
export class BitmapPreview {
  readonly before: ImageData;
  private dirty = false;
  last: { key: string; out: ImageData; rect: Rect | null } | null = null;

  constructor(
    private readonly bitmapId: ID,
    private readonly target: FilterTarget,
  ) {
    this.before = bitmaps.read(bitmapId);
  }

  update(def: FilterDef, params: ParamValues, key: string) {
    const src = new ImageData(new Uint8ClampedArray(this.before.data), this.before.width, this.before.height);
    const res = computeDestructive(def, params, this.target, src);
    this.last = { key, ...res };
    const c = bitmaps.tryGet(this.bitmapId);
    if (!c) return;
    const ctx = ctxRead(c);
    ctx.putImageData(res.rect ? res.out : this.before, 0, 0);
    this.dirty = true;
    bitmaps.touch(this.bitmapId);
    viewport.requestRender();
  }

  restore() {
    if (!this.dirty) return;
    this.dirty = false;
    const c = bitmaps.tryGet(this.bitmapId);
    if (c) {
      ctxRead(c).putImageData(this.before, 0, 0);
      bitmaps.touch(this.bitmapId);
    }
    viewport.requestRender();
  }

  /** Commit the previewed result if it matches `key` (else recompute). */
  commit(def: FilterDef, params: ParamValues, key: string): boolean {
    if (this.last && this.last.key === key && this.dirty) {
      const ok = applyDestructive(def, params, this.target, { out: this.last.out, rect: this.last.rect, before: this.before });
      if (!ok) this.restore();
      this.dirty = false;
      return ok;
    }
    this.restore();
    return applyDestructive(def, params, this.target);
  }
}
