/** Retro & glitch filters: chromatic aberration, glitch, scanlines, VHS, CRT, JPEG artifacts, sepia, old photo. */
import { Camera, FileImage, Glasses, Monitor, Rows3, ScanLine, Tv, Bug } from 'lucide-react';
import type { FilterDef } from '../../../registry';
import type { Img } from '../util';
import { anchor, autoEdge, blurPlane, bool, clamp, coarseField, fbmValue, hash, hashGauss, isEmpty, num, prng, pt, rgb, sc, smoothstep, str } from '../util';
import { blurPlaneMultires, lineBoxBlur } from '../ops';
import { vignetteAt } from './light';
import { angleP, boolP, colorP, numP, pctP, pointP, pxP, seedP, selectP } from '../params';

/** Bilinear plane lookup; outside → 0 (transparent) or clamped. */
function bil(pl: Float32Array, w: number, h: number, fx: number, fy: number, clampEdge: boolean): number {
  let x0 = Math.floor(fx),
    y0 = Math.floor(fy);
  const tx = fx - x0,
    ty = fy - y0;
  let x1 = x0 + 1,
    y1 = y0 + 1;
  if (clampEdge) {
    x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
    x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1;
    y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
    y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1;
    return (
      (pl[y0 * w + x0] * (1 - tx) + pl[y0 * w + x1] * tx) * (1 - ty) + (pl[y1 * w + x0] * (1 - tx) + pl[y1 * w + x1] * tx) * ty
    );
  }
  if (x0 >= 0 && y0 >= 0 && x1 < w && y1 < h) {
    const i = y0 * w + x0;
    return (pl[i] * (1 - tx) + pl[i + 1] * tx) * (1 - ty) + (pl[i + w] * (1 - tx) + pl[i + w + 1] * tx) * ty;
  }
  const inX0 = x0 >= 0 && x0 < w,
    inX1 = x1 >= 0 && x1 < w,
    inY0 = y0 >= 0 && y0 < h,
    inY1 = y1 >= 0 && y1 < h;
  const a = inX0 && inY0 ? pl[y0 * w + x0] : 0,
    b = inX1 && inY0 ? pl[y0 * w + x1] : 0,
    c = inX0 && inY1 ? pl[y1 * w + x0] : 0,
    d = inX1 && inY1 ? pl[y1 * w + x1] : 0;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Premultiplied channel planes 0..1. */
function premulPlanes(img: Img) {
  const n = img.width * img.height;
  const d = img.data;
  const r = new Float32Array(n),
    g = new Float32Array(n),
    b = new Float32Array(n),
    a = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const al = d[j + 3] / 255;
    r[i] = (d[j] / 255) * al;
    g[i] = (d[j + 1] / 255) * al;
    b[i] = (d[j + 2] / 255) * al;
    a[i] = al;
  }
  return { r, g, b, a };
}

/* ------------------------------------------------------------------ */
/* Chromatic aberration                                                */
/* ------------------------------------------------------------------ */

