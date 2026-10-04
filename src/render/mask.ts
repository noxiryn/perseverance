/**
 * Layer masks at render time. A mask is a doc-sized bitmap whose luminance (R channel) is the
 * layer visibility. For a region of output pixels we produce a canvas whose ALPHA is the final
 * visibility (inverted / density / feather applied) so it can be applied with `destination-in`.
 */
import type { LayerMask } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { ctx2d } from '../core/canvas';
import { px, slots } from './cache';
import { acquire, fresh, release, type PxRect } from './surface';

/** Pure per-pixel mask transfer: luminance (0..255) → visibility (0..255). */
export function maskValue(lum: number, inverted: boolean, density: number): number {
  const l = inverted ? 255 - lum : lum;
  const d = density < 0 ? 0 : density > 1 ? 1 : density;
  return 255 - d * (255 - l);
}

/** Lookup table for maskValue (256 entries). */
export function maskLUT(inverted: boolean, density: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(maskValue(i, inverted, density));
  return lut;
}

/**
 * Draw `img` (covering the rect dx,dy,dw,dh in the context's device space) and extend its edge
 * pixels outward to fill the rest of the target (edge clamping, so blurs and off-canvas content
 * see the mask's border values instead of transparency).
 */
export function drawClamped(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, dx: number, dy: number, dw: number, dh: number) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const iw = img.width;
  const ih = img.height;
  const x0 = dx,
    y0 = dy,
    x1 = dx + dw,
    y1 = dy + dh;
  ctx.drawImage(img, 0, 0, iw, ih, x0, y0, dw, dh);
  // Edges
  if (x0 > 0) ctx.drawImage(img, 0, 0, 1, ih, 0, y0, x0 + 0.5, dh);
  if (x1 < W) ctx.drawImage(img, iw - 1, 0, 1, ih, x1 - 0.5, y0, W - x1 + 0.5, dh);
  if (y0 > 0) ctx.drawImage(img, 0, 0, iw, 1, x0, 0, dw, y0 + 0.5);
  if (y1 < H) ctx.drawImage(img, 0, ih - 1, iw, 1, x0, y1 - 0.5, dw, H - y1 + 0.5);
  // Corners
  if (x0 > 0 && y0 > 0) ctx.drawImage(img, 0, 0, 1, 1, 0, 0, x0 + 0.5, y0 + 0.5);
  if (x1 < W && y0 > 0) ctx.drawImage(img, iw - 1, 0, 1, 1, x1 - 0.5, 0, W - x1 + 0.5, y0 + 0.5);
  if (x0 > 0 && y1 < H) ctx.drawImage(img, 0, ih - 1, 1, 1, 0, y1 - 0.5, x0 + 0.5, H - y1 + 0.5);
  if (x1 < W && y1 < H) ctx.drawImage(img, iw - 1, ih - 1, 1, 1, x1 - 0.5, y1 - 0.5, W - x1 + 0.5, H - y1 + 0.5);
}

/**
 * Processed mask alpha for a region of output pixels at render `scale`. Returns a canvas of the
 * region's size (alpha = visibility, color white). Cached per mask bitmap/version/settings/region.
 */
