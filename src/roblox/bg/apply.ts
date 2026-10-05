/**
 * Document-level operations built on the background-removal core:
 *  - applyRemoveBackground: result as deleted pixels (default: the layer is also trimmed to the
 *    character, so character styles see a real cut-out and the transform box hugs the subject)
 *    or as a non-destructive layer mask (tagged in layer.meta so styles/looks can bake it first),
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
import { applyMask, maskChangeBounds, removeBackground, subjectMask, unionRect, type BgParams } from './core';
import { requireDoc } from '../util';
import { CUTOUT_MASK_KEY, trimRasterLayer } from '../character/cutout';

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
 * Visibility of an existing layer mask as a doc-sized grayscale canvas, with its inversion,
 * density and feather baked in (so it can be combined with a new mask that uses neutral settings).
 */
export function bakedMaskVisibility(mask: LayerMask, src: HTMLCanvasElement, docW: number, docH: number): HTMLCanvasElement {
  const c = createCanvas(docW, docH);
  const ctx = ctxRead(c);
  ctx.drawImage(src, 0, 0, docW, docH);
  const img = ctx.getImageData(0, 0, docW, docH);
  const d = img.data;
  const density = Number.isFinite(mask.density) ? Math.max(0, Math.min(1, mask.density)) : 1;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const l = mask.inverted ? 255 - i : i;
    lut[i] = Math.round(255 - density * (255 - l));
  }
  for (let q = 0; q < d.length; q += 4) {
    const a = d[q + 3];
    const lum = a === 255 ? d[q] : (d[q] * a) / 255;
    const v = lut[lum | 0];
    d[q] = d[q + 1] = d[q + 2] = v;
    d[q + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const feather = Math.max(0, Number(mask.feather) || 0);
  if (feather <= 0.05) return c;
  // Feather at render time is a gaussian (sigma = feather / 2) with edge-clamped surroundings.
  const m = Math.ceil(feather * 1.5) + 2;
  const ext = createCanvas(docW + 2 * m, docH + 2 * m);
  const ectx = ctx2d(ext);
  ectx.drawImage(c, m, m);
  ectx.drawImage(c, 0, 0, 1, docH, 0, m, m, docH);
  ectx.drawImage(c, docW - 1, 0, 1, docH, docW + m, m, m, docH);
  ectx.drawImage(ext, 0, m, docW + 2 * m, 1, 0, 0, docW + 2 * m, m);
  ectx.drawImage(ext, 0, docH + m - 1, docW + 2 * m, 1, 0, docH + m, docW + 2 * m, m);
  const out = createCanvas(docW, docH);
  const octx = ctx2d(out);
  octx.filter = `blur(${feather / 2}px)`;
  octx.drawImage(ext, -m, -m);
  octx.filter = 'none';
  return out;
}

/**
 * Map a layer-local keep mask into a doc-sized layer mask canvas (luminance = visibility).
 * An enabled existing mask is multiplied in (with its invert/density/feather baked) so earlier
 * masking is preserved; the result is meant for a mask with neutral settings.
 */
export function localMaskToDocMask(doc: Document, layer: RasterLayer, mask: Uint8ClampedArray, existing: { mask: LayerMask; canvas: HTMLCanvasElement } | null): HTMLCanvasElement {
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
    ctx.drawImage(bakedMaskVisibility(existing.mask, existing.canvas, doc.width, doc.height), 0, 0);
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
  if (layer.locks.all || layer.locks.pixels) {
    toast(`“${layer.name}” has locked pixels — unlock them to remove the background.`, 'warning', 3600);
    return false;
  }
  const w = layer.width,
    h = layer.height;
  const img = bitmaps.read(layer.bitmapId, { x: 0, y: 0, width: w, height: h });
  const { mask, decontaminated } = removeBackground(img, params);
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

  const st = useEditor.getState();
  if (output === 'delete') {
    applyMask(img, mask);
    // Trim to the character so its transform box hugs it (generated layers keep their box —
    // their generator placement depends on it).
    const trimmed = layer.generator ? null : trimRasterLayer(layer, img);
    if (trimmed) {
      st.commit(
        'Remove Background',
        (d) => {
          const l = d.layers[layerId];
          if (!l || l.type !== 'raster') return;
          l.bitmapId = trimmed.bitmapId;
          l.width = trimmed.width;
          l.height = trimmed.height;
          l.transform = trimmed.transform;
        },
        { activeLayerId: layerId },
      );
      toast('Background removed — the layer was trimmed to your character.', 'success', 3000);
      viewport.requestRender();
      return true;
    }
  }

  // Only the touched area is written and recorded for undo.
  const patches: BitmapPatch[] = [];
  let dirty = decontaminated.rect;
  if (output === 'delete') dirty = unionRect(dirty, maskChangeBounds(mask, w, h));
  if (dirty) {
    const r = dirty;
    patches.push(
      bitmaps.edit(
        layer.bitmapId,
        (ctx) => {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.putImageData(img, 0, 0, r.x, r.y, r.width, r.height);
        },
        r,
      ),
    );
  }

  if (output === 'mask') {
    const prev = layer.mask ?? null;
    const prevCanvas = prev ? bitmaps.tryGet(prev.bitmapId) : null;
    const combine = prev && prevCanvas && prev.enabled !== false ? { mask: prev, canvas: prevCanvas } : null;
    const replacedDisabled = !!prev && prev.enabled === false;
    const maskCanvas = localMaskToDocMask(doc, layer, mask, combine);
    const maskId = bitmaps.add(maskCanvas);
    st.commit(
      'Remove Background',
      (d) => {
        const l = d.layers[layerId] as Layer | undefined;
        if (!l) return;
        // Earlier masking (incl. invert/density/feather) is baked into the new bitmap.
        const next: LayerMask = { bitmapId: maskId, enabled: true, density: 1, feather: 0, inverted: false };
        l.mask = next;
        // Tagged so the Character Styler / Looks know this mask is a cut-out and apply it first
        // (smart filters run before the mask and would otherwise see the hidden background).
        l.meta = { ...(l.meta ?? {}), [CUTOUT_MASK_KEY]: maskId };
      },
      { patches, activeLayerId: layerId },
    );
    toast(
      replacedDisabled
        ? 'Background hidden with a new layer mask — it replaced the disabled mask (Undo restores it).'
        : decontaminated.changed
          ? 'Background hidden with a layer mask; edge colors were decontaminated.'
          : 'Background hidden with a layer mask (paint the mask to refine). Character styles apply it automatically.',
      replacedDisabled ? 'warning' : 'success',
      replacedDisabled ? 5000 : 3200,
    );
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
