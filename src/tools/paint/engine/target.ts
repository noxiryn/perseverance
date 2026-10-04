/**
 * Paint target resolution: which bitmap a paint tool writes into, how document coordinates map
 * onto it, and what constrains it (selection, lock transparency). Handles every "can't paint
 * here" case with a helpful toast, and offers to rasterize text/shape/fill layers.
 */
import type { Document, ID, Layer, RasterLayer } from '../../../core/types';
import { bitmaps } from '../../../core/bitmaps';
import { createCanvas, ctx2d } from '../../../core/canvas';
import { luminance, parseColor, toHex } from '../../../core/color';
import { transformMatrix } from '../../../core/geometry';
import { isEffectivelyVisible, makeRasterLayer } from '../../../core/document';
import { getSelectionMask } from '../../../editor/selection';
import { renderLayerToDoc } from '../../../render/compositor';
import { activeSession, useEditor } from '../../../state/editor';
import { openDialog, toast } from '../../../state/ui';
import { RasterizeDialog } from '../ui/RasterizeDialog';

export interface PaintTarget {
  docId: ID;
  layerId: ID;
  layerName: string;
  kind: 'content' | 'mask';
  bitmapId: ID;
  /** Live bitmap canvas. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** doc → bitmap-local (null = identity). */
  toLocal: DOMMatrix | null;
  /** bitmap-local → doc (null = identity). */
  toDoc: DOMMatrix | null;
  /** Preserve existing alpha while painting. */
  lockTransparency: boolean;
  /** Selection mask in bitmap-local space (alpha = selected), or null when nothing is selected. */
  selection: HTMLCanvasElement | null;
}

const KIND_NAMES: Record<Layer['type'], string> = {
  raster: 'pixel',
  text: 'text',
  shape: 'shape',
  fill: 'fill',
  adjustment: 'adjustment',
  group: 'group',
};

function isIdentity(m: DOMMatrix): boolean {
  return Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.e) < 1e-9 && Math.abs(m.f) < 1e-9;
}

/** Matrices for a raster layer (null when identity). */
export function layerMatrices(l: RasterLayer): { toDoc: DOMMatrix | null; toLocal: DOMMatrix | null } {
  const m = transformMatrix(l.transform, l.width, l.height);
  if (isIdentity(m)) return { toDoc: null, toLocal: null };
  return { toDoc: m, toLocal: m.inverse() };
}

let selCache: { key: string; canvas: HTMLCanvasElement } | null = null;

/** The document selection mapped into the target's local space (cached per selection/transform). */
export function selectionInLocal(doc: Document, width: number, height: number, toLocal: DOMMatrix | null): HTMLCanvasElement | null {
  const mask = getSelectionMask(doc);
  if (!mask || !doc.selection) return null;
  if (!toLocal && mask.width === width && mask.height === height) return mask;
  const key = [doc.selection.bitmapId, bitmaps.version(doc.selection.bitmapId), width, height, toLocal ? [toLocal.a, toLocal.b, toLocal.c, toLocal.d, toLocal.e, toLocal.f].join(',') : 'id'].join('|');
  if (selCache?.key === key) return selCache.canvas;
  const c = createCanvas(width, height);
  const ctx = ctx2d(c);
  if (toLocal) ctx.setTransform(toLocal.a, toLocal.b, toLocal.c, toLocal.d, toLocal.e, toLocal.f);
  ctx.drawImage(mask, 0, 0);
  selCache = { key, canvas: c };
  return c;
}

export interface ResolveOptions {
  /** Tool name for messages ("Brush", "Eraser"…). */
  toolName: string;
  /** Offer the rasterize dialog for text/shape/fill layers (default true). */
  offerRasterize?: boolean;
  /** Skip the hidden-layer check. */
  allowHidden?: boolean;
}

/** Common pre-checks: open document + active layer. */
export function requireLayer(toolName: string): { doc: Document; layer: Layer } | null {
  const s = activeSession();
  if (!s) {
    toast(`${toolName}: open or create a document first`, 'info');
    return null;
  }
  const layer = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!layer) {
    toast(`${toolName}: select a layer to paint on`, 'warning');
    return null;
  }
  return { doc: s.doc, layer };
}

/**
 * Resolve the bitmap the tool should paint into. Returns null (after telling the user why) when
 * painting isn't possible right now.
 */
