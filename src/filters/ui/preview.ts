/** In-dialog preview helpers: fitted/cropped source images and running a filter on a copy. */
import type { ParamValues } from '../../core/types';
import { createCanvas, ctxRead } from '../../core/canvas';
import type { FilterContext, FilterDef } from '../../registry';
import { resolveParams, runFilter } from '../engine';

/** Downscale a canvas to fit maxW×maxH (never upscales). Returns the pixels and the factor. */
export function fitImage(src: HTMLCanvasElement, maxW: number, maxH: number): { img: ImageData; k: number } {
  const k = Math.min(1, maxW / Math.max(1, src.width), maxH / Math.max(1, src.height));
  const w = Math.max(1, Math.round(src.width * k)),
    h = Math.max(1, Math.round(src.height * k));
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  if (k < 1) {
    // step down in halves for big reductions (cleaner than one huge bilinear step)
    let cur: HTMLCanvasElement = src;
    while (cur.width * 0.5 > w * 1.01 && cur.height * 0.5 > h * 1.01) {
      const half = createCanvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
      const hc = ctxRead(half);
      hc.imageSmoothingQuality = 'high';
      hc.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, w, h);
  } else ctx.drawImage(src, 0, 0);
  return { img: ctx.getImageData(0, 0, w, h), k: w / Math.max(1, src.width) };
}

/** Pixels of a rect of a canvas (clamped to its bounds). */
export function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): ImageData {
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  ctx.drawImage(src, -x, -y);
  return ctx.getImageData(0, 0, w, h);
}

export function cloneImage(img: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

/** Run a filter on a copy of `base` (never mutates it). Returns the result and the time taken. */
export function runOnCopy(def: FilterDef, params: ParamValues, base: ImageData, ctx: FilterContext): { out: ImageData; ms: number } {
  const t0 = performance.now();
  const work = cloneImage(base);
  let out = runFilter(def, work, resolveParams(def, params), ctx);
  if (out.width !== base.width || out.height !== base.height) out = work;
  return { out, ms: performance.now() - t0 };
}

/** Stable key for a params object (used to match previews with the applied state). */
export function paramsKey(filterId: string, params: ParamValues, extra = ''): string {
  return `${filterId}|${extra}|${JSON.stringify(params)}`;
}
