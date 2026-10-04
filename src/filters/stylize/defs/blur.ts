/** Blur filters: gaussian, motion, radial (spin/zoom), tilt-shift, lens blur (bokeh). */
import { Disc3, Droplets, Focus, Orbit, Wind } from 'lucide-react';
import type { FilterDef } from '../../../registry';
import {
  anchor,
  autoEdge,
  blurImage,
  blurPlane,
  clamp,
  fromPlanes,
  isEmpty,
  num,
  pt,
  saturateInPlace,
  sc,
  smoothstep,
  str,
  toPlanes,
  type Planes,
} from '../util';
import { lineBoxBlurPlanes, radialAccumulate } from '../ops';
import { angleP, numP, pctP, pointP, pxP, selectP } from '../params';

/* ------------------------------------------------------------------ */
/* Gaussian                                                            */
/* ------------------------------------------------------------------ */

export const gaussianBlur: FilterDef = {
  id: 'gaussian-blur',
  name: 'Gaussian Blur',
  category: 'Blur',
  icon: Droplets,
  description: 'Smooth, even blur (premultiplied, so cut-out edges stay clean).',
  keywords: ['blur', 'soften', 'smooth', 'defocus'],
  params: [pxP('radius', 'Radius', 0, 250, 4, { step: 0.1 })],
  apply(img, p, ctx) {
    const r = Math.max(0, num(p.radius, 4)) * sc(ctx);
    if (r < 0.2 || isEmpty(img)) return img;
    return blurImage(img, r) as ImageData;
  },
};

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

