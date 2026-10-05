/**
 * Off-store look previews: renders a downscaled copy of a document with a look applied, without
 * touching the editor store or history. Overlay assets are generated at preview resolution
 * (asset generators scale with document size) and stretched to the document box.
 *
 * Looks that leave the target layer alone (only textures/grades in the look group) are rendered
 * on top of a cached "base" composite of the document (one small raster), so a batch of previews
 * costs one full composite plus a few tiny blends per look.
 */
import { produce } from 'immer';
import type { Document, ID, Layer, RasterLayer } from '../core/types';
import { assets, type LookDef } from '../registry';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeRasterLayer } from '../core/document';
import { resolveParams } from '../filters/engine';
import { renderDocument } from '../render/compositor';
import { buildLook, insertLookDraft, resolveTarget, stripLookDraft, type OverlayFactory } from './engine';
import { dropBitmaps } from './shared';

/* ------------------------------------------------------------------ */
/* Content signature                                                   */
/* ------------------------------------------------------------------ */

const objIds = new WeakMap<object, number>();
let nextObjId = 1;
function oid(o: object): number {
  let v = objIds.get(o);
  if (!v) {
    v = nextObjId++;
    objIds.set(o, v);
  }
  return v;
}

/**
 * Signature of everything that affects how a document renders: layer table + order identity
 * (immer keeps them when only the selection/guides change), size, background, and the pixel
 * versions of referenced bitmaps (paint strokes and their undo change pixels, not the document).
 */
export function contentSignature(doc: Document): string {
  let h = 2166136261;
  const mix = (n: number) => {
    h = Math.imul(h ^ n, 16777619) >>> 0;
  };
  for (const l of Object.values(doc.layers)) {
    if (l.type === 'raster') mix(bitmaps.version(l.bitmapId));
    if (l.mask) mix(bitmaps.version(l.mask.bitmapId) + 7919);
  }
  return `${oid(doc.layers)}.${oid(doc.rootIds)}.${doc.width}x${doc.height}.${doc.background ?? '-'}.${h.toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* Overlays at preview resolution                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Base composite                                                      */
/* ------------------------------------------------------------------ */

interface Base {
  key: string;
  canvas: HTMLCanvasElement;
  layer: RasterLayer;
}

/** Last base composites (one per document/target in use). */
const bases: Base[] = [];
const BASES_MAX = 2;

/** The document without its current look, rendered at `scale`, as a raster layer in doc space. */
function baseFor(doc: Document, targetId: ID | null, scale: number): Base {
  const key = `${doc.id}|${contentSignature(doc)}|${targetId ?? '*'}|${scale.toFixed(5)}`;
  const hit = bases.find((b) => b.key === key);
  if (hit) {
    // The editor's bitmap GC may have collected it (it isn't referenced by any document).
    if (!bitmaps.has(hit.layer.bitmapId)) bitmaps.add(hit.canvas, hit.layer.bitmapId);
    return hit;
  }
  const stripped = produce(doc, (d) => {
    stripLookDraft(d, targetId);
  });
  const canvas = renderDocument(stripped, { scale });
  const layer = makeRasterLayer({
    name: 'Base',
    bitmapId: bitmaps.add(canvas),
    width: canvas.width,
    height: canvas.height,
    transform: {
      x: doc.width / 2 - canvas.width / 2,
      y: doc.height / 2 - canvas.height / 2,
      scaleX: doc.width / canvas.width,
      scaleY: doc.height / canvas.height,
    },
  });
  const base: Base = { key, canvas, layer };
  // Replace a stale base of the same document/target; keep at most BASES_MAX.
  const prefix = `${doc.id}|`;
  const tgt = `|${targetId ?? '*'}|`;
  const same = bases.findIndex((b) => b.key.startsWith(prefix) && b.key.includes(tgt));
  if (same >= 0) dropBitmaps([bases.splice(same, 1)[0].layer.bitmapId]);
  bases.unshift(base);
  while (bases.length > BASES_MAX) dropBitmaps([bases.pop()!.layer.bitmapId]);
  return base;
}

/** Forget cached base composites (e.g. when previews are turned off). */
export function clearLookPreviewBases() {
  dropBitmaps(bases.map((b) => b.layer.bitmapId));
  bases.length = 0;
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

function maskIds(layers: Layer[]): ID[] {
  return layers.flatMap((l) => (l.mask ? [l.mask.bitmapId] : []));
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
  let built: ReturnType<typeof buildLook> | null = null;
  try {
    built = buildLook(look, doc, tid, previewOverlayFactory(genScale, created), { maskScale: genScale });
    const bl = built;
    if (!bl.filters.length && !bl.effects.length) {
      // Target untouched: composite the look group over the cached base render.
      const base = baseFor(doc, tid, scale);
      const mini = createDocument({ name: 'Look preview', width: doc.width, height: doc.height, background: null });
      insertLayerDraft(mini, base.layer, { parentId: null });
      for (const l of bl.groupLayers) insertLayerDraft(mini, l, { parentId: null });
      return renderDocument(mini, { scale });
    }
    const lookDoc = produce(doc, (d) => {
      insertLookDraft(d, bl, tid);
    });
    return renderDocument(lookDoc, { scale });
  } finally {
    dropBitmaps(built ? [...created, ...maskIds(built.groupLayers)] : created);
  }
}

/** Same as renderLookPreview but returns a data URL (for <img>). */
export function renderLookPreviewURL(doc: Document, look: LookDef, targetId: ID | null, size: number): string | null {
  const c = renderLookPreview(doc, look, targetId, size);
  return c ? c.toDataURL('image/png') : null;
}
