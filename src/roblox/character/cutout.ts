/**
 * Cut-out helpers shared by Remove Background, the Character Styler, Looks and Replace Character.
 *
 * Smart filters run on a layer's pixels BEFORE its layer mask is applied, so a character whose
 * background is only hidden by a mask still has that background as far as character filters
 * (rim light, face shadow, outlines, halftone paper…) are concerned. These helpers detect that
 * situation and bake such a mask into the pixels, and trim a layer to its visible pixels.
 */
import type { BitmapPatch, Document, Layer, RasterLayer, Rect } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../../core/canvas';
import { transformMatrix, transformedBounds } from '../../core/geometry';
import { effectiveMaskAlpha } from '../../panels/layerOps';
import { pixelBox, unionRects } from '../../panels/geometryMath';
import { alphaBounds } from '../pixels';
import { trimRect, trimTransform } from './fit';

/** `layer.meta` key holding the bitmap id of a mask created by Remove Background. */
export const CUTOUT_MASK_KEY = 'cutoutMask';

/** Largest distance (px) beyond the canvas edges that a mask bake still covers (as Layer ▸ Apply Layer Mask). */
const MAX_BAKE_MARGIN = 4096;

/** True when the layer's enabled mask was made by Remove Background. */
export function hasRemoveBgMask(layer: Layer | null | undefined): boolean {
  return !!layer?.mask && layer.mask.enabled !== false && layer.meta?.[CUTOUT_MASK_KEY] === layer.mask.bitmapId;
}

/** Sample points along a w×h box border (corners + edge midpoints + quarter points). */
function borderPoints(w: number, h: number): [number, number][] {
  const xs = [0, w >> 2, w >> 1, (3 * w) >> 2, w - 1];
  const ys = [0, h >> 2, h >> 1, (3 * h) >> 2, h - 1];
  const pts: [number, number][] = [];
  for (const x of xs) pts.push([x, 0], [x, h - 1]);
  for (const y of ys) pts.push([0, y], [w - 1, y]);
  return pts;
}

/**
 * True when a raster layer's own pixels still contain a background: its border is opaque at
 * (nearly) every sample point — a screenshot or render that was never cut out.
 */
export function hasOpaqueBorder(layer: RasterLayer): boolean {
  if (!bitmaps.has(layer.bitmapId)) return false;
  const c = bitmaps.get(layer.bitmapId);
  const pts = borderPoints(c.width, c.height);
  try {
    let opaque = 0;
    for (const [x, y] of pts) if (bitmaps.read(layer.bitmapId, { x, y, width: 1, height: 1 }).data[3] === 255) opaque++;
    return opaque >= pts.length - 1;
  } catch {
    return false;
  }
}

/** Same test for a canvas (e.g. an image about to replace a placeholder). */
export function canvasHasOpaqueBorder(c: HTMLCanvasElement): boolean {
  if (c.width < 2 || c.height < 2) return false;
  const ctx = ctxRead(c);
  const top = ctx.getImageData(0, 0, c.width, 1).data;
  const bottom = ctx.getImageData(0, c.height - 1, c.width, 1).data;
  const left = ctx.getImageData(0, 0, 1, c.height).data;
  const right = ctx.getImageData(c.width - 1, 0, 1, c.height).data;
  let n = 0,
    opaque = 0;
  for (const row of [top, bottom, left, right]) {
    for (let q = 3; q < row.length; q += 4) {
      n++;
      if (row[q] > 250) opaque++;
    }
  }
  return n > 0 && opaque / n > 0.9;
}

/**
 * How ready a layer is for character styles:
 *  - 'cut'        — transparent around the subject (or not a pixel layer),
 *  - 'background' — the pixels still contain an opaque background,
 *  - 'masked'     — an enabled mask hides an opaque background (styles would see it).
 */
export type CutoutState = 'cut' | 'background' | 'masked';

export function cutoutState(layer: Layer | null | undefined): CutoutState {
  if (!layer || layer.type !== 'raster') return 'cut';
  const masked = !!layer.mask && layer.mask.enabled !== false;
  if (hasRemoveBgMask(layer)) return 'masked';
  if (!hasOpaqueBorder(layer)) return 'cut';
  return masked ? 'masked' : 'background';
}

/**
 * Bitmap patch multiplying a raster layer's pixels by its effective mask (density, invert and
 * feather included) — Layer ▸ Apply Layer Mask for one specific layer, so it can be combined
 * with other changes in a single history step. Follow it with `clearMaskDraft` in the commit.
 */
