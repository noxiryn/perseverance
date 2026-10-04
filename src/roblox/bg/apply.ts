/**
 * Document-level operations built on the background-removal core:
 *  - applyRemoveBackground: result as a layer mask (non-destructive, default) or deleted pixels,
 *  - selectSubject: subject selection from the active layer (or the composite) → setSelection.
 */
import type { BitmapPatch, Document, Layer, LayerMask, RasterLayer } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../../core/canvas';
import { transformMatrix } from '../../core/geometry';
import { activeDoc, activeLayer, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { selectionFromCanvas, setSelection } from '../../editor/selection';
import { renderDocument, rasterizeLayer } from '../../render/compositor';
import { viewport } from '../../editor/viewport';
import { applyMask, removeBackground, subjectMask, type BgParams } from './core';
import { requireDoc } from '../util';

export type BgOutput = 'mask' | 'delete';

/** Grayscale (opaque) canvas from a 0..255 mask: white = keep. */
export function maskToGrayCanvas(mask: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, q = 0; i < mask.length; i++, q += 4) {
    const v = mask[i];
    d[q] = d[q + 1] = d[q + 2] = v;
    d[q + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Alpha-only canvas from a 0..255 mask (selection masks use the alpha channel). */
export function maskToAlphaCanvas(mask: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, q = 3; i < mask.length; i++, q += 4) d[q] = mask[i];
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Map a layer-local keep mask into a doc-sized layer mask canvas (luminance = visibility).
 * An existing mask is multiplied in so earlier masking is preserved.
 */
export function localMaskToDocMask(doc: Document, layer: RasterLayer, mask: Uint8ClampedArray, existing: HTMLCanvasElement | null): HTMLCanvasElement {
  const out = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(out);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, out.width, out.height);
  const m = transformMatrix(layer.transform, layer.width, layer.height);
  ctx.save();
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(maskToGrayCanvas(mask, layer.width, layer.height), 0, 0);
  ctx.restore();
  if (existing) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(existing, 0, 0, out.width, out.height);
    ctx.globalCompositeOperation = 'source-over';
  }
  return out;
}

/** Run background removal on a raster layer and commit the result (one undo step). */
export function applyRemoveBackground(layerId: string, params: BgParams, output: BgOutput): boolean {
  const doc = activeDoc();
  const layer = doc?.layers[layerId];
  if (!doc || !layer || layer.type !== 'raster') {
    toast('The layer to cut out is no longer available.', 'error');
    return false;
  }
  const w = layer.width,
    h = layer.height;
  const img = bitmaps.read(layer.bitmapId, { x: 0, y: 0, width: w, height: h });
  const original = new Uint8ClampedArray(img.data);
  const { mask } = removeBackground(img, params);
  let kept = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) kept++;
  if (kept === 0) {
    toast('Everything would be removed — lower the tolerance or switch mode.', 'warning', 3600);
    return false;
  }
  if (kept === mask.length) {
    toast('No background found to remove — try Color key and click the background in the preview.', 'warning', 4200);
    return false;
  }

  const patches: BitmapPatch[] = [];
  const colorsChanged = params.decontaminate > 0 && img.data.some((v, i) => v !== original[i]);
  if (output === 'delete') applyMask(img, mask);
  if (output === 'delete' || colorsChanged) {
    patches.push(bitmaps.edit(layer.bitmapId, (ctx) => ctx.putImageData(img, 0, 0)));
  }

  const st = useEditor.getState();
  if (output === 'mask') {
    const existing = layer.mask ? bitmaps.tryGet(layer.mask.bitmapId) : null;
    const maskCanvas = localMaskToDocMask(doc, layer, mask, existing && layer.mask?.enabled !== false ? existing : null);
    const maskId = bitmaps.add(maskCanvas);
    st.commit(
      'Remove Background',
      (d) => {
        const l = d.layers[layerId] as Layer | undefined;
        if (!l) return;
        const prev = l.mask;
        const next: LayerMask = {
          bitmapId: maskId,
          enabled: true,
          density: prev?.density ?? 1,
          feather: prev?.feather ?? 0,
          inverted: false,
        };
        l.mask = next;
      },
      { patches, activeLayerId: layerId },
    );
    toast('Background hidden with a layer mask (paint the mask to refine).', 'success', 3200);
  } else {
    st.commit('Remove Background', undefined, { patches, activeLayerId: layerId });
    toast('Background removed', 'success');
  }
  viewport.requestRender();
  return true;
}

/** Subject mask of the active layer (or the composite) mapped into a doc-sized alpha canvas. */
export function subjectSelectionCanvas(doc: Document, layer: Layer | null): HTMLCanvasElement | null {
  if (layer && layer.type === 'raster' && bitmaps.has(layer.bitmapId)) {
    const img = bitmaps.read(layer.bitmapId, { x: 0, y: 0, width: layer.width, height: layer.height });
    const mask = subjectMask(img);
    const out = createCanvas(doc.width, doc.height);
    const ctx = ctx2d(out);
    const m = transformMatrix(layer.transform, layer.width, layer.height);
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(maskToAlphaCanvas(mask, layer.width, layer.height), 0, 0);
    return out;
  }
  let src: HTMLCanvasElement | null = null;
  if (layer && (layer.type === 'text' || layer.type === 'shape' || layer.type === 'group')) src = rasterizeLayer(doc, layer.id);
  if (!src) src = renderDocument(doc, { background: true });
  const ctx = ctxRead(src);
  const img = ctx.getImageData(0, 0, src.width, src.height);
  const mask = subjectMask(img);
  const alpha = maskToAlphaCanvas(mask, src.width, src.height);
  if (src.width === doc.width && src.height === doc.height) return alpha;
  const out = createCanvas(doc.width, doc.height);
  ctx2d(out).drawImage(alpha, 0, 0, doc.width, doc.height);
  return out;
}

/** Select ▸ Subject: select the main subject of the active layer. */
export function selectSubject() {
  const doc = requireDoc('select a subject');
  if (!doc) return;
  const layer = activeLayer();
  try {
    const canvas = subjectSelectionCanvas(doc, layer);
    const sel = canvas ? selectionFromCanvas(canvas) : null;
    if (!sel) {
      toast('No subject found on this layer.', 'warning');
      return;
    }
    const full = sel.bounds.width >= doc.width - 1 && sel.bounds.height >= doc.height - 1 && sel.bounds.x <= 0 && sel.bounds.y <= 0;
    setSelection(sel, 'Select Subject');
    viewport.requestOverlay();
    if (full && layer?.type === 'raster') toast('The subject fills the whole layer — use Remove Background for finer control.', 'info', 3600);
    else toast(layer && layer.type !== 'fill' && layer.type !== 'adjustment' ? `Selected the subject of “${layer.name}”` : 'Selected the subject of the image', 'success');
  } catch (err) {
    console.error('Select Subject failed', err);
    toast('Select Subject failed on this layer.', 'error');
  }
}
