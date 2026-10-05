/**
 * Applying filters to the document: target resolution (which layer / mask, what is allowed),
 * filter contexts in layer-local space, selection masks mapped into layer space, destructive
 * application with history patches and smart-filter insertion. (Live on-canvas previews are in
 * livePreview.ts.)
 */
import type { Document, ID, Layer, ParamValues, Rect, TransformableLayer } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctxRead } from '../../core/canvas';
import { transformMatrix } from '../../core/geometry';
import { makeFilterInstance } from '../../core/document';
import { filters, type FilterContext, type FilterDef } from '../../registry';
import { makeFilterContext, resolveParams, runFilter } from '../engine';
import { activeSession, useEditor } from '../../state/editor';
import { getSelectionMask } from '../../editor/selection';
import { viewport } from '../../editor/viewport';
import { getLayerSize, renderLayerContent } from '../../render/compositor';
import { blendSelection, diffBounds } from './selectionBlend';

export type ApplyMode = 'smart' | 'destructive';

export interface FilterTarget {
  /** Committed document (never a live preview state). */
  doc: Document;
  /** The layer. Content targets are always raster / text / shape layers (see contentLayer). */
  layer: Layer;
  /** 'mask' when the user is editing the layer mask (destructive only, any layer type). */
  kind: 'content' | 'mask';
  canSmart: boolean;
  canDestructive: boolean;
  /** Why one of the modes is unavailable (shown in the dialog). */
  destructiveNote?: string;
  /** Default mode for 'auto'. */
  autoMode: ApplyMode;
}

/** The transformable layer of a content target. */
export function contentLayer(t: FilterTarget): Layer & TransformableLayer {
  return t.layer as Layer & TransformableLayer;
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
  if (layer.locks.all) return { error: `“${layer.name}” is locked. Unlock it to apply filters.` };
  // Masks are doc-space bitmaps: any layer's mask can be filtered (e.g. blur an adjustment mask to feather it).
  if (s.editTarget === 'mask' && layer.mask) {
    if (layer.locks.pixels) return { error: `“${layer.name}” has locked pixels. Unlock them to filter its mask.` };
    return { target: { doc, layer, kind: 'mask', canSmart: false, canDestructive: true, autoMode: 'destructive', destructiveNote: 'Editing the layer mask: the filter is applied to the mask.' } };
  }
  const maskHint = layer.mask ? ' (or click its mask thumbnail to filter the mask)' : '';
  if (layer.type === 'group') return { error: `Filters can’t be applied to a group${maskHint}. Select a layer inside it, or merge the group first.` };
  if (layer.type === 'adjustment') return { error: `Adjustment layers can’t be filtered${maskHint}. Select a pixel, text or shape layer.` };
  if (layer.type === 'fill') return { error: `Fill layers can’t be filtered${maskHint}. Rasterize the layer (Layer ▸ Rasterize) first.` };
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
        // spec: 'auto' bakes into raster layers (generated layers included — the dialog warns that
        // regenerating discards it); the Smart Filter checkbox keeps it re-editable.
        autoMode: locked ? 'smart' : 'destructive',
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
 * Mode to remember for Filter ▸ Last Filter: 'auto' when the user kept the target's default (so
 * a smart filter on a text layer re-applies destructively to a pixel layer), else the explicit
 * choice.
 */
export function lastModeFor(t: FilterTarget, chosen: ApplyMode): 'auto' | ApplyMode {
  return chosen === effectiveMode(t, 'auto') ? 'auto' : chosen;
}

/**
 * Filter context for the target's local pixel space at `previewScale` (image px per local px),
 * for an image whose top-left is local pixel (cropX, cropY) / previewScale.
 *
 * Exact for unrotated, unflipped layers: patterns line up with the document grid and size params
 * are in document px whatever the layer's scale. A FilterContext can only express an offset and a
 * uniform scale, so on rotated or flipped layers document-anchored patterns (halftone grid,
 * scanlines, vignette…) follow the layer's own axes — like Photoshop, where destructive filters
 * work in the layer's pixel space. The layer box center still maps to the right document point.
 * (Smart filters don't have this limitation: the renderer runs them in document space.)
 */
