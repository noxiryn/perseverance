/**
 * CONTRACT (owned by the assets module): turning library assets into layers.
 *  - createAssetLayer: PURE (no store access) — generates the bitmap, registers it in the bitmap
 *    store and returns a RasterLayer with `generator = { kind: 'asset:<id>', params }` so it can
 *    be regenerated later. Used by templates/looks that build documents directly.
 *  - placeAsset: adds the asset as a new layer to the ACTIVE document (one history step).
 *  - regenerateAssetLayer: re-renders an asset layer with new params (one history step).
 */
import type { BlendMode, ID, ParamValues, RasterLayer } from '../core/types';
import { assets } from '../registry';
import { bitmaps } from '../core/bitmaps';
import { makeRasterLayer } from '../core/document';
import { resolveParams } from '../filters/engine';
import { activeDoc, useEditor } from '../state/editor';

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
  const size =
    def.sizing === 'document'
      ? { width: docWidth, height: docHeight }
      : { width: opts.width ?? def.sizing.width, height: opts.height ?? def.sizing.height };
  const canvas = def.generate(p, size);
  const layer = makeRasterLayer({
    name: opts.name ?? def.name,
    bitmapId: bitmaps.add(canvas),
    width: canvas.width,
    height: canvas.height,
    transform:
      def.sizing === 'document'
        ? { x: 0, y: 0 }
        : { x: opts.x ?? (docWidth - canvas.width) / 2, y: opts.y ?? (docHeight - canvas.height) / 2 },
  });
  layer.generator = { kind: `asset:${assetId}`, params: p };
  layer.blendMode = opts.blendMode ?? def.defaultBlendMode ?? 'normal';
  layer.opacity = opts.opacity ?? def.defaultOpacity ?? 1;
  return layer;
}

export function placeAsset(assetId: string, params?: ParamValues, opts: AssetLayerOptions = {}): ID | null {
  const doc = activeDoc();
  if (!doc) return null;
  const layer = createAssetLayer(assetId, params, doc.width, doc.height, opts);
  if (!layer) return null;
  return useEditor.getState().addLayer(layer, { label: `Place ${layer.name}` });
}

export function regenerateAssetLayer(layerId: ID, params: ParamValues): void {
  const doc = activeDoc();
  const l = doc?.layers[layerId];
  if (!doc || !l || l.type !== 'raster' || !l.generator?.kind.startsWith('asset:')) return;
  const assetId = l.generator.kind.slice(6);
  const next = createAssetLayer(assetId, params, doc.width, doc.height, { width: l.width, height: l.height });
  if (!next) return;
  useEditor.getState().updateLayer<RasterLayer>(
    layerId,
    (d) => {
      d.bitmapId = next.bitmapId;
      d.width = next.width;
      d.height = next.height;
      d.generator = next.generator;
    },
    'Edit Asset',
  );
}
