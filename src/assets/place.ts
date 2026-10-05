/**
 * CONTRACT (owned by the assets module): turning library assets into layers.
 *  - createAssetLayer: PURE (no store access) — generates the bitmap, registers it in the bitmap
 *    store and returns a RasterLayer with `generator = { kind: 'asset:<id>', params }` so it can
 *    be regenerated later. Used by templates/looks that build documents directly.
 *  - placeAsset: adds the asset as a new layer to the ACTIVE document (one history step).
 *  - regenerateAssetLayer: re-renders an asset layer with new params (one history step).
 */
import type { BlendMode, ID, ParamValues, Point, RasterLayer } from '../core/types';
import type { AssetDef } from '../registry';
import { assets } from '../registry';
import { bitmaps } from '../core/bitmaps';
import { makeRasterLayer } from '../core/document';
import { resolveParams } from '../filters/engine';
import { activeDoc, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { assetMeta } from './lib/params';
import { assetFontsReady, loadAssetFonts } from './lib/fonts';
import { MAX_ADAPTED_COVERAGE, adaptToBackdrop, meanAlpha, meanLuminance } from './lib/backdrop';
import { renderThumbnail } from '../render/compositor';
import { ctxRead } from '../core/canvas';
import { parseColor } from '../core/color';
import type { Document } from '../core/types';

export interface AssetLayerOptions {
  name?: string;
  blendMode?: BlendMode;
  opacity?: number;
  /** For element assets: position (top-left) and size override in document px. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Category of user-imported images (see userAssets.ts). */
export const USER_CATEGORY = 'My Assets';
/** Fraction of the document a user image is fitted into when placed. */
export const USER_FIT = 0.6;

/** Size that fits (w, h) inside (bw, bh) keeping the aspect ratio. Pure. */
export function fitSize(w: number, h: number, bw: number, bh: number): { width: number; height: number } {
  const s = Math.min(bw / Math.max(1, w), bh / Math.max(1, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Pixel size an asset is generated at for a document of docWidth × docHeight. Pure. */
export function assetLayerSize(def: AssetDef, docWidth: number, docHeight: number, opts: AssetLayerOptions = {}): { width: number; height: number } {
  if (def.sizing === 'document') return { width: Math.round(docWidth), height: Math.round(docHeight) };
  if (opts.width && opts.height) return { width: Math.round(opts.width), height: Math.round(opts.height) };
  if (def.category === USER_CATEGORY) return fitSize(def.sizing.width, def.sizing.height, docWidth * USER_FIT, docHeight * USER_FIT);
  const { width, height } = def.sizing;
  // stickers keep their native size unless that would cover more than ~55% of the document
  const fit = Math.min(1, (docWidth * 0.55) / width, (docHeight * 0.55) / height);
  return { width: Math.max(1, Math.round(width * fit)), height: Math.max(1, Math.round(height * fit)) };
}

/** True when the asset draws text (its first render may use fallback fonts until they load). */
export function assetNeedsFonts(assetId: string): boolean {
  return !!assetMeta.get(assetId)?.fonts;
}

/** True when the asset renders at full quality right now (fonts loaded, source decoded). */
export function assetReady(assetId: string): boolean {
  const m = assetMeta.get(assetId);
  if (m?.fonts && !assetFontsReady()) return false;
  return m?.isReady ? m.isReady() : true;
}

/**
 * Await everything an asset needs to render faithfully (the fonts of text-drawing assets, the
 * full-resolution decode of user images). Template/look builders may call it before
 * `createAssetLayer`. Never rejects.
 */
export function prepareAsset(assetId: string): Promise<void> {
  const m = assetMeta.get(assetId);
  const jobs: Promise<unknown>[] = [];
  if (m?.fonts) jobs.push(loadAssetFonts());
  if (m?.prepare && !(m.isReady?.() ?? false)) jobs.push(m.prepare().catch(() => undefined));
  return jobs.length ? Promise.all(jobs).then(() => undefined) : Promise.resolve();
}

/**
 * An asset rendered before it was ready (fallback fonts, preview-resolution user image) is
 * re-rendered into the SAME bitmap once it is, unless the bitmap was edited meanwhile (the
 * bitmap is brand new and owned by the asset layer, so this only corrects its initial content).
 */
function refreshWhenReady(assetId: string, params: ParamValues, bitmapId: ID) {
  if (assetReady(assetId)) return;
  const v = bitmaps.version(bitmapId);
  void prepareAsset(assetId).then(() => {
    const c = bitmaps.tryGet(bitmapId);
    const def = assets.get(assetId);
    if (!c || !def || bitmaps.version(bitmapId) !== v || !assetReady(assetId)) return;
    try {
      const fresh = def.generate(params, { width: c.width, height: c.height });
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(fresh, 0, 0, c.width, c.height);
      bitmaps.touch(bitmapId);
      viewport.requestRender();
    } catch (err) {
      console.error(`[assets] refresh of "${assetId}" failed`, err);
    }
  });
}

export function createAssetLayer(
  assetId: string,
  params: ParamValues | undefined,
  docWidth: number,
  docHeight: number,
  opts: AssetLayerOptions = {},
): RasterLayer | null {
  const def = assets.get(assetId);
  if (!def) return null;
  const p = resolveParams(def, params);
  const size = assetLayerSize(def, docWidth, docHeight, opts);
  const canvas = def.generate(p, size);
  const bitmapId = bitmaps.add(canvas);
  refreshWhenReady(assetId, p, bitmapId);
  const layer = makeRasterLayer({
    name: opts.name ?? def.name,
    bitmapId,
    width: canvas.width,
    height: canvas.height,
    transform:
      def.sizing === 'document'
        ? { x: 0, y: 0 }
        : { x: opts.x ?? Math.round((docWidth - canvas.width) / 2), y: opts.y ?? Math.round((docHeight - canvas.height) / 2) },
  });
  // imported images are plain pixels: nothing to regenerate (and the source may be deleted later)
  layer.generator = def.category === USER_CATEGORY ? null : { kind: `asset:${assetId}`, params: p };
  layer.blendMode = opts.blendMode ?? def.defaultBlendMode ?? 'normal';
  layer.opacity = opts.opacity ?? def.defaultOpacity ?? 1;
  return layer;
}

export function placeAsset(assetId: string, params?: ParamValues, opts: AssetLayerOptions = {}): ID | null {
  const doc = activeDoc();
  if (!doc) {
    toast('Open or create a document to place assets', 'info');
    return null;
  }
  const def = assets.get(assetId);
  if (!def) {
    toast('That asset is no longer available', 'warning');
    return null;
  }
  // Light-only blends (Screen…) can't show on a light canvas: light overlays with a dark-on-light
  // variant are placed in Multiply with a dark color instead (see lib/backdrop.ts).
  const blend = opts.blendMode ?? def.defaultBlendMode ?? 'normal';
  const size = assetLayerSize(def, doc.width, doc.height, opts);
  const box =
    def.sizing === 'document'
      ? { x: 0, y: 0, width: doc.width, height: doc.height }
      : { x: opts.x ?? (doc.width - size.width) / 2, y: opts.y ?? (doc.height - size.height) / 2, width: size.width, height: size.height };
  let adapt =
    blend === (def.defaultBlendMode ?? 'normal')
      ? adaptToBackdrop(def, resolveParams(def, params), blend, backdropLuminance(doc, box), assetMeta.get(assetId)?.onLight)
      : null;
  let layer: RasterLayer | null = null;
  try {
    if (adapt?.changed) {
      layer = createAssetLayer(assetId, adapt.params, doc.width, doc.height, { ...opts, blendMode: adapt.blendMode });
      // A mostly opaque result (dense fog, an opaque base turned back on…) would darken the whole
      // canvas in Multiply instead of adding dark detail: place it as asked and hint instead.
      if (layer && layerCoverage(layer) > MAX_ADAPTED_COVERAGE) {
        layer = null; // its unreferenced bitmap is collected by the store's GC
        adapt = { ...adapt, changed: false, invisible: true };
      }
    }
    if (!layer) layer = createAssetLayer(assetId, params, doc.width, doc.height, opts);
  } catch (err) {
    console.error(`[assets] failed to generate "${assetId}"`, err);
    toast(`Could not generate “${def.name}”`, 'error');
    return null;
  }
  if (!layer) return null;
  const id = useEditor.getState().addLayer(layer, { label: `Place ${layer.name}` });
  viewport.requestRender();
  const blendName = blend.replace(/(^|-)(\w)/g, (_m, sep: string, c: string) => (sep ? ' ' : '') + c.toUpperCase());
  if (adapt?.changed)
    toast(
      `“${def.name}” uses ${blendName} by default, which can't show on a light background — placed in Multiply with a darker color${adapt.note ? ` ${adapt.note}` : ''} (switch the layer back to ${blendName} on dark backgrounds).`,
      'info',
      5200,
    );
  else if (adapt?.invisible) toast(`“${def.name}” is in ${blendName} mode, which doesn't show on a light background — place it over a darker area or try Multiply with a darker color.`, 'info', 4600);
  return id;
}

/** Mean alpha (0..1) of a generated layer, measured on a small downscale. */
function layerCoverage(layer: RasterLayer): number {
  const src = bitmaps.get(layer.bitmapId);
  if (!src) return 0;
  const s = Math.min(1, 128 / Math.max(1, layer.width, layer.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(layer.width * s));
  c.height = Math.max(1, Math.round(layer.height * s));
  const ctx = ctxRead(c);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return meanAlpha(ctx.getImageData(0, 0, c.width, c.height).data);
}

/** Mean luminance (0..1) of the current composite inside a doc-space box (low-res render), or null. */
function backdropLuminance(doc: Document, box: { x: number; y: number; width: number; height: number }): number | null {
  try {
    const thumb = renderThumbnail(doc, null, 96);
    const sx = thumb.width / doc.width,
      sy = thumb.height / doc.height;
    const x0 = Math.max(0, Math.floor(box.x * sx)),
      y0 = Math.max(0, Math.floor(box.y * sy));
    const x1 = Math.min(thumb.width, Math.ceil((box.x + box.width) * sx)),
      y1 = Math.min(thumb.height, Math.ceil((box.y + box.height) * sy));
    if (x1 <= x0 || y1 <= y0) return null;
    // Transparent areas show the document background color (exports) — or nothing: count as dark.
    const bg = doc.background ? parseColor(doc.background) : null;
    const fallback = bg ? (0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b) / 255 : 0;
    return meanLuminance(ctxRead(thumb).getImageData(x0, y0, x1 - x0, y1 - y0).data, fallback);
  } catch {
    return null;
  }
}

/**
 * `placeAsset` after `prepareAsset` (fonts loaded / user image decoded), so the layer is right
 * from its first frame. Used by the library UI; resolves to the new layer id or null.
 */
export async function placeAssetWhenReady(assetId: string, params?: ParamValues, opts: AssetLayerOptions = {}, at?: Point | null): Promise<ID | null> {
  if (!activeDoc()) return placeAsset(assetId, params, opts); // toasts the helpful message
  if (!assetReady(assetId)) await prepareAsset(assetId);
  return at ? placeAssetAt(assetId, params, at, opts) : placeAsset(assetId, params, opts);
}

/**
 * Place an asset centered on a document point (drag & drop). Document-sized assets ignore the
 * point and cover the canvas.
 */
export function placeAssetAt(assetId: string, params: ParamValues | undefined, at: Point | null, opts: AssetLayerOptions = {}): ID | null {
  const doc = activeDoc();
  const def = assets.get(assetId);
  if (!doc || !def || def.sizing === 'document' || !at) return placeAsset(assetId, params, opts);
  const size = assetLayerSize(def, doc.width, doc.height, opts);
  return placeAsset(assetId, params, {
    ...opts,
    width: size.width,
    height: size.height,
    x: Math.round(at.x - size.width / 2),
    y: Math.round(at.y - size.height / 2),
  });
}

/** Asset id of a generated layer, or null. */
export function assetIdOfLayer(l: { type: string; generator?: { kind: string } | null } | undefined | null): string | null {
  if (!l || l.type !== 'raster') return null;
  const k = l.generator?.kind;
  return k && k.startsWith('asset:') ? k.slice(6) : null;
}

/** Render a new bitmap for an asset layer (optionally at reduced quality for live previews). */
export function renderAssetBitmap(assetId: string, params: ParamValues, width: number, height: number, previewScale = 1): HTMLCanvasElement | null {
  const def = assets.get(assetId);
  if (!def) return null;
  const p = resolveParams(def, params);
  if (previewScale >= 0.999) return def.generate(p, { width, height });
  const lo = def.generate(p, { width: Math.max(1, Math.round(width * previewScale)), height: Math.max(1, Math.round(height * previewScale)) });
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return lo;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(lo, 0, 0, width, height);
  return c;
}

export function regenerateAssetLayer(layerId: ID, params: ParamValues): void {
  const doc = activeDoc();
  const l = doc?.layers[layerId];
  const assetId = assetIdOfLayer(l);
  if (!doc || !l || l.type !== 'raster' || !assetId) return;
  const def = assets.get(assetId);
  if (!def) {
    toast('The asset used by this layer is not available', 'warning');
    return;
  }
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = renderAssetBitmap(assetId, params, l.width, l.height);
  } catch (err) {
    console.error(`[assets] failed to regenerate "${assetId}"`, err);
    toast(`Could not regenerate “${def.name}”`, 'error');
    return;
  }
  if (!canvas) return;
  const bitmapId = bitmaps.add(canvas);
  const p = resolveParams(def, params);
  refreshWhenReady(assetId, p, bitmapId);
  useEditor.getState().updateLayer<RasterLayer>(
    layerId,
    (d) => {
      d.bitmapId = bitmapId;
      d.width = canvas.width;
      d.height = canvas.height;
      d.generator = { kind: `asset:${assetId}`, params: p };
    },
    'Edit Asset',
  );
  viewport.requestRender();
}
