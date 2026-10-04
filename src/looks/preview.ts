/**
 * Off-store look previews: renders a downscaled copy of a document with a look applied, without
 * touching the editor store or history. Overlay assets are generated at preview resolution
 * (asset generators scale with document size) and stretched to the document box.
 */
import { produce } from 'immer';
import type { Document, ID, RasterLayer } from '../core/types';
import { assets, type LookDef } from '../registry';
import { bitmaps } from '../core/bitmaps';
import { makeRasterLayer } from '../core/document';
import { resolveParams } from '../filters/engine';
import { renderDocument } from '../render/compositor';
import { buildLook, insertLookDraft, resolveTarget, type OverlayFactory } from './engine';
import { dropBitmaps, forgetLayers } from './shared';

/** Small LRU of generated overlay canvases (shared by all looks: many reuse the same assets). */
const overlayCache = new Map<string, HTMLCanvasElement>();
const OVERLAY_CACHE_MAX = 48;

function cachedOverlay(key: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
  let c = overlayCache.get(key);
  if (c) {
    overlayCache.delete(key);
    overlayCache.set(key, c);
    return c;
  }
  c = make();
  overlayCache.set(key, c);
  while (overlayCache.size > OVERLAY_CACHE_MAX) overlayCache.delete(overlayCache.keys().next().value as string);
  return c;
}

/** Overlay factory generating assets at a reduced size and scaling them up to the doc box. */
function previewOverlayFactory(genScale: number, created: ID[]): OverlayFactory {
  return (o, W, H) => {
    const def = assets.get(o.assetId);
    if (!def) return null;
    const params = resolveParams(def, o.params);
    const full =
      def.sizing === 'document' ? { width: W, height: H } : { width: def.sizing.width, height: def.sizing.height };
    const gw = Math.max(8, Math.round(full.width * genScale));
    const gh = Math.max(8, Math.round(full.height * genScale));
    const key = `${o.assetId}|${gw}x${gh}|${JSON.stringify(params)}`;
    const canvas = cachedOverlay(key, () => def.generate(params, { width: gw, height: gh }));
    const id = bitmaps.add(canvas);
    created.push(id);
    // Box center must land on the full-size box center (transforms pivot on the box center).
    const fx = def.sizing === 'document' ? 0 : (W - full.width) / 2;
    const fy = def.sizing === 'document' ? 0 : (H - full.height) / 2;
    const layer: RasterLayer = makeRasterLayer({
      name: o.name ?? def.name,
      bitmapId: id,
      width: gw,
      height: gh,
      transform: {
        x: fx + full.width / 2 - gw / 2,
        y: fy + full.height / 2 - gh / 2,
        scaleX: full.width / gw,
        scaleY: full.height / gh,
      },
    });
    layer.blendMode = o.blendMode ?? def.defaultBlendMode ?? 'normal';
    layer.opacity = o.opacity ?? def.defaultOpacity ?? 1;
    return layer;
  };
}

/**
 * Render `doc` with `look` applied (to `targetId` or the whole document) into a canvas whose
 * longest side is `size` px. Returns null if the look cannot be previewed (custom apply()).
 */
export function renderLookPreview(doc: Document, look: LookDef, targetId: ID | null, size: number): HTMLCanvasElement | null {
  if (look.apply) return null;
  const scale = Math.min(1, size / Math.max(doc.width, doc.height));
  const created: ID[] = [];
  const { targetId: tid } = resolveTarget(doc, targetId);
  // Generate overlays at ~2× the preview resolution for crisp downsampling.
  const genScale = Math.min(1, scale * 2);
  try {
    const built = buildLook(look, doc, tid, previewOverlayFactory(genScale, created));
    const lookDoc = produce(doc, (d) => {
      insertLookDraft(d, built, tid);
    });
    const out = renderDocument(lookDoc, { scale });
    forgetLayers(built.groupLayers.map((l) => l.id));
    return out;
  } finally {
    dropBitmaps(created);
  }
}

/** Same as renderLookPreview but returns a data URL (for <img>). */
export function renderLookPreviewURL(doc: Document, look: LookDef, targetId: ID | null, size: number): string | null {
  const c = renderLookPreview(doc, look, targetId, size);
  return c ? c.toDataURL('image/png') : null;
}
