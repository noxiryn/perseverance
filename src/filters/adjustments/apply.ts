/**
 * Destructive pixel edits on the active raster layer (Auto Tone/Contrast/Color, Desaturate…),
 * recorded as a BitmapPatch so they are undoable. Respects the selection (soft edges blend).
 */
import type { Document, ID, Layer } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { invalidateRenderCache } from '../../render/compositor';
import { getSelectionMask } from '../../editor/selection';
import { createCanvas, ctx2d } from '../../core/canvas';
import { layerSelectionMask, NO_DOC_MESSAGE } from './layers';

export interface RasterTarget {
  doc: Document;
  layer: Layer;
  /** 'mask' when the layer mask is the edit target (Photoshop applies adjustments to it). */
  kind: 'content' | 'mask';
  /** Bitmap that is analysed and edited (layer pixels or the doc-sized mask). */
  bitmapId: ID;
  /** Selection mapped to the bitmap's pixels (null = everything). */
  mask: Uint8ClampedArray | null;
}

/** Selection alpha of a doc-sized bitmap (masks live in document space). */
function docSelectionMask(doc: Document): Uint8ClampedArray | null {
  const sel = getSelectionMask(doc);
  if (!sel) return null;
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c, { willReadFrequently: true });
  ctx.drawImage(sel, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8ClampedArray(doc.width * doc.height);
  for (let p = 0, i = 3; p < out.length; p++, i += 4) out[p] = d[i];
  return out;
}

/** Validate that the active layer can be edited destructively; toasts a helpful message if not. */
export function activeRasterTarget(action: string): RasterTarget | null {
  const s = activeSession();
  if (!s) {
    toast(NO_DOC_MESSAGE, 'info');
    return null;
  }
  const layer = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!layer) {
    toast(`Select a layer to ${action}.`, 'info');
    return null;
  }
  if (s.editTarget === 'mask' && layer.mask) {
    if (layer.locks.all) {
      toast(`“${layer.name}” is locked. Unlock it in the Layers panel to ${action}.`, 'warning');
      return null;
    }
    if (!bitmaps.has(layer.mask.bitmapId)) {
      toast(`The mask of “${layer.name}” is not available.`, 'error');
      return null;
    }
    const mask = s.doc.selection ? docSelectionMask(s.doc) : null;
    if (mask && !mask.some((v) => v > 0)) {
      toast('The selection is empty.', 'info');
      return null;
    }
    return { doc: s.doc, layer, kind: 'mask', bitmapId: layer.mask.bitmapId, mask };
  }
  if (layer.type !== 'raster') {
    toast(`${cap(action)} needs a pixel layer. Rasterize “${layer.name}” first, or use an adjustment layer instead.`, 'warning');
    return null;
  }
  if (layer.locks.all || layer.locks.pixels) {
    toast(`“${layer.name}” has locked pixels. Unlock it in the Layers panel to ${action}.`, 'warning');
    return null;
  }
  if (!bitmaps.has(layer.bitmapId)) {
    toast(`The pixels of “${layer.name}” are not available.`, 'error');
    return null;
  }
  let mask: Uint8ClampedArray | null = null;
  if (s.doc.selection) {
    mask = layerSelectionMask(s.doc, layer);
    if (mask && !mask.some((v) => v > 0)) {
      toast(`The selection does not overlap “${layer.name}”.`, 'info');
      return null;
    }
  }
  return { doc: s.doc, layer, kind: 'content', bitmapId: layer.bitmapId, mask };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Run `fn` over the layer's pixels (in place on an ImageData), blend through the selection mask
 * and commit one history step.
 */
export function editRasterPixels(target: RasterTarget, label: string, fn: (img: ImageData) => void): void {
  const { layer, mask, bitmapId } = target;
  const patch = bitmaps.edit(bitmapId, (ctx, canvas) => {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const orig = mask ? img.data.slice() : null;
    fn(img);
    if (mask && orig) {
      const d = img.data;
      for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        const m = mask[p];
        if (m === 255) continue;
        if (m === 0) {
          d[i] = orig[i];
          d[i + 1] = orig[i + 1];
          d[i + 2] = orig[i + 2];
          d[i + 3] = orig[i + 3];
          continue;
        }
        const t = m / 255;
        d[i] = orig[i] + (d[i] - orig[i]) * t;
        d[i + 1] = orig[i + 1] + (d[i + 1] - orig[i + 1]) * t;
        d[i + 2] = orig[i + 2] + (d[i + 2] - orig[i + 2]) * t;
        d[i + 3] = orig[i + 3] + (d[i + 3] - orig[i + 3]) * t;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  invalidateRenderCache(layer.id);
  useEditor.getState().commit(target.kind === 'mask' ? `${label} (Mask)` : label, undefined, { patches: [patch] });
  viewport.requestRender();
}

/** Read the target's pixels used for analysis (full bitmap). */
export function readTargetPixels(target: RasterTarget): ImageData {
  return bitmaps.read(target.bitmapId);
}