export function maskBakePatch(doc: Document, layer: RasterLayer): BitmapPatch | null {
  const mask = layer.mask;
  if (!mask || mask.enabled === false || !bitmaps.has(layer.bitmapId)) return null;
  const docRect: Rect = { x: 0, y: 0, width: doc.width, height: doc.height };
  const lb = transformedBounds(layer.transform, layer.width, layer.height);
  const all = pixelBox(unionRects([docRect, lb]) ?? docRect);
  const x0 = Math.max(all.x, -MAX_BAKE_MARGIN);
  const y0 = Math.max(all.y, -MAX_BAKE_MARGIN);
  const region: Rect = {
    x: x0,
    y: y0,
    width: Math.min(all.x + all.width, doc.width + MAX_BAKE_MARGIN) - x0,
    height: Math.min(all.y + all.height, doc.height + MAX_BAKE_MARGIN) - y0,
  };
  const alpha = effectiveMaskAlpha(doc, mask, true, region);
  const m = transformMatrix(layer.transform, layer.width, layer.height).inverse();
  const local = createCanvas(layer.width, layer.height);
  const lctx = ctx2d(local);
  lctx.fillStyle = '#000';
  lctx.fillRect(0, 0, local.width, local.height);
  lctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = 'high';
  lctx.clearRect(region.x, region.y, region.width, region.height);
  lctx.drawImage(alpha, region.x, region.y);
  return bitmaps.edit(layer.bitmapId, (bctx) => {
    bctx.globalCompositeOperation = 'destination-in';
    bctx.drawImage(local, 0, 0);
  });
}

/** Draft mutation that goes with `maskBakePatch`: drop the mask and its Remove Background tag. */
export function clearMaskDraft(l: Layer) {
  l.mask = null;
  if (l.meta && CUTOUT_MASK_KEY in l.meta) {
    const meta = { ...l.meta };
    delete meta[CUTOUT_MASK_KEY];
    l.meta = meta;
  }
}

export interface TrimResult {
  bitmapId: string;
  width: number;
  height: number;
  transform: RasterLayer['transform'];
}

/**
 * Copy of a raster layer's visible pixels as a new bitmap plus the transform that keeps every
 * pixel where it was on the canvas. Null when there is nothing to trim (or nothing visible).
 */
export function trimRasterLayer(layer: RasterLayer, img?: ImageData): TrimResult | null {
  if (!bitmaps.has(layer.bitmapId)) return null;
  const data = img ?? bitmaps.read(layer.bitmapId, { x: 0, y: 0, width: layer.width, height: layer.height });
  const rect = trimRect(alphaBounds(data, 0), data.width, data.height);
  if (!rect) return null;
  const out = createCanvas(rect.width, rect.height);
  ctx2d(out).putImageData(data, -rect.x, -rect.y, rect.x, rect.y, rect.width, rect.height);
  // The local box IS the bitmap (layer.width/height = bitmap size), so the rect maps 1:1.
  const transform = trimTransform(layer.transform, layer.width, layer.height, rect);
  return { bitmapId: bitmaps.add(out), width: rect.width, height: rect.height, transform };
}

export interface CutoutBake {
  /** Bitmap patches (the bake) for the commit options. */
  patches: BitmapPatch[];
  /** Draft mutation for the same commit: drop the mask, swap in the trimmed bitmap. */
  apply(l: Layer): void;
}

/**
 * Prepare baking a Remove Background mask into a raster layer before character styling (smart
 * filters run before masks), trimming the layer to the character at the same time. Combine
 * `patches` + `apply` with the styling change in ONE commit. Null when there is nothing to bake.
 */
export function prepareCutoutBake(doc: Document, layer: Layer): CutoutBake | null {
  if (layer.type !== 'raster' || !hasRemoveBgMask(layer) || layer.locks.all || layer.locks.pixels) return null;
  const patch = maskBakePatch(doc, layer);
  if (!patch) return null;
  // The bake is already applied to the bitmap (bitmaps.edit), so the trim sees the cut-out.
  const trimmed = layer.generator ? null : trimRasterLayer(layer);
  return {
    patches: [patch],
    apply(l) {
      clearMaskDraft(l);
      if (trimmed && l.type === 'raster') {
        l.bitmapId = trimmed.bitmapId;
        l.width = trimmed.width;
        l.height = trimmed.height;
        l.transform = trimmed.transform;
      }
    },
  };
}
