/**
 * Blur helpers.
 * - `blurCanvas` uses the GPU-accelerated canvas `filter` (Chromium) — fastest, use for rendering.
 * - `boxBlurImageData` is a CPU separable box blur (3 passes ≈ gaussian) for pixel pipelines.
 */
import { createCanvas, ctx2d } from './canvas';

/** Returns a new canvas = src blurred by radius px (gaussian, via ctx.filter). Expands nothing. */
export function blurCanvas(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const out = createCanvas(src.width, src.height);
  const ctx = ctx2d(out);
  if (radius > 0.01) ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  return out;
}

function boxBlurH(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 4; c++) {
      let ti = row + c;
      const fv = src[ti],
        lv = src[row + (w - 1) * 4 + c];
      let val = r * fv;
      for (let j = 0; j < r; j++) val += src[row + Math.min(j, w - 1) * 4 + c];
      for (let x = 0; x < w; x++) {
        const addIdx = x + r < w ? row + (x + r) * 4 + c : -1;
        val += addIdx >= 0 ? src[addIdx] : lv;
        dst[ti] = val * iarr;
        const subX = x - r;
        val -= subX >= 0 ? src[row + subX * 4 + c] : fv;
        ti += 4;
      }
    }
  }
}

function boxBlurV(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number) {
  const iarr = 1 / (r + r + 1);
  const stride = w * 4;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      const col = x * 4 + c;
      const fv = src[col],
        lv = src[col + (h - 1) * stride];
      let val = r * fv;
      for (let j = 0; j < r; j++) val += src[col + Math.min(j, h - 1) * stride];
      let ti = col;
      for (let y = 0; y < h; y++) {
        val += y + r < h ? src[col + (y + r) * stride] : lv;
        dst[ti] = val * iarr;
        val -= y - r >= 0 ? src[col + (y - r) * stride] : fv;
        ti += stride;
      }
    }
  }
}

/** In-place approximate gaussian blur of ImageData (3 box passes). Operates on premultiplied-ish data; fine for masks/effects. */
export function boxBlurImageData(img: ImageData, radius: number): ImageData {
  const r = Math.round(radius);
  if (r < 1) return img;
  const { width: w, height: h, data } = img;
  const tmp = new Uint8ClampedArray(data.length);
  // radius per pass so 3 passes approximate gaussian sigma ~ radius/2
  const passR = Math.max(1, Math.round(r / 2));
  for (let i = 0; i < 3; i++) {
    boxBlurH(data, tmp, w, h, passR);
    boxBlurV(tmp, data, w, h, passR);
  }
  return img;
}

/** Blur a single-channel Float32 or Uint8 buffer in place (used for masks, heightmaps). */
export function blurChannel(buf: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(buf.length);
  const iarr = 1 / (r + r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let val = r * buf[row];
      for (let j = 0; j < r; j++) val += buf[row + Math.min(j, w - 1)];
      for (let x = 0; x < w; x++) {
        val += buf[row + Math.min(x + r, w - 1)];
        tmp[row + x] = val * iarr;
        val -= buf[row + Math.max(x - r, 0)];
      }
    }
    for (let x = 0; x < w; x++) {
      let val = r * tmp[x];
      for (let j = 0; j < r; j++) val += tmp[Math.min(j, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        val += tmp[Math.min(y + r, h - 1) * w + x];
        buf[y * w + x] = val * iarr;
        val -= tmp[Math.max(y - r, 0) * w + x];
      }
    }
  }
  return buf;
}

export function createBlurredCopy(src: HTMLCanvasElement, radius: number, pad = 0): HTMLCanvasElement {
  const out = createCanvas(src.width + pad * 2, src.height + pad * 2);
  const ctx = ctx2d(out);
  if (radius > 0.01) ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(src, pad, pad);
  return out;
}