export const motionBlur: FilterDef = {
  id: 'motion-blur',
  name: 'Motion Blur',
  category: 'Blur',
  icon: Wind,
  description: 'Linear streak blur in one direction, like a fast camera pan.',
  keywords: ['speed', 'streak', 'directional', 'movement'],
  params: [angleP('angle', 'Angle', 0), pxP('distance', 'Distance', 0, 500, 20, { step: 1 })],
  apply(img, p, ctx) {
    const dist = Math.max(0, num(p.distance, 20)) * sc(ctx);
    if (dist < 1 || isEmpty(img)) return img;
    const { width: w, height: h } = img;
    const clampEdge = autoEdge(img) === 'clamp';
    const planes = toPlanes(img, true);
    const out = lineBoxBlurPlanes(planes, w, h, num(p.angle, 0), dist / 2, clampEdge);
    fromPlanes(img, out, true);
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Radial (spin / zoom)                                                */
/* ------------------------------------------------------------------ */

export const radialBlur: FilterDef = {
  id: 'radial-blur',
  name: 'Radial Blur',
  category: 'Blur',
  icon: Orbit,
  description: 'Spin around a center point or zoom toward it (speed burst).',
  keywords: ['spin', 'zoom', 'burst', 'rotation', 'speed', 'center'],
  params: [
    selectP('mode', 'Method', [['spin', 'Spin'], ['zoom', 'Zoom']], 'zoom'),
    numP('amount', 'Amount', 0, 100, 20, { step: 1 }),
    pointP('center', 'Center', { x: 0.5, y: 0.5 }),
  ],
  apply(img, p) {
    const amount = clamp(num(p.amount, 20), 0, 100) / 100;
    if (amount <= 0.001 || isEmpty(img)) return img;
    const { width: w, height: h } = img;
    const c = pt(p.center);
    const mode = str(p.mode, 'zoom') === 'spin' ? 'spin' : 'zoom';
    // spin: up to 90° total arc; zoom: scales from ~1.3 down to ~0.45 at amount 100
    const span = mode === 'spin' ? amount * (Math.PI / 2) : amount * 1.05;
    const planes = toPlanes(img, true);
    const res = radialAccumulate([planes.r, planes.g, planes.b, planes.a], w, h, c.x * w - 0.5, c.y * h - 0.5, mode, span, autoEdge(img));
    fromPlanes(img, { r: res[0], g: res[1], b: res[2], a: res[3] }, true);
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Tilt-shift                                                          */
/* ------------------------------------------------------------------ */

function blurredPlanes(src: Planes, w: number, h: number, sigma: number): Planes {
  const c = { r: Float32Array.from(src.r), g: Float32Array.from(src.g), b: Float32Array.from(src.b), a: Float32Array.from(src.a) };
  blurPlane(c.r, w, h, sigma);
  blurPlane(c.g, w, h, sigma);
  blurPlane(c.b, w, h, sigma);
  blurPlane(c.a, w, h, sigma);
  return c;
}

export const tiltShift: FilterDef = {
  id: 'tilt-shift',
  name: 'Tilt-Shift',
  category: 'Blur',
  icon: Focus,
  description: 'Miniature-model look: a sharp focus band with progressive blur above and below.',
  keywords: ['miniature', 'focus', 'depth of field', 'diorama'],
  params: [
    pointP('center', 'Focus center', { x: 0.5, y: 0.55 }),
    angleP('angle', 'Angle', 0),
    pctP('focus', 'Focus width', 0.2),
    pctP('transition', 'Transition', 0.35),
    pxP('blur', 'Blur', 0, 80, 14),
    numP('saturation', 'Saturation', -100, 100, 15, { step: 1 }),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const blur = Math.max(0, num(p.blur, 14)) * s;
    const c = pt(p.center, { x: 0.5, y: 0.55 });
    const th = (num(p.angle, 0) * Math.PI) / 180;
    const nx = -Math.sin(th),
      ny = Math.cos(th);
    // doc-space geometry (image px = doc px × s)
    const cx = c.x * ctx.docWidth * s - ax,
      cy = c.y * ctx.docHeight * s - ay;
    const half = clamp(num(p.focus, 0.2), 0, 1) * ctx.docHeight * s * 0.5;
    const trans = Math.max(1, clamp(num(p.transition, 0.35), 0, 1) * ctx.docHeight * s * 0.6);
    if (blur >= 0.3) {
      const src = toPlanes(img, true);
      const b1 = blurredPlanes(src, w, h, blur * 0.45);
      const b2 = blurredPlanes(src, w, h, blur);
      const out: Planes = { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), a: new Float32Array(n) };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const d = Math.abs((x + 0.5 - cx) * nx + (y + 0.5 - cy) * ny);
          const m = smoothstep(half, half + trans, d); // 0 = sharp, 1 = full blur
          let r: number, g: number, b: number, a: number;
          if (m < 0.5) {
            const t = m * 2;
            r = src.r[i] + (b1.r[i] - src.r[i]) * t;
            g = src.g[i] + (b1.g[i] - src.g[i]) * t;
            b = src.b[i] + (b1.b[i] - src.b[i]) * t;
            a = src.a[i] + (b1.a[i] - src.a[i]) * t;
          } else {
            const t = (m - 0.5) * 2;
            r = b1.r[i] + (b2.r[i] - b1.r[i]) * t;
            g = b1.g[i] + (b2.g[i] - b1.g[i]) * t;
            b = b1.b[i] + (b2.b[i] - b1.b[i]) * t;
            a = b1.a[i] + (b2.a[i] - b1.a[i]) * t;
          }
          out.r[i] = r;
          out.g[i] = g;
          out.b[i] = b;
          out.a[i] = a;
        }
      }
      fromPlanes(img, out, true);
    }
    saturateInPlace(data, 1 + num(p.saturation, 15) / 100);
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Lens blur (bokeh)                                                   */
/* ------------------------------------------------------------------ */

export const lensBlur: FilterDef = {
  id: 'lens-blur',
  name: 'Lens Blur',
  category: 'Blur',
  icon: Disc3,
  description: 'Out-of-focus camera blur: bright highlights bloom into octagonal bokeh discs.',
  keywords: ['bokeh', 'defocus', 'aperture', 'camera', 'depth of field'],
  params: [
    pxP('radius', 'Radius', 0, 100, 12),
    pctP('highlights', 'Highlight boost', 0.5),
    pctP('threshold', 'Highlight level', 0.75),
    angleP('rotation', 'Blade rotation', 22),
  ],
  apply(img, p, ctx) {
    const r = Math.max(0, num(p.radius, 12)) * sc(ctx);
    if (r < 0.75 || isEmpty(img)) return img;
    const { width: w, height: h } = img;
    const n = w * h;
    const boost = clamp(num(p.highlights, 0.5), 0, 1) * 6;
    const thr = clamp(num(p.threshold, 0.75), 0, 0.99);
    const rot = num(p.rotation, 22);
    const clampEdge = autoEdge(img) === 'clamp';
    const P = toPlanes(img, true);
    // move to a "light" space: gamma-ish expansion + highlight boost so bright points dominate
    const exp = (v: number, a: number) => {
      if (a <= 0) return 0;
      const u = v / a; // straight 0..1
      const lin = u * u;
      const hb = u > thr ? 1 + ((u - thr) / (1 - thr)) * boost : 1;
      return lin * hb * a;
    };
    for (let i = 0; i < n; i++) {
      const a = P.a[i];
      P.r[i] = exp(P.r[i], a);
      P.g[i] = exp(P.g[i], a);
      P.b[i] = exp(P.b[i], a);
    }
    // octagonal aperture = average of a square kernel and a 45°-rotated square kernel
    const half = r * 0.82;
    const sq1 = lineBoxBlurPlanes(lineBoxBlurPlanes(P, w, h, rot, half, clampEdge), w, h, rot + 90, half, clampEdge);
    const sq2 = lineBoxBlurPlanes(lineBoxBlurPlanes(P, w, h, rot + 45, half, clampEdge), w, h, rot + 135, half, clampEdge);
    const out: Planes = { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), a: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      const a = (sq1.a[i] + sq2.a[i]) * 0.5;
      out.a[i] = a;
      if (a <= 1e-5) continue;
      // back from light space: compress highlights, then sqrt (inverse of the square)
      const back = (v: number) => {
        const u = v / a;
        const t = u > 1 ? 1 + Math.log(u) * 0.12 : u;
        return Math.sqrt(Math.min(1, t)) * a;
      };
      out.r[i] = back((sq1.r[i] + sq2.r[i]) * 0.5);
      out.g[i] = back((sq1.g[i] + sq2.g[i]) * 0.5);
      out.b[i] = back((sq1.b[i] + sq2.b[i]) * 0.5);
    }
    fromPlanes(img, out, true);
    return img;
  },
};

export const blurFilters: FilterDef[] = [gaussianBlur, motionBlur, radialBlur, tiltShift, lensBlur];