export function maskAlpha(mask: LayerMask, scale: number, region: PxRect, docW: number, docH: number): HTMLCanvasElement | null {
  const bmp = bitmaps.tryGet(mask.bitmapId);
  if (!bmp) return null;
  const feather = Math.max(0, Number(mask.feather) || 0) * scale;
  const sigma = feather / 2;
  const density = Number.isFinite(mask.density) ? mask.density : 1;
  const key = `mask|${mask.bitmapId}|${scale.toFixed(5)}`;
  const sig = `${bitmaps.version(mask.bitmapId)}|${mask.inverted ? 1 : 0}|${density.toFixed(4)}|${feather.toFixed(3)}|${region.x},${region.y},${region.w},${region.h}|${docW}x${docH}`;
  const hit = slots.get<HTMLCanvasElement>(key, sig);
  if (hit) return hit;

  const m = sigma > 0.05 ? Math.ceil(sigma * 3) + 1 : 0;
  const W = region.w + 2 * m;
  const H = region.h + 2 * m;
  const work = acquire(W, H, { read: true });
  const wctx = ctx2d(work, { willReadFrequently: true });
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = 'high';
  drawClamped(wctx, bmp, -region.x + m, -region.y + m, docW * scale, docH * scale);
  const img = wctx.getImageData(0, 0, W, H);
  const d = img.data;
  const lut = maskLUT(!!mask.inverted, density);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    const lum = a === 255 ? d[i] : (d[i] * a) / 255;
    d[i] = 255;
    d[i + 1] = 255;
    d[i + 2] = 255;
    d[i + 3] = lut[lum | 0];
  }
  wctx.putImageData(img, 0, 0);
  const out = fresh(region.w, region.h);
  const octx = ctx2d(out);
  if (m > 0) {
    // Blur with clamped surroundings: extend edges of the processed work canvas first.
    const ext = acquire(W + 2 * m, H + 2 * m);
    const ectx = ctx2d(ext);
    drawClamped(ectx, work, m, m, W, H);
    octx.filter = `blur(${sigma}px)`;
    octx.drawImage(ext, -2 * m, -2 * m);
    octx.filter = 'none';
    release(ext);
  } else {
    octx.drawImage(work, 0, 0);
  }
  release(work);
  slots.set(key, sig, out, px(out), { max: 2 });
  return out;
}

/**
 * Multiply a canvas (positioned at `region` in output px) by a layer mask in place.
 * Returns false when the mask bitmap is missing (content is left untouched).
 */
export function applyMask(target: HTMLCanvasElement, region: PxRect, mask: LayerMask, scale: number, docW: number, docH: number): boolean {
  if (!mask.enabled) return true;
  const ma = maskAlpha(mask, scale, region, docW, docH);
  if (!ma) return false;
  const ctx = ctx2d(target);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(ma, 0, 0);
  ctx.restore();
  return true;
}

/**
 * dst ← dst·(1−m) + src·m (premultiplied lerp), where m = alpha × (maskCanvas alpha if given).
 * `src` and `mask` are aligned with dst at (ox, oy) (dst canvas px). Exact for alpha too, so
 * transparent areas never gain coverage.
 */
export function lerpInto(
  dst: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  alpha: number,
  mask: HTMLCanvasElement | null,
  ox = 0,
  oy = 0,
) {
  const a = Math.max(0, Math.min(1, alpha));
  if (a <= 0) return;
  if (!mask && a >= 0.999) {
    dst.save();
    dst.setTransform(1, 0, 0, 1, 0, 0);
    dst.clearRect(ox, oy, src.width, src.height);
    dst.drawImage(src, ox, oy);
    dst.restore();
    return;
  }
  const w = src.width;
  const h = src.height;
  // m-canvas (alpha = m)
  let mc: HTMLCanvasElement | null = null;
  if (mask) {
    mc = acquire(w, h);
    const mctx = ctx2d(mc);
    mctx.globalAlpha = a;
    mctx.drawImage(mask, 0, 0);
  }
  // src·m
  const sm = acquire(w, h);
  const sctx = ctx2d(sm);
  sctx.drawImage(src, 0, 0);
  sctx.globalCompositeOperation = 'destination-in';
  if (mc) sctx.drawImage(mc, 0, 0);
  else {
    sctx.fillStyle = `rgba(255,255,255,${a})`;
    sctx.fillRect(0, 0, w, h);
  }
  dst.save();
  dst.setTransform(1, 0, 0, 1, 0, 0);
  // dst·(1−m)
  dst.globalCompositeOperation = 'destination-out';
  if (mc) dst.drawImage(mc, ox, oy);
  else {
    dst.fillStyle = `rgba(255,255,255,${a})`;
    dst.fillRect(ox, oy, w, h);
  }
  // + src·m
  dst.globalCompositeOperation = 'lighter';
  dst.drawImage(sm, ox, oy);
  dst.restore();
  release(sm, mc);
}
