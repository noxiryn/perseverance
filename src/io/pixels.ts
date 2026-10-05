/**
 * Pixel helpers shared by clipboard / fill / stroke: mapping doc-space content onto raster
 * layers (respecting their transforms) with history patches.
 */
import type { BitmapPatch, BlendMode, DocSession, Document, RasterLayer, Rect } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d } from '../core/canvas';
import { applyMatrix, boundsOfPoints, transformMatrix } from '../core/geometry';
import { compositeOp } from '../filters/engine';
import { clampRect } from './math';

/** Local-space pixel rect of a raster layer covering a doc-space rect (null if outside). */
export function localRectFor(layer: RasterLayer, docRect: Rect, pad = 2): Rect | null {
  const inv = transformMatrix(layer.transform, layer.width, layer.height).inverse();
  const pts = [
    { x: docRect.x, y: docRect.y },
    { x: docRect.x + docRect.width, y: docRect.y },
    { x: docRect.x + docRect.width, y: docRect.y + docRect.height },
    { x: docRect.x, y: docRect.y + docRect.height },
  ].map((p) => applyMatrix(inv, p));
  const b = boundsOfPoints(pts);
  return clampRect({ x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }, layer.width, layer.height);
}

export interface DrawOptions {
  blendMode?: BlendMode;
  opacity?: number;
  /** Keep the layer's existing alpha (Photoshop "Preserve Transparency"). */
  preserveTransparency?: boolean;
  /** 'erase' removes pixels using `src` alpha. */
  erase?: boolean;
}

/**
 * Draw a doc-space canvas onto a raster layer's bitmap (through the inverse layer transform),
 * returning the history patch. `docRect` limits the affected area (defaults to the whole layer).
 */
export function drawDocCanvasOnRaster(
  layer: RasterLayer,
  src: HTMLCanvasElement,
  docRect: Rect | null,
  o: DrawOptions = {},
): BitmapPatch | null {
  const rect = docRect ? localRectFor(layer, docRect) : { x: 0, y: 0, width: layer.width, height: layer.height };
  if (!rect) return null;
  const m = transformMatrix(layer.transform, layer.width, layer.height).inverse();
  return bitmaps.edit(
    layer.bitmapId,
    (ctx, canvas) => {
      if (o.erase) {
        ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(src, 0, 0);
        return;
      }
      if (o.preserveTransparency) {
        // Blend into a copy, then put it back only where the layer already had pixels.
        const tmp = createCanvas(canvas.width, canvas.height);
        const t = ctx2d(tmp);
        t.drawImage(canvas, 0, 0);
        t.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        t.globalAlpha = o.opacity ?? 1;
        t.globalCompositeOperation = compositeOp(o.blendMode ?? 'normal');
        t.drawImage(src, 0, 0);
        ctx.globalCompositeOperation = 'source-atop';
        ctx.drawImage(tmp, 0, 0);
        return;
      }
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.globalAlpha = o.opacity ?? 1;
      ctx.globalCompositeOperation = compositeOp(o.blendMode ?? 'normal');
      ctx.drawImage(src, 0, 0);
    },
    rect,
  );
}

/** Draw a doc-space canvas onto a doc-sized mask bitmap (grayscale), returning the patch. */
export function drawDocCanvasOnMask(
  maskBitmapId: string,
  src: HTMLCanvasElement,
  docRect: Rect | null,
  o: DrawOptions = {},
): BitmapPatch | null {
  const c = bitmaps.tryGet(maskBitmapId);
  if (!c) return null;
  const rect = docRect
    ? clampRect({ x: docRect.x - 1, y: docRect.y - 1, width: docRect.width + 2, height: docRect.height + 2 }, c.width, c.height)
    : null;
  if (docRect && !rect) return null;
  return bitmaps.edit(
    maskBitmapId,
    (ctx) => {
      ctx.filter = 'grayscale(1)';
      ctx.globalAlpha = o.opacity ?? 1;
      ctx.globalCompositeOperation = o.erase ? 'source-over' : compositeOp(o.blendMode ?? 'normal');
      ctx.drawImage(src, 0, 0);
    },
    rect ?? undefined,
  );
}

/** Doc-sized canvas filled with `color` (or a fill callback), clipped to the selection when present. */
export function selectionClippedFill(
  doc: Document,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  paint(ctx, doc.width, doc.height);
  const sel = doc.selection ? bitmaps.tryGet(doc.selection.bitmapId) : null;
  if (sel) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(sel, 0, 0);
  }
  return c;
}

/** Selection bounds as an integer rect clamped to the document (null when nothing is selected). */
export function selectionRect(doc: Document): Rect | null {
  return doc.selection ? clampRect(doc.selection.bounds, doc.width, doc.height) : null;
}

/** Which bitmap a pixel operation targets on the active layer: its mask (when editing it) or content. */
export function pixelTarget(s: DocSession): { kind: 'mask'; bitmapId: string } | { kind: 'raster'; layer: RasterLayer } | null {
  const l = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!l) return null;
  if (s.editTarget === 'mask' && l.mask) return { kind: 'mask', bitmapId: l.mask.bitmapId };
  if (l.type === 'raster') return { kind: 'raster', layer: l };
  return null;
}