export function targetContext(t: FilterTarget, previewScale = 1, cropX = 0, cropY = 0): FilterContext {
  const doc = t.doc;
  if (t.kind === 'mask') {
    return makeFilterContext({ docWidth: doc.width, docHeight: doc.height, offsetX: cropX / previewScale, offsetY: cropY / previewScale, scale: previewScale });
  }
  const layer = contentLayer(t);
  const size = getLayerSize(layer);
  const tr = layer.transform;
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
  const bmp = mode === 'destructive' || t.kind === 'mask' ? targetBitmapId(t) : null;
  if (bmp && bitmaps.has(bmp)) {
    const src = bitmaps.get(bmp);
    const c = createCanvas(src.width, src.height);
    ctxRead(c).drawImage(src, 0, 0);
    return c;
  }
  const layer = contentLayer(t);
  try {
    return renderLayerContent(t.doc, layer);
  } catch (err) {
    console.error('[fx-filters] could not render layer content', err);
    const size = getLayerSize(layer);
    return createCanvas(size.width, size.height);
  }
}

/** Local → document matrix of a content target (identity for masks, which live in document space). */
export function localToDoc(t: FilterTarget): DOMMatrix {
  if (t.kind === 'mask') return new DOMMatrix();
  const layer = contentLayer(t);
  const size = getLayerSize(layer);
  return transformMatrix(layer.transform, size.width, size.height);
}

