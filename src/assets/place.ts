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
  const layer = makeRasterLayer({
    name: opts.name ?? def.name,
    bitmapId: bitmaps.add(canvas),
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
  let layer: RasterLayer | null = null;
  try {
    layer = createAssetLayer(assetId, params, doc.width, doc.height, opts);
  } catch (err) {
    console.error(`[assets] failed to generate "${assetId}"`, err);
    toast(`Could not generate “${def.name}”`, 'error');
    return null;
  }
  if (!layer) return null;
  const id = useEditor.getState().addLayer(layer, { label: `Place ${layer.name}` });
  viewport.requestRender();
  return id;
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