export function resolvePaintTarget(opts: ResolveOptions): PaintTarget | null {
  const s = activeSession();
  const req = requireLayer(opts.toolName);
  if (!s || !req) return null;
  const { doc, layer } = req;

  if (layer.locks.all) {
    toast(`${opts.toolName}: “${layer.name}” is locked`, 'warning');
    return null;
  }
  if (!opts.allowHidden && !isEffectivelyVisible(doc, layer.id)) {
    toast(`${opts.toolName}: the target layer “${layer.name}” is hidden`, 'warning');
    return null;
  }

  // Painting on a layer mask (any layer type can carry one).
  if (s.editTarget === 'mask' && layer.mask) {
    const canvas = bitmaps.tryGet(layer.mask.bitmapId);
    if (!canvas) {
      toast(`${opts.toolName}: the layer mask is missing`, 'error');
      return null;
    }
    return {
      docId: doc.id,
      layerId: layer.id,
      layerName: layer.name,
      kind: 'mask',
      bitmapId: layer.mask.bitmapId,
      canvas,
      width: canvas.width,
      height: canvas.height,
      toLocal: canvas.width === doc.width && canvas.height === doc.height ? null : new DOMMatrix().scaleSelf(canvas.width / doc.width, canvas.height / doc.height),
      toDoc: canvas.width === doc.width && canvas.height === doc.height ? null : new DOMMatrix().scaleSelf(doc.width / canvas.width, doc.height / canvas.height),
      lockTransparency: false,
      selection: selectionInLocal(doc, canvas.width, canvas.height, canvas.width === doc.width ? null : new DOMMatrix().scaleSelf(canvas.width / doc.width, canvas.height / doc.height)),
    };
  }

  if (layer.locks.pixels) {
    toast(`${opts.toolName}: “${layer.name}” has locked pixels`, 'warning');
    return null;
  }

  if (layer.type === 'raster') {
    const canvas = bitmaps.tryGet(layer.bitmapId);
    if (!canvas) {
      toast(`${opts.toolName}: the layer's pixels are missing`, 'error');
      return null;
    }
    const { toDoc, toLocal } = layerMatrices(layer);
    return {
      docId: doc.id,
      layerId: layer.id,
      layerName: layer.name,
      kind: 'content',
      bitmapId: layer.bitmapId,
      canvas,
      width: canvas.width,
      height: canvas.height,
      toLocal,
      toDoc,
      lockTransparency: layer.locks.transparency,
      selection: selectionInLocal(doc, canvas.width, canvas.height, toLocal),
    };
  }

  if (layer.type === 'text' || layer.type === 'shape' || layer.type === 'fill') {
    if (opts.offerRasterize !== false) void offerRasterize(layer.id, opts.toolName);
    else toast(`${opts.toolName}: rasterize the ${KIND_NAMES[layer.type]} layer first`, 'warning');
    return null;
  }

  toast(
    `${opts.toolName}: ${KIND_NAMES[layer.type]} layers have no pixels — select a pixel layer${layer.type === 'adjustment' ? ' or edit its mask' : ''}`,
    'warning',
  );
  return null;
}

let rasterizeOpen = false;

/** Ask to rasterize a text/shape/fill layer; replaces it in place with a raster layer. */
export async function offerRasterize(layerId: ID, toolName: string): Promise<boolean> {
  if (rasterizeOpen) return false;
  const doc = activeSession()?.doc;
  const layer = doc?.layers[layerId];
  if (!doc || !layer) return false;
  rasterizeOpen = true;
  try {
    const ok = await openDialog<boolean, { layerName: string; kind: string; toolName: string }>(RasterizeDialog, {
      layerName: layer.name,
      kind: KIND_NAMES[layer.type],
      toolName,
    });
    if (!ok) return false;
    return rasterizeInPlace(layerId);
  } finally {
    rasterizeOpen = false;
  }
}

/** Replace a layer with a doc-sized raster layer of its rendered content (keeps id, effects, mask). */
export function rasterizeInPlace(layerId: ID): boolean {
  const s = activeSession();
  const doc = s?.doc;
  const layer = doc?.layers[layerId];
  if (!doc || !layer || layer.type === 'raster' || layer.type === 'group' || layer.type === 'adjustment') return false;
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = renderLayerToDoc(doc, layer, { effects: false, mask: false });
  } catch (err) {
    console.error('[paint] rasterize failed', err);
  }
  const out = createCanvas(doc.width, doc.height);
  if (canvas) ctx2d(out).drawImage(canvas, 0, 0, doc.width, doc.height);
  const bitmapId = bitmaps.add(out);
  const raster = makeRasterLayer({ name: layer.name, bitmapId, width: doc.width, height: doc.height });
  const replacement: RasterLayer = {
    ...raster,
    id: layer.id,
    visible: layer.visible,
    locks: { ...layer.locks },
    opacity: layer.opacity,
    fillOpacity: layer.fillOpacity,
    blendMode: layer.blendMode,
    clipped: layer.clipped,
    mask: layer.mask,
    effects: layer.effects,
    // Smart filters are baked into the rendered pixels.
    filters: [],
    label: layer.label,
    meta: layer.meta,
  };
  useEditor.getState().commit('Rasterize Layer', (d) => {
    d.layers[layer.id] = replacement;
  });
  toast(`Rasterized “${layer.name}” — paint away`, 'success');
  return true;
}

/** Gray (mask) version of a color: luminance → #vvvvvv. */
export function maskGray(color: string): string {
  const c = parseColor(color);
  const v = luminance(c.r, c.g, c.b);
  return toHex({ r: v, g: v, b: v });
}

/** Color to paint with on a target (masks paint grayscale). */
export function paintColorFor(target: PaintTarget, color: string): string {
  return target.kind === 'mask' ? maskGray(color) : color;
}

/** Map a document point into the target's local space. */
export function docToLocal(target: PaintTarget, x: number, y: number): { x: number; y: number } {
  const m = target.toLocal;
  if (!m) return { x, y };
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** True when the target still exists in the active document (stroke may be finalized). */
export function targetStillValid(t: PaintTarget): boolean {
  const s = useEditor.getState();
  if (s.activeDocId !== t.docId) return false;
  return bitmaps.tryGet(t.bitmapId) === t.canvas;
}