/** Document-space bounding box of a local rect of the target. */
export function localRectToDoc(t: FilterTarget, r: Rect): Rect {
  const m = localToDoc(t);
  const pts = [
    m.transformPoint({ x: r.x, y: r.y }),
    m.transformPoint({ x: r.x + r.width, y: r.y }),
    m.transformPoint({ x: r.x, y: r.y + r.height }),
    m.transformPoint({ x: r.x + r.width, y: r.y + r.height }),
  ];
  const xs = pts.map((p) => p.x),
    ys = pts.map((p) => p.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
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
    const inv = localToDoc(t).inverse();
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
    let x0 = -1;
    for (let x = 0; x < w; x++)
      if (a[row + x] !== 0) {
        x0 = x;
        break;
      }
    if (x0 < 0) continue;
    let x1 = x0;
    for (let x = w - 1; x > x0; x--)
      if (a[row + x] !== 0) {
        x1 = x;
        break;
      }
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y < minY) minY = y;
    maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/* ------------------------------------------------------------------ */
/* Selection-limited filtering                                         */
/* ------------------------------------------------------------------ */

/** Filters whose output depends on pixels arbitrarily far away (always run on the whole image). */
const GLOBAL_REACH = new Set(['god-rays']);
const REACH_KEY = /radius|size|distance|length|thickness|width|amount|amplitude|spacing|strength|spread|offset|blur|feather|shift|displace/i;

/**
 * How far (document px) a filter can pull pixels from, estimated from its numeric size-like
 * params; null = unbounded (filter the whole image). Used to filter only the selection bounds plus
 * this margin, so a small selection on a big layer stays fast.
 */
export function filterReach(def: FilterDef, params: ParamValues): number | null {
  if (GLOBAL_REACH.has(def.id)) return null;
  const p = resolveParams(def, params);
  let m = 0;
  for (const k in p) {
    const v = p[k];
    if (typeof v === 'number' && REACH_KEY.test(k)) m = Math.max(m, Math.abs(v));
  }
  return Math.min(600, m * 1.5 + 8);
}

/**
 * Local rect (image px of an image at `k` × local resolution, size w×h) that a selection-limited
 * filter run must cover: the selection bounds grown by the filter's reach. `null` = nothing is
 * selected inside the image; `undefined` = filter the whole image.
 */
export function selectionWorkRect(def: FilterDef, params: ParamValues, t: FilterTarget, sel: Uint8ClampedArray, w: number, h: number, k: number): Rect | null | undefined {
  const b = alphaBounds(sel, w, h);
  if (!b) return null;
  const reach = filterReach(def, params);
  if (reach === null) return undefined;
  // reach is in document px: convert to image px (k image px per local px, local px = doc px / layer scale)
  const ctx = targetContext(t, k);
  const m = Math.ceil(reach * ctx.scale);
  const x0 = Math.max(0, b.x - m),
    y0 = Math.max(0, b.y - m);
  const x1 = Math.min(w, b.x + b.width + m),
    y1 = Math.min(h, b.y + b.height + m);
  if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Destructive filter result on `img` (target-local pixels at `k` × local resolution whose
 * top-left is local px (cropX, cropY) / k), limited to the selection plane `sel` (same size, or
 * null = everything). Only the selection bounds plus the filter's reach are filtered. Returns a new
 * ImageData; `img` is not modified.
 */
export function runDestructiveOn(def: FilterDef, params: ParamValues, t: FilterTarget, img: ImageData, k: number, cropX: number, cropY: number, sel: Uint8ClampedArray | null): ImageData {
  const w = img.width,
    h = img.height;
  const rp = resolveParams(def, params);
  if (!sel) {
    const work = new ImageData(new Uint8ClampedArray(img.data), w, h);
    const out = runFilter(def, work, rp, targetContext(t, k, cropX, cropY));
    return out.width === w && out.height === h ? out : work;
  }
  const rect = selectionWorkRect(def, params, t, sel, w, h, k);
  const result = new ImageData(new Uint8ClampedArray(img.data), w, h);
  if (rect === null) return result;
  if (rect === undefined) {
    const work = new ImageData(new Uint8ClampedArray(img.data), w, h);
    let out = runFilter(def, work, rp, targetContext(t, k, cropX, cropY));
    if (out.width !== w || out.height !== h) out = work;
    blendSelection(img.data, out.data, sel);
    return out;
  }
  // filter just the work rect
  const sub = cropImageData(img, rect);
  const orig = new Uint8ClampedArray(sub.data);
  let out = runFilter(def, sub, rp, targetContext(t, k, cropX + rect.x, cropY + rect.y));
  if (out.width !== rect.width || out.height !== rect.height) out = sub;
  const subSel = new Uint8ClampedArray(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) subSel.set(sel.subarray((rect.y + y) * w + rect.x, (rect.y + y) * w + rect.x + rect.width), y * rect.width);
  blendSelection(orig, out.data, subSel);
  const dst = result.data,
    src = out.data;
  for (let y = 0; y < rect.height; y++) dst.set(src.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * w + rect.x) * 4);
  return result;
}

/**
 * Compute the destructive result for a target at full resolution, limited to the selection.
 * Returns the new pixels and the dirty rect (null rect = nothing changes).
 */
export function computeDestructive(def: FilterDef, params: ParamValues, t: FilterTarget, source: ImageData): { out: ImageData; rect: Rect | null } {
  const w = source.width,
    h = source.height;
  const sel = selectionAlpha(t, w, h, 1);
  if (sel && !alphaBounds(sel, w, h)) return { out: source, rect: null };
  const out = runDestructiveOn(def, params, t, source, 1, 0, 0, sel);
  // history patches only need the pixels that actually changed
  return { out, rect: diffBounds(source.data, out.data, w, h) };
}

/** Apply a filter destructively and commit one history step. Returns false when nothing changed. */
export function applyDestructive(def: FilterDef, params: ParamValues, t: FilterTarget, precomputed?: { out: ImageData; rect: Rect | null }): boolean {
  const id = targetBitmapId(t);
  if (!id || !bitmaps.has(id)) return false;
  const res = precomputed ?? computeDestructive(def, params, t, bitmaps.read(id));
  const rect = res.rect;
  if (!rect) return false;
  const out = res.out;
  const patch = bitmaps.edit(id, (ctx) => ctx.putImageData(out, 0, 0, rect.x, rect.y, rect.width, rect.height), rect);
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

/** User-facing explanation when a destructive application changed nothing. */
export function noChangeMessage(def: FilterDef, t: FilterTarget): string {
  return t.doc.selection
    ? 'The selection doesn’t overlap this layer’s pixels — nothing was filtered.'
    : `${def.name} didn’t change any pixels on “${t.layer.name}” (is the layer empty?).`;
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
  return ok ? { ok, mode } : { ok: false, error: noChangeMessage(def, r.target) };
}
