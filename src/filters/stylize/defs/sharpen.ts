/** Sharpen filters: sharpen, unsharp mask, high pass. */
import { Contrast, ScanEye, Triangle } from 'lucide-react';
import type { FilterDef } from '../../../registry';
import type { Img } from '../util';
import { blurImage, bool, clamp, isEmpty, num, sc } from '../util';
import { boolP, numP, pxP } from '../params';

/** Blurred copy of an image (premultiplied blur → straight result). */
function blurredCopy(img: Img, sigma: number): Uint8ClampedArray {
  const copy = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  blurImage(copy, sigma);
  return copy.data;
}

/**
 * Unsharp mask core: out = orig + (orig − blur) · amount, with a soft luminance threshold so
 * flat areas (noise, skin) are left alone.
 */
export function unsharp(img: Img, sigma: number, amount: number, threshold: number): Img {
  if (amount <= 0 || sigma < 0.1) return img;
  const d = img.data;
  const b = blurredCopy(img, sigma);
  const t = Math.max(0, threshold);
  for (let j = 0; j < d.length; j += 4) {
    if (d[j + 3] === 0) continue;
    const dr = d[j] - b[j],
      dg = d[j + 1] - b[j + 1],
      db = d[j + 2] - b[j + 2];
    let k = amount;
    if (t > 0) {
      const dl = Math.abs(dr * 0.2126 + dg * 0.7152 + db * 0.0722);
      if (dl < t) continue;
      // fade in over a few levels above the threshold to avoid hard banding
      k *= Math.min(1, (dl - t) / 4 + 0.25);
    }
    d[j] += dr * k;
    d[j + 1] += dg * k;
    d[j + 2] += db * k;
  }
  return img;
}

/**
 * Sharpen with a fused 3×3 (separable [ws, wc, ws]) gaussian approximation: one row-ring pass,
 * no full-size float buffers. Neighbours are alpha-weighted (premultiplied) so transparent pixels
 * never bleed into cut-out edges. Used for small sigmas (≤ 1), where a 3-tap kernel covers ±3σ
 * well enough; larger ones go through `unsharp`.
 */
export function sharpen3(img: Img, sigma: number, amount: number): Img {
  const { width: w, height: h, data: d } = img;
  if (amount <= 0 || w < 1 || h < 1) return img;
  const k1 = Math.exp(-1 / (2 * sigma * sigma));
  const wc = 1 / (1 + 2 * k1),
    ws = k1 * wc;
  const stride = w * 4;
  // horizontally blurred premultiplied rows (0..255·255 scale for color, 0..255 alpha), ring of 3
  const rows = [new Float32Array(stride), new Float32Array(stride), new Float32Array(stride)];
  const hrow = (y: number, out: Float32Array) => {
    const ro = y * stride;
    for (let x = 0; x < w; x++) {
      const jc = ro + x * 4;
      const jl = x > 0 ? jc - 4 : jc,
        jr = x < w - 1 ? jc + 4 : jc;
      const al = d[jl + 3] * ws,
        ac = d[jc + 3] * wc,
        ar = d[jr + 3] * ws;
      const o = x * 4;
      out[o] = d[jl] * al + d[jc] * ac + d[jr] * ar;
      out[o + 1] = d[jl + 1] * al + d[jc + 1] * ac + d[jr + 1] * ar;
      out[o + 2] = d[jl + 2] * al + d[jc + 2] * ac + d[jr + 2] * ar;
      out[o + 3] = al + ac + ar;
    }
  };
  hrow(0, rows[1]);
  rows[0].set(rows[1]); // row -1 clamps to row 0
  if (h > 1) hrow(1, rows[2]);
  else rows[2].set(rows[1]);
  // rows[0] = y-1, rows[1] = y, rows[2] = y+1
  const cur = new Uint8ClampedArray(stride);
  for (let y = 0; y < h; y++) {
    const up = rows[0],
      mid = rows[1],
      dn = rows[2];
    const ro = y * stride;
    cur.set(d.subarray(ro, ro + stride));
    for (let x = 0, o = 0; x < w; x++, o += 4) {
      const a = cur[o + 3];
      if (a === 0) continue;
      const A = up[o + 3] * ws + mid[o + 3] * wc + dn[o + 3] * ws;
      if (A <= 1e-6) continue;
      const inv = 1 / A;
      const j = ro + o;
      const c0 = cur[o],
        c1 = cur[o + 1],
        c2 = cur[o + 2];
      const b0 = (up[o] * ws + mid[o] * wc + dn[o] * ws) * inv,
        b1 = (up[o + 1] * ws + mid[o + 1] * wc + dn[o + 1] * ws) * inv,
        b2 = (up[o + 2] * ws + mid[o + 2] * wc + dn[o + 2] * ws) * inv;
      d[j] = c0 + (c0 - b0) * amount;
      d[j + 1] = c1 + (c1 - b1) * amount;
      d[j + 2] = c2 + (c2 - b2) * amount;
    }
    // advance the ring: the next row's neighbours come from the ORIGINAL pixels, computed before
    // this row was written (rows y and y+1 are already buffered; y+2 is still untouched)
    const recycled = rows[0];
    rows[0] = rows[1];
    rows[1] = rows[2];
    rows[2] = recycled;
    if (y + 2 < h) hrow(y + 2, rows[2]);
    else rows[2].set(rows[1]);
  }
  return img;
}

