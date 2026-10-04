/** Sharpen filters: sharpen, unsharp mask, high pass. */
import { Contrast, Triangle, Zap } from 'lucide-react';
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
    return unsharp(img, Math.max(0.5, 0.8 * sc(ctx)), clamp(num(p.amount, 100), 0, 500) / 100, 0) as ImageData;
  },
};

export const unsharpMask: FilterDef = {
  id: 'unsharp-mask',
  name: 'Unsharp Mask',
  category: 'Sharpen',
  icon: Zap,
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