export const chromaticAberration: FilterDef = {
  id: 'chromatic-aberration',
  name: 'Chromatic Aberration',
  category: 'Retro & Glitch',
  icon: Glasses,
  description: 'Splits red and blue channels apart (linear offset or lens-style radial fringing).',
  keywords: ['rgb split', 'fringe', 'lens', 'glitch', 'anaglyph', '3d'],
  params: [
    selectP('mode', 'Mode', [['linear', 'Linear offset'], ['radial', 'Radial (lens)']], 'linear'),
    pxP('amount', 'Amount', 0, 40, 6),
    angleP('angle', 'Angle', 0, { showIf: (v) => v.mode !== 'radial' }),
    pointP('center', 'Center', { x: 0.5, y: 0.5 }, { showIf: (v) => v.mode === 'radial' }),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const { ax, ay, s } = anchor(ctx);
    const amt = num(p.amount, 6) * s;
    if (Math.abs(amt) < 0.05) return img;
    const radial = str(p.mode, 'linear') === 'radial';
    const clampEdge = autoEdge(img) === 'clamp';
    const P = premulPlanes(img);
    const th = (num(p.angle, 0) * Math.PI) / 180;
    const ux = Math.cos(th),
      uy = -Math.sin(th);
    const c = pt(p.center);
    const cx = c.x * ctx.docWidth * s - ax,
      cy = c.y * ctx.docHeight * s - ay;
    const Rn = Math.max(1, Math.hypot(ctx.docWidth * s, ctx.docHeight * s) / 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        let dx: number, dy: number;
        if (radial) {
          const k = amt / Rn;
          dx = (x + 0.5 - cx) * k;
          dy = (y + 0.5 - cy) * k;
        } else {
          dx = ux * amt;
          dy = uy * amt;
        }
        const rA = bil(P.a, w, h, x - dx, y - dy, clampEdge),
          rR = bil(P.r, w, h, x - dx, y - dy, clampEdge);
        const bA = bil(P.a, w, h, x + dx, y + dy, clampEdge),
          bB = bil(P.b, w, h, x + dx, y + dy, clampEdge);
        const gA = P.a[i],
          gG = P.g[i];
        const A = Math.max(rA, gA, bA);
        if (A <= 0.002) {
          data[j] = data[j + 1] = data[j + 2] = data[j + 3] = 0;
          continue;
        }
        data[j] = (rR / A) * 255;
        data[j + 1] = (gG / A) * 255;
        data[j + 2] = (bB / A) * 255;
        data[j + 3] = A * 255;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Glitch                                                              */
/* ------------------------------------------------------------------ */

interface Band {
  y0: number;
  y1: number;
  dx: number;
  split: number;
  invert: boolean;
}
interface Block {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: number;
  sx: number;
  sy: number;
}

export const glitch: FilterDef = {
  id: 'glitch',
  name: 'Glitch',
  category: 'Retro & Glitch',
  icon: Bug,
  description: 'Digital corruption: shifted horizontal slices, RGB splitting and broken blocks (seeded).',
  keywords: ['datamosh', 'corrupt', 'error', 'digital', 'cyberpunk', 'distortion'],
  params: [
    pctP('amount', 'Amount', 0.5),
    numP('slices', 'Slices', 1, 100, 18, { step: 1 }),
    pxP('shift', 'Max shift', 0, 400, 60),
    pxP('rgbSplit', 'RGB split', 0, 40, 6),
    pctP('blocks', 'Broken blocks', 0.25),
    seedP(7),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const s = sc(ctx);
    const amount = clamp(num(p.amount, 0.5), 0, 1);
    if (amount <= 0) return img;
    const nSl = clamp(Math.round(num(p.slices, 18)), 1, 100);
    const shift = num(p.shift, 60);
    const split = num(p.rgbSplit, 6);
    const blocksAmt = clamp(num(p.blocks, 0.25), 0, 1);
    const seed = num(p.seed, 7) | 0;
    const rnd = prng(seed * 7919 + 13);
    const D_H = ctx.docHeight,
      D_W = ctx.docWidth;
    // bands over the DOCUMENT height (so the same rows glitch whichever layer is filtered)
    const weights: number[] = [];
    for (let i = 0; i < nSl * 2; i++) weights.push(0.15 + rnd() ** 2);
    const tot = weights.reduce((a, b) => a + b, 0);
    const bands: Band[] = [];
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      const y0 = (acc / tot) * D_H;
      acc += weights[i];
      const y1 = (acc / tot) * D_H;
      const active = rnd() < 0.25 + amount * 0.6 && i % 2 === 1;
      const r1 = rnd(),
        r2 = rnd(),
        r3 = rnd();
      bands.push({
        y0,
        y1,
        dx: active ? (r1 * 2 - 1) * shift * amount * (0.3 + 0.7 * r2) : 0,
        split: active ? split * (0.5 + r3) : split * 0.25 * amount,
        invert: active && r3 > 0.93,
      });
    }
    const blocks: Block[] = [];
    const nb = Math.round(blocksAmt * 28 * (0.4 + amount));
    for (let i = 0; i < nb; i++) {
      const bw = (0.03 + rnd() * 0.25) * D_W,
        bh = (0.006 + rnd() * 0.05) * D_H;
      const x0 = rnd() * D_W,
        y0 = rnd() * D_H;
      blocks.push({ x0, y0, x1: x0 + bw, y1: y0 + bh, kind: Math.floor(rnd() * 4), sx: (rnd() * 2 - 1) * D_W * 0.2, sy: (rnd() * 2 - 1) * bh * 2 });
    }
    const src = new Uint8ClampedArray(data);
    const wrap = autoEdge(img) === 'clamp';
    const inv = 1 / s;
    /** Nearest-pixel fetch of channel `ch` (crisp digital look); −1 outside a cut-out. */
    const fetchAt = (fx: number, yi: number, ch: number) => {
      let xi = Math.round(fx);
      if (wrap) {
        xi = ((xi % w) + w) % w;
        yi = yi < 0 ? 0 : yi >= h ? h - 1 : yi;
      } else if (xi < 0 || xi >= w || yi < 0 || yi >= h) return -1;
      return src[(yi * w + xi) * 4 + ch];
    };
    let bi = 0;
    const rowBlocks: Block[] = [];
    for (let y = 0; y < h; y++) {
      const Y = ctx.offsetY + (y + 0.5) * inv;
      while (bi < bands.length - 1 && Y >= bands[bi].y1) bi++;
      while (bi > 0 && Y < bands[bi].y0) bi--;
      const band = bands[bi];
      rowBlocks.length = 0;
      for (const b of blocks) if (Y >= b.y0 && Y < b.y1) rowBlocks.push(b);
      const dxI = band.dx * s;
      const spI = band.split * s;
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        const X = ctx.offsetX + (x + 0.5) * inv;
        let sxI = x - dxI;
        let syI = y;
        let kind = -1;
        for (let k = 0; k < rowBlocks.length; k++) {
          const b = rowBlocks[k];
          if (X >= b.x0 && X < b.x1) {
            kind = b.kind;
            if (kind === 0 || kind === 3) {
              sxI = x + b.sx * s;
              syI = Math.round(y + b.sy * s);
            }
            break;
          }
        }
        const aR = fetchAt(sxI - spI, syI, 3),
          aG = fetchAt(sxI, syI, 3),
          aB = fetchAt(sxI + spI, syI, 3);
        const A = Math.max(aR, aG, aB, 0);
        if (A <= 0) {
          data[j] = data[j + 1] = data[j + 2] = data[j + 3] = 0;
          continue;
        }
        let r = aR > 0 ? fetchAt(sxI - spI, syI, 0) : 0,
          g = aG > 0 ? fetchAt(sxI, syI, 1) : 0,
          b = aB > 0 ? fetchAt(sxI + spI, syI, 2) : 0;
        // premultiply-weight channels whose source alpha is lower than the output alpha
        r = (r * Math.max(0, aR)) / A;
        g = (g * Math.max(0, aG)) / A;
        b = (b * Math.max(0, aB)) / A;
        if (band.invert || kind === 1) {
          r = 255 - r;
          g = 255 - g;
          b = 255 - b;
        }
        if (kind === 2) {
          // crushed palette block
          r = r > 127 ? 255 : 0;
          g = g > 110 ? 230 : 20;
          b = b > 140 ? 255 : 40;
        } else if (kind === 3) {
          const t = g;
          g = b;
          b = t;
        }
        data[j] = r;
        data[j + 1] = g;
        data[j + 2] = b;
        data[j + 3] = A;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Scanlines                                                           */
/* ------------------------------------------------------------------ */

/** Integral of a periodic box (1 on [0, duty·period) of each period) from 0 to t. */
export function boxIntegral(t: number, period: number, duty: number): number {
  const k = Math.floor(t / period);
  const r = t - k * period;
  const on = duty * period;
  return k * on + (r < on ? r : on);
}

export const scanlines: FilterDef = {
  id: 'scanlines',
  name: 'Scanlines',
  category: 'Retro & Glitch',
  icon: Rows3,
  description: 'Dark horizontal (or vertical) lines like an old monitor, anchored to the canvas.',
  keywords: ['crt', 'retro', 'monitor', 'arcade', 'lines', 'interlace'],
  params: [
    pxP('spacing', 'Spacing', 1, 40, 4, { step: 0.5 }),
    pctP('thickness', 'Line thickness', 0.5),
    pctP('opacity', 'Opacity', 0.35),
    colorP('color', 'Color', '#000000'),
    selectP('direction', 'Direction', [['horizontal', 'Horizontal'], ['vertical', 'Vertical']], 'horizontal'),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const s = sc(ctx);
    const sp = Math.max(0.5, num(p.spacing, 4));
    const duty = clamp(num(p.thickness, 0.5), 0, 1);
    const op = clamp(num(p.opacity, 0.35), 0, 1);
    if (op <= 0 || duty <= 0) return img;
    const col = rgb(p.color, '#000000');
    const vertical = str(p.direction, 'horizontal') === 'vertical';
    const inv = 1 / s;
    const len = vertical ? w : h;
    const cov = new Float32Array(len);
    const off = vertical ? ctx.offsetX : ctx.offsetY;
    for (let k = 0; k < len; k++) {
      // exact box-filtered coverage of the pixel's document span (no moiré at small scales)
      const t0 = off + k * inv,
        t1 = off + (k + 1) * inv;
      const base = Math.floor(Math.min(t0, 0) / sp) * sp - sp; // keep integrals positive
      cov[k] = ((boxIntegral(t1 - base, sp, duty) - boxIntegral(t0 - base, sp, duty)) / (t1 - t0)) * op;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const t = cov[vertical ? x : y];
        if (t <= 0) continue;
        data[j] += (col[0] - data[j]) * t;
        data[j + 1] += (col[1] - data[j + 1]) * t;
        data[j + 2] += (col[2] - data[j + 2]) * t;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* VHS                                                                 */
/* ------------------------------------------------------------------ */

export const vhs: FilterDef = {
  id: 'vhs',
  name: 'VHS',
  category: 'Retro & Glitch',
  icon: Tv,
  description: 'Worn videotape: chroma bleed, soft luma with ringing, line jitter, tracking noise band and tape hiss.',
  keywords: ['tape', '80s', '90s', 'analog', 'camcorder', 'retro', 'vaporwave'],
  params: [
    pctP('intensity', 'Intensity', 0.6),
    pxP('bleed', 'Color bleed', 0, 30, 5),
    pctP('tracking', 'Tracking error', 0.35),
    pctP('jitter', 'Line jitter', 0.3),
    pctP('noise', 'Tape noise', 0.3),
    seedP(4),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const s = sc(ctx);
    const inten = clamp(num(p.intensity, 0.6), 0, 1);
    const bleed = Math.max(0, num(p.bleed, 5)) * s;
    const tracking = clamp(num(p.tracking, 0.35), 0, 1);
    const jitter = clamp(num(p.jitter, 0.3), 0, 1);
    const noise = clamp(num(p.noise, 0.3), 0, 1);
    const seed = num(p.seed, 4) | 0;
    const inv = 1 / s;
    // YIQ planes (straight colors)
    const Y = new Float32Array(n),
      I = new Float32Array(n),
      Q = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = data[j] / 255,
        g = data[j + 1] / 255,
        b = data[j + 2] / 255;
      Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      I[i] = 0.596 * r - 0.274 * g - 0.322 * b;
      Q[i] = 0.211 * r - 0.523 * g + 0.312 * b;
    }
    // chroma smear (low bandwidth) + luma softening with edge ringing
    const Ib = bleed > 0.3 ? lineBoxBlur(I, w, h, 0, bleed, true) : I;
    const Qb = bleed > 0.3 ? lineBoxBlur(Q, w, h, 0, bleed, true) : Q;
    const Ys = lineBoxBlur(Y, w, h, 0, Math.max(0.5, 1.2 * s), true);
    const Yw = lineBoxBlur(Y, w, h, 0, Math.max(1, 3 * s), true);
    // tracking band position (document space)
    const bandY = (0.72 + hash(1, 2, seed) * 0.2) * ctx.docHeight;
    const bandH = ctx.docHeight * (0.03 + 0.05 * tracking);
    const src = { Y: Ys, I: Ib, Q: Qb };
    const chromaShift = bleed * 0.6;
    for (let y = 0; y < h; y++) {
      const DY = ctx.offsetY + (y + 0.5) * inv;
      const row = Math.floor(DY);
      // per-line horizontal jitter (doc px) + tracking band displacement
      let dx = (hashGauss(row, 0, seed) * 0.6 + (fbmValue(DY * 0.02, 0.5, seed + 3, 2) - 0.5) * 2) * jitter * 3;
      const bt = (DY - bandY) / bandH;
      const inBand = tracking > 0 && bt > -1 && bt < 1;
      const bandK = inBand ? (1 - Math.abs(bt)) ** 0.5 * tracking : 0;
      if (inBand) dx += (fbmValue(DY * 0.15, 3.3, seed + 9, 2) - 0.35) * 40 * bandK;
      const dxI = dx * s;
      const yo = y * w;
      for (let x = 0; x < w; x++) {
        const i = yo + x,
          j = i * 4;
        if (data[j + 3] === 0) continue;
        const fx = Math.min(w - 1, Math.max(0, x - dxI));
        const x0 = fx | 0,
          x1 = x0 < w - 1 ? x0 + 1 : x0,
          t = fx - x0;
        let yy = src.Y[yo + x0] * (1 - t) + src.Y[yo + x1] * t;
        // ringing: add back a bit of the high-pass of the wide blur (overshoot at edges)
        yy += (yy - (Yw[yo + x0] * (1 - t) + Yw[yo + x1] * t)) * 0.5 * inten;
        const cxf = Math.min(w - 1, Math.max(0, fx - chromaShift));
        const c0 = cxf | 0,
          c1 = c0 < w - 1 ? c0 + 1 : c0,
          ct = cxf - c0;
        let ii = src.I[yo + c0] * (1 - ct) + src.I[yo + c1] * ct;
        let qq = src.Q[yo + c0] * (1 - ct) + src.Q[yo + c1] * ct;
        // tape look: lifted blacks, softer whites, slightly reduced/warmer chroma
        yy = 0.05 * inten + yy * (1 - 0.12 * inten);
        ii = ii * (1 - 0.1 * inten) + 0.015 * inten;
        qq = qq * (1 - 0.2 * inten);
        const X = Math.floor(ctx.offsetX + (x + 0.5) * inv);
        if (noise > 0) {
          yy += hashGauss(X, row, seed + 17) * 0.06 * noise;
          // sparse horizontal dropout streaks
          const seg = Math.floor(X / 40);
          if (hash(seg, row, seed + 23) > 1 - noise * 0.004) yy += 0.6 * (1 - ((X % 40) / 40));
        }
        if (inBand) {
          yy = yy * (1 - bandK * 0.5) + hash(X >> 1, row, seed + 31) * bandK * 0.7;
          ii *= 1 - bandK;
          qq *= 1 - bandK;
        }
        // faint interlace lines
        if (row % 2 === 0) yy *= 1 - 0.06 * inten;
        const r = yy + 0.956 * ii + 0.621 * qq,
          g = yy - 0.272 * ii - 0.647 * qq,
          b = yy - 1.106 * ii + 1.703 * qq;
        data[j] = r * 255;
        data[j + 1] = g * 255;
        data[j + 2] = b * 255;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* CRT                                                                 */
/* ------------------------------------------------------------------ */

export const crt: FilterDef = {
  id: 'crt',
  name: 'CRT Screen',
  category: 'Retro & Glitch',
  icon: Monitor,
  description: 'Curved tube screen with RGB phosphor mask, scanlines, glow and dark corners.',
  keywords: ['monitor', 'arcade', 'retro', 'tube', 'tv', 'phosphor'],
  params: [
    pctP('curvature', 'Curvature', 0.25),
    pctP('scanlines', 'Scanlines', 0.5),
    pctP('mask', 'Phosphor mask', 0.45),
    pxP('pixel', 'Mask size', 1, 12, 3, { step: 0.5 }),
    pctP('glow', 'Glow', 0.35),
    pctP('vignette', 'Vignette', 0.45),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const curv = clamp(num(p.curvature, 0.25), 0, 1);
    const scan = clamp(num(p.scanlines, 0.5), 0, 1);
    const maskK = clamp(num(p.mask, 0.45), 0, 1);
    const px = Math.max(0.5, num(p.pixel, 3)) * s;
    const glowK = clamp(num(p.glow, 0.35), 0, 1);
    const vig = clamp(num(p.vignette, 0.45), 0, 1);
    const P = premulPlanes(img);
    const r = new Float32Array(n),
      g = new Float32Array(n),
      b = new Float32Array(n),
      a = new Float32Array(n);
    const edgeFade = new Float32Array(n);
    const k = curv * 0.32;
    const cx = w / 2,
      cy = h / 2;
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5 - cy) / cy;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const u = (x + 0.5 - cx) / cx;
        const r2 = u * u + v * v;
        const f = 1 + k * r2;
        const su = u * f,
          sv = v * f;
        // smooth bezel edge (rounded corners come from the barrel mapping)
        const e = Math.min(1 - Math.abs(su), 1 - Math.abs(sv));
        const fade = smoothstep(0, 0.012 + curv * 0.02, e);
        edgeFade[i] = fade;
        if (fade <= 0) continue;
        const fx = su * cx + cx - 0.5,
          fy = sv * cy + cy - 0.5;
        r[i] = bil(P.r, w, h, fx, fy, true);
        g[i] = bil(P.g, w, h, fx, fy, true);
        b[i] = bil(P.b, w, h, fx, fy, true);
        a[i] = bil(P.a, w, h, fx, fy, true);
      }
    }
    const glow = glowK > 0 ? [r, g, b].map((pl) => blurPlaneMultires(pl, w, h, Math.max(1, px * 2.5), (q, ww, hh, sg) => void blurPlane(q, ww, hh, sg))) : null;
    const triad = px * 3;
    const origA = new Float32Array(n);
    for (let i = 0; i < n; i++) origA[i] = data[i * 4 + 3] / 255;
    for (let y = 0; y < h; y++) {
      // scanline: sin² profile over rows of height `px` (box-averaged when px is tiny)
      const gy = y + 0.5 + ay;
      const ph = (gy / px) * Math.PI;
      const sl = px < 1.5 ? 1 - scan * 0.5 : 1 - scan * Math.pow(Math.sin(ph), 2) * 0.85;
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        if (origA[i] === 0) continue;
        const fade = edgeFade[i];
        const al = a[i];
        let R = al > 0 ? r[i] / al : 0,
          G = al > 0 ? g[i] / al : 0,
          B = al > 0 ? b[i] / al : 0;
        // aperture grille: each column triad lights R, G, B stripes
        if (maskK > 0) {
          const gx = x + 0.5 + ax;
          const m = ((gx % triad) + triad) % triad;
          const stripe = Math.floor(m / px);
          const dim = 1 - maskK * 0.65;
          const boost = 1 + maskK * 0.45;
          R *= (stripe === 0 ? 1 : dim) * boost;
          G *= (stripe === 1 ? 1 : dim) * boost;
          B *= (stripe === 2 ? 1 : dim) * boost;
        }
        R *= sl;
        G *= sl;
        B *= sl;
        if (glow) {
          const gk = glowK * 0.9;
          R = 1 - (1 - R) * (1 - glow[0][i] * gk);
          G = 1 - (1 - G) * (1 - glow[1][i] * gk);
          B = 1 - (1 - B) * (1 - glow[2][i] * gk);
        }
        if (vig > 0) {
          const u = (x + 0.5 - cx) / cx,
            v = (y + 0.5 - cy) / cy;
          const d = u * u * 0.5 + v * v * 0.5;
          const vv = 1 - vig * smoothstep(0.25, 1.05, d) * 0.85;
          R *= vv;
          G *= vv;
          B *= vv;
        }
        R *= fade;
        G *= fade;
        B *= fade;
        data[j] = R * 255;
        data[j + 1] = G * 255;
        data[j + 2] = B * 255;
        // the tube is opaque black outside the picture wherever the layer had pixels
        data[j + 3] = Math.max(al, 1 - fade) * origA[i] * 255;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* JPEG artifacts                                                      */
/* ------------------------------------------------------------------ */

const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** Quality (1..100) → scaled quant table for an N×N block (orthonormal DCT). */
export function quantTable(base: number[], quality: number, N: number): Float32Array {
  const q = clamp(Math.round(quality), 1, 100);
  const S = q < 50 ? 5000 / q : 200 - 2 * q;
  const out = new Float32Array(N * N);
  for (let v = 0; v < N; v++)
    for (let u = 0; u < N; u++) {
      const t = base[Math.min(7, Math.floor((v * 8) / N)) * 8 + Math.min(7, Math.floor((u * 8) / N))];
      out[v * N + u] = clamp(Math.floor((t * S + 50) / 100), 1, 255) * (N / 8);
    }
  return out;
}

function dctMatrix(N: number): Float32Array {
  const m = new Float32Array(N * N);
  for (let k = 0; k < N; k++) {
    const a = k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
    for (let x = 0; x < N; x++) m[k * N + x] = a * Math.cos(((2 * x + 1) * k * Math.PI) / (2 * N));
  }
  return m;
}

/** In-place JPEG-style DCT quantization of a plane (values 0..255) on an anchored N×N grid. */
export function jpegPlane(pl: Float32Array, w: number, h: number, N: number, Q: Float32Array, ox: number, oy: number) {
  const M = dctMatrix(N);
  const blk = new Float32Array(N * N),
    tmp = new Float32Array(N * N);
  const sx = -(((ox % N) + N) % N),
    sy = -(((oy % N) + N) % N);
  for (let by = sy; by < h; by += N) {
    for (let bx = sx; bx < w; bx += N) {
      // gather (clamped at the borders)
      for (let y = 0; y < N; y++) {
        const yy = Math.min(h - 1, Math.max(0, by + y));
        for (let x = 0; x < N; x++) {
          const xx = Math.min(w - 1, Math.max(0, bx + x));
          blk[y * N + x] = pl[yy * w + xx] - 128;
        }
      }
      // forward: tmp = M · blk · Mᵀ
      for (let v = 0; v < N; v++)
        for (let x = 0; x < N; x++) {
          let s0 = 0;
          for (let y = 0; y < N; y++) s0 += M[v * N + y] * blk[y * N + x];
          tmp[v * N + x] = s0;
        }
      for (let v = 0; v < N; v++)
        for (let u = 0; u < N; u++) {
          let s0 = 0;
          for (let x = 0; x < N; x++) s0 += tmp[v * N + x] * M[u * N + x];
          const q = Q[v * N + u];
          blk[v * N + u] = Math.round(s0 / q) * q;
        }
      // inverse: blk = Mᵀ · C · M
      for (let y = 0; y < N; y++)
        for (let u = 0; u < N; u++) {
          let s0 = 0;
          for (let v = 0; v < N; v++) s0 += M[v * N + y] * blk[v * N + u];
          tmp[y * N + u] = s0;
        }
      for (let y = 0; y < N; y++) {
        const yy = by + y;
        if (yy < 0 || yy >= h) continue;
        for (let x = 0; x < N; x++) {
          const xx = bx + x;
          if (xx < 0 || xx >= w) continue;
          let s0 = 0;
          for (let u = 0; u < N; u++) s0 += tmp[y * N + u] * M[u * N + x];
          pl[yy * w + xx] = s0 + 128;
        }
      }
    }
  }
}

export const jpegArtifacts: FilterDef = {
  id: 'jpeg-artifacts',
  name: 'JPEG Artifacts',
  category: 'Retro & Glitch',
  icon: FileImage,
  description: 'Real low-quality JPEG compression: 8×8 blocking, ringing and smeared chroma ("deep fried").',
  keywords: ['compression', 'deep fried', 'meme', 'blocky', 'low quality', 'artifact'],
  params: [
    numP('quality', 'Quality', 1, 100, 12, { step: 1 }),
    boolP('subsample', 'Chroma subsampling', true),
    numP('passes', 'Generations', 1, 4, 1, { step: 1 }),
    numP('saturation', 'Saturation', -100, 100, 0, { step: 1 }),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const N = clamp(Math.round(8 * s), 2, 16);
    const quality = num(p.quality, 12);
    const passes = clamp(Math.round(num(p.passes, 1)), 1, 4);
    const sub = bool(p.subsample, true);
    const satK = 1 + num(p.saturation, 0) / 100;
    const Y = new Float32Array(n),
      Cb = new Float32Array(n),
      Cr = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = data[j],
        g = data[j + 1],
        b = data[j + 2];
      Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      Cb[i] = 128 + (-0.168736 * r - 0.331264 * g + 0.5 * b) * satK;
      Cr[i] = 128 + (0.5 * r - 0.418688 * g - 0.081312 * b) * satK;
    }
    const qL = quantTable(LUMA_Q, quality, N);
    const qC = quantTable(CHROMA_Q, quality, N);
    for (let pass = 0; pass < passes; pass++) {
      // later generations re-encode on a slightly shifted grid like re-saved, re-cropped memes
      const sh = pass * 3;
      jpegPlane(Y, w, h, N, qL, Math.round(ax) + sh, Math.round(ay) + sh);
      for (const C of [Cb, Cr]) {
        if (sub && w > 1 && h > 1) {
          const w2 = Math.ceil(w / 2),
            h2 = Math.ceil(h / 2);
          const half = new Float32Array(w2 * h2);
          for (let y = 0; y < h2; y++)
            for (let x = 0; x < w2; x++) {
              const x0 = x * 2,
                y0 = y * 2;
              const x1 = Math.min(w - 1, x0 + 1),
                y1 = Math.min(h - 1, y0 + 1);
              half[y * w2 + x] = (C[y0 * w + x0] + C[y0 * w + x1] + C[y1 * w + x0] + C[y1 * w + x1]) * 0.25;
            }
          jpegPlane(half, w2, h2, N, qC, Math.round((ax + sh) / 2), Math.round((ay + sh) / 2));
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) C[y * w + x] = half[(y >> 1) * w2 + (x >> 1)];
        } else jpegPlane(C, w, h, N, qC, Math.round(ax) + sh, Math.round(ay) + sh);
      }
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (data[j + 3] === 0) continue;
      const yy = Y[i],
        cb = Cb[i] - 128,
        cr = Cr[i] - 128;
      data[j] = yy + 1.402 * cr;
      data[j + 1] = yy - 0.344136 * cb - 0.714136 * cr;
      data[j + 2] = yy + 1.772 * cb;
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Sepia & old photo                                                   */
/* ------------------------------------------------------------------ */

/** Sepia toning ramp: luminance (0..1) → [r,g,b] 0..255. `warmth` 0..1 shifts the midtones. */
export function sepiaTone(l: number, warmth: number): [number, number, number] {
  const t = clamp(l, 0, 1);
  const dark = [38, 24, 14],
    mid = [150 + warmth * 25, 104 + warmth * 6, 62 - warmth * 18],
    light = [250, 238, 214];
  if (t < 0.5) {
    const k = t * 2;
    return [dark[0] + (mid[0] - dark[0]) * k, dark[1] + (mid[1] - dark[1]) * k, dark[2] + (mid[2] - dark[2]) * k];
  }
  const k = (t - 0.5) * 2;
  return [mid[0] + (light[0] - mid[0]) * k, mid[1] + (light[1] - mid[1]) * k, mid[2] + (light[2] - mid[2]) * k];
}

export const sepia: FilterDef = {
  id: 'sepia',
  name: 'Sepia',
  category: 'Retro & Glitch',
  icon: Camera,
  description: 'Warm brown monochrome toning of an antique print.',
  keywords: ['vintage', 'brown', 'antique', 'old', 'toning', 'western'],
  params: [pctP('amount', 'Amount', 1), pctP('warmth', 'Warmth', 0.5), numP('contrast', 'Contrast', -100, 100, 0, { step: 1 })],
  apply(img, p) {
    const amt = clamp(num(p.amount, 1), 0, 1);
    if (amt <= 0) return img;
    const warmth = clamp(num(p.warmth, 0.5), 0, 1);
    const ck = 1 + num(p.contrast, 0) / 100;
    const lut = new Uint8ClampedArray(256 * 3);
    for (let v = 0; v < 256; v++) {
      const l = clamp((v / 255 - 0.5) * ck + 0.5, 0, 1);
      const c = sepiaTone(l, warmth);
      lut[v * 3] = c[0];
      lut[v * 3 + 1] = c[1];
      lut[v * 3 + 2] = c[2];
    }
    const d = img.data;
    for (let j = 0; j < d.length; j += 4) {
      if (d[j + 3] === 0) continue;
      const l = Math.round(d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722);
      const k = (l < 0 ? 0 : l > 255 ? 255 : l) * 3;
      d[j] += (lut[k] - d[j]) * amt;
      d[j + 1] += (lut[k + 1] - d[j + 1]) * amt;
      d[j + 2] += (lut[k + 2] - d[j + 2]) * amt;
    }
    return img;
  },
};

export const oldPhoto: FilterDef = {
  id: 'old-photo',
  name: 'Old Photo',
  category: 'Retro & Glitch',
  icon: ScanLine,
  description: 'Aged print: faded toning, uneven exposure, grain, scratches, dust and dark corners.',
  keywords: ['vintage', 'aged', 'antique', 'film', 'scratched', 'dust', 'faded'],
  params: [
    selectP('tone', 'Tone', [['sepia', 'Sepia'], ['bw', 'Black & white'], ['faded', 'Faded color']], 'sepia'),
    pctP('age', 'Age', 0.6),
    pctP('scratches', 'Scratches', 0.4),
    pctP('dust', 'Dust', 0.4),
    pctP('grain', 'Grain', 0.35),
    pctP('vignette', 'Vignette', 0.5),
    seedP(11),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const s = sc(ctx);
    const tone = str(p.tone, 'sepia');
    const age = clamp(num(p.age, 0.6), 0, 1);
    const scr = clamp(num(p.scratches, 0.4), 0, 1);
    const dust = clamp(num(p.dust, 0.4), 0, 1);
    const grain = clamp(num(p.grain, 0.35), 0, 1);
    const vig = clamp(num(p.vignette, 0.5), 0, 1);
    const seed = num(p.seed, 11) | 0;
    const DW = ctx.docWidth,
      DH = ctx.docHeight;
    const vo = { docW: DW, docH: DH, cx: DW / 2, cy: DH / 2, size: 0.55, roundness: 0.2, feather: 0.75 };
    // scratches: vertical hairlines at seeded document x positions
    const rnd = prng(seed * 31 + 5);
    const nS = Math.round(scr * 14);
    const scratches = Array.from({ length: nS }, () => ({
      x: rnd() * DW,
      y0: rnd() * DH * 0.6,
      len: (0.3 + rnd() * 0.9) * DH,
      wdt: 0.6 + rnd() * 1.4,
      light: rnd() > 0.35,
      wob: rnd() * 1000,
      str: 0.35 + rnd() * 0.5,
    }));
    const inv = 1 / s;
    const ox = ctx.offsetX,
      oy = ctx.offsetY;
    // smooth, low-frequency fields on a coarse grid (blotches, vignette)
    const step = Math.max(1, Math.min(8, Math.round(6 * s)));
    const blotch = coarseField(w, h, step, (x, y) => (fbmValue((ox + (x + 0.5) * inv) * 0.004, (oy + (y + 0.5) * inv) * 0.004, seed + 1, 3) - 0.5) * 0.35 * age);
    const vigF = vig > 0 ? coarseField(w, h, step, (x, y) => vignetteAt(ox + (x + 0.5) * inv, oy + (y + 0.5) * inv, vo) * vig * 0.8) : null;
    // sepia toning ramp as a LUT
    const LUT_N = 1024;
    const sep = new Float32Array((LUT_N + 1) * 3);
    if (tone === 'sepia') {
      for (let k = 0; k <= LUT_N; k++) {
        const c = sepiaTone(k / LUT_N, 0.4 + age * 0.3);
        sep[k * 3] = c[0] / 255;
        sep[k * 3 + 1] = c[1] / 255;
        sep[k * 3 + 2] = c[2] / 255;
      }
    }
    // dust specks: one optional speck per 36 px document cell, precomputed for the covered area
    const cell = 36;
    const dustP = dust * 0.22;
    const cx0 = Math.floor(ox / cell) - 1,
      cy0 = Math.floor(oy / cell) - 1;
    const ncx = Math.floor((ox + w * inv) / cell) - cx0 + 2,
      ncy = Math.floor((oy + h * inv) / cell) - cy0 + 2;
    const spX = new Float32Array(ncx * ncy),
      spY = new Float32Array(ncx * ncy),
      spR = new Float32Array(ncx * ncy),
      spK = new Int8Array(ncx * ncy); // 0 none, 1 light, -1 dark
    if (dustP > 0) {
      for (let j = 0; j < ncy; j++)
        for (let i = 0; i < ncx; i++) {
          const hx = i + cx0,
            hy = j + cy0;
          if (hash(hx, hy, seed + 41) > dustP) continue;
          const q = j * ncx + i;
          spX[q] = (hx + hash(hx, hy, seed + 42)) * cell;
          spY[q] = (hy + hash(hx, hy, seed + 43)) * cell;
          spR[q] = 0.6 + hash(hx, hy, seed + 44) * 2.4;
          spK[q] = hash(hx, hy, seed + 45) > 0.5 ? 1 : -1;
        }
    }
    const fadeA = 0.08 * age,
      fadeK = 1 - 0.2 * age;
    const satF = 1 - 0.55 * age;
    for (let y = 0; y < h; y++) {
      const Y = oy + (y + 0.5) * inv;
      const cyI = Math.floor(Y / cell) - cy0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x,
          j = i * 4;
        if (data[j + 3] === 0) continue;
        const X = ox + (x + 0.5) * inv;
        let r = data[j] / 255,
          g = data[j + 1] / 255,
          b = data[j + 2] / 255;
        const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
        // fading: lifted blacks, dulled whites, reduced contrast, chemical blotches
        const bl = blotch[i] * 0.5;
        if (tone === 'faded') {
          r = fadeA + (l + (r - l) * satF) * fadeK + bl + 0.04 * age;
          g = fadeA + (l + (g - l) * satF) * fadeK + bl + 0.02 * age;
          b = fadeA + (l + (b - l) * satF) * fadeK + bl - 0.03 * age;
        } else {
          const lf = fadeA + l * fadeK + bl;
          if (tone === 'sepia') {
            const k = (lf <= 0 ? 0 : lf >= 1 ? LUT_N : (lf * LUT_N + 0.5) | 0) * 3;
            r = sep[k];
            g = sep[k + 1];
            b = sep[k + 2];
          } else r = g = b = lf;
        }
        let m = vigF ? 1 - vigF[i] : 1; // multiplicative darkening
        let add = 0; // additive lightening
        if (grain > 0) add += hashGauss(Math.floor(X), Math.floor(Y), seed + 3) * 0.07 * grain;
        for (let k = 0; k < scratches.length; k++) {
          const S = scratches[k];
          if (Y < S.y0 || Y > S.y0 + S.len) continue;
          const xx = S.x + Math.sin((Y + S.wob) * 0.011) * 6 + Math.sin((Y + S.wob) * 0.047) * 1.5;
          const dd = Math.abs(X - xx);
          if (dd > S.wdt + inv) continue;
          const cov = clamp(S.wdt * 0.5 + 0.5 * inv - dd, 0, inv) / inv; // box-filtered line
          const fadeEnds = smoothstep(0, 60, Y - S.y0) * smoothstep(0, 60, S.y0 + S.len - Y);
          const v = cov * S.str * fadeEnds;
          if (S.light) add += v * 0.7;
          else m *= 1 - v * 0.6;
        }
        if (dustP > 0) {
          const cxI = Math.floor(X / cell) - cx0;
          for (let dy = -1; dy <= 1; dy++) {
            const jj = cyI + dy;
            if (jj < 0 || jj >= ncy) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const ii = cxI + dx;
              if (ii < 0 || ii >= ncx) continue;
              const q = jj * ncx + ii;
              const kind = spK[q];
              if (!kind) continue;
              const ex = X - spX[q],
                ey = Y - spY[q];
              const rad = spR[q] + inv;
              if (ex * ex + ey * ey > rad * rad) continue;
              const cov = clamp(spR[q] + 0.5 * inv - Math.sqrt(ex * ex + ey * ey), 0, inv) / inv;
              if (kind > 0) add += cov * 0.55;
              else m *= 1 - cov * 0.7;
            }
          }
        }
        data[j] = (r * m + add) * 255;
        data[j + 1] = (g * m + add) * 255;
        data[j + 2] = (b * m + add * 0.95) * 255;
      }
    }
    return img;
  },
};

export const retroFilters: FilterDef[] = [chromaticAberration, glitch, scanlines, vhs, crt, jpegArtifacts, sepia, oldPhoto];