export const sharpen: FilterDef = {
  id: 'sharpen',
  name: 'Sharpen',
  category: 'Sharpen',
  icon: Triangle,
  description: 'Crisper fine detail and edges.',
  keywords: ['crisp', 'detail', 'clarity', 'focus'],
  params: [numP('amount', 'Amount', 0, 500, 100, { unit: '%', step: 1 })],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const sigma = Math.max(0.5, 0.8 * sc(ctx));
    const amount = clamp(num(p.amount, 100), 0, 500) / 100;
    return (sigma <= 1 ? sharpen3(img, sigma, amount) : unsharp(img, sigma, amount, 0)) as ImageData;
  },
};

export const unsharpMask: FilterDef = {
  id: 'unsharp-mask',
  name: 'Unsharp Mask',
  category: 'Sharpen',
  icon: ScanEye,
  description: 'Classic controllable sharpening: amount, radius and threshold.',
  keywords: ['usm', 'sharpen', 'clarity', 'detail'],
  params: [
    numP('amount', 'Amount', 0, 5, 1, { step: 0.01, unit: '%', displayScale: 100 }),
    pxP('radius', 'Radius', 0.1, 50, 2, { step: 0.1 }),
    numP('threshold', 'Threshold', 0, 255, 0, { step: 1, unit: 'lv' }),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const sigma = Math.max(0.1, num(p.radius, 2) * sc(ctx));
    return unsharp(img, sigma, clamp(num(p.amount, 1), 0, 5), clamp(num(p.threshold, 0), 0, 255)) as ImageData;
  },
};

export const highPass: FilterDef = {
  id: 'high-pass',
  name: 'High Pass',
  category: 'Sharpen',
  icon: Contrast,
  description: 'Keeps only edge detail on 50% gray — set the layer to Overlay/Soft Light to sharpen.',
  keywords: ['overlay sharpen', 'detail', 'frequency separation', 'edges'],
  params: [pxP('radius', 'Radius', 0.1, 250, 10, { step: 0.1 }), boolP('mono', 'Monochrome', false), numP('contrast', 'Contrast', 0.25, 4, 1, { step: 0.05 })],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const sigma = Math.max(0.1, num(p.radius, 10) * sc(ctx));
    const k = clamp(num(p.contrast, 1), 0.1, 10);
    const mono = bool(p.mono, false);
    const d = img.data;
    const b = blurredCopy(img, sigma);
    for (let j = 0; j < d.length; j += 4) {
      if (d[j + 3] === 0) continue;
      if (mono) {
        const l = (d[j] - b[j]) * 0.2126 + (d[j + 1] - b[j + 1]) * 0.7152 + (d[j + 2] - b[j + 2]) * 0.0722;
        d[j] = d[j + 1] = d[j + 2] = 128 + l * k;
      } else {
        d[j] = 128 + (d[j] - b[j]) * k;
        d[j + 1] = 128 + (d[j + 1] - b[j + 1]) * k;
        d[j + 2] = 128 + (d[j + 2] - b[j + 2]) * k;
      }
    }
    return img;
  },
};

export const sharpenFilters: FilterDef[] = [sharpen, unsharpMask, highPass];
