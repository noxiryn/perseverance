/** Light filters: vignette (adjustment), bloom, soft glow, light rays, god rays, lens flare, color glow. */
import { Flame, Lightbulb, Sparkle, Sun, Sunrise, SunDim, Aperture } from 'lucide-react';
import type { FilterDef } from '../../../registry';
import type { Img } from '../util';
import { anchor, blurPlane, bool, clamp, hash, isEmpty, num, pt, rgb, sc, smoothstep, str, toPlanes } from '../util';
import { blurPlaneMultires, downsamplePlane, radialAccumulate, upsamplePlane } from '../ops';
import { hasTransparency } from '../edges';
import { boolP, colorP, numP, pctP, pointP, pxP, seedP, selectP } from '../params';

const blurFn = (b: Float32Array, w: number, h: number, s: number) => void blurPlane(b, w, h, s);

/* ------------------------------------------------------------------ */
/* Vignette (document anchored)                                        */
/* ------------------------------------------------------------------ */

/**
 * Vignette strength 0..1 at document point (X, Y). Exported for unit tests.
 * Shape: ellipse fitted to the document (roundness 0), circle (1) or rounded rectangle (-1).
 */
export function vignetteAt(
  X: number,
  Y: number,
  o: { docW: number; docH: number; cx: number; cy: number; size: number; roundness: number; feather: number },
): number {
  const rc = Math.hypot(o.docW, o.docH) / (2 * Math.SQRT2);
  const rnd = clamp(o.roundness, -1, 1);
  const k = Math.max(0, rnd);
  const rx = o.docW / 2 + (rc - o.docW / 2) * k;
  const ry = o.docH / 2 + (rc - o.docH / 2) * k;
  const u = Math.abs(X - o.cx) / rx,
    v = Math.abs(Y - o.cy) / ry;
  let d: number;
  if (rnd < 0) {
    const pw = 2 + -rnd * 8;
    d = Math.pow(Math.pow(u, pw) + Math.pow(v, pw), 1 / pw);
  } else d = Math.sqrt(u * u + v * v);
  const c = 0.2 + clamp(o.size, 0, 1) * 1.05;
  const fw = 0.04 + clamp(o.feather, 0, 1) * 1.4;
  return smoothstep(c - fw * 0.5, c + fw * 0.5, d);
}

export const vignette: FilterDef = {
  id: 'vignette',
  name: 'Vignette',
  category: 'Light',
  adjustment: true,
  icon: Aperture,
  description: 'Darkens (or tints) the edges of the canvas. Anchored to the document, whatever layer it is applied to.',
  keywords: ['edges', 'darken', 'frame', 'focus', 'cinematic', 'corners'],
  params: [
    pctP('amount', 'Amount', 0.5),
    pctP('size', 'Size', 0.6),
    numP('roundness', 'Roundness', -1, 1, 0, { step: 0.01, displayScale: 100, unit: '%' }),
    pctP('feather', 'Feather', 0.5),
    colorP('color', 'Color', '#000000'),
    pointP('center', 'Center', { x: 0.5, y: 0.5 }),
  ],
  apply(img, p, ctx) {
    const amount = clamp(num(p.amount, 0.5), 0, 1);
    if (amount <= 0) return img;
    const { width: w, height: h, data } = img;
    const s = sc(ctx);
    const col = rgb(p.color, '#000000');
    const c = pt(p.center);
    const o = {
      docW: ctx.docWidth,
      docH: ctx.docHeight,
      cx: c.x * ctx.docWidth,
      cy: c.y * ctx.docHeight,
      size: num(p.size, 0.6),
      roundness: num(p.roundness, 0),
      feather: num(p.feather, 0.5),
    };
    const inv = 1 / s;
    for (let y = 0; y < h; y++) {
      const Y = ctx.offsetY + (y + 0.5) * inv;
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const X = ctx.offsetX + (x + 0.5) * inv;
        const t = vignetteAt(X, Y, o) * amount;
        if (t <= 0.0005) continue;
        data[j] += (col[0] - data[j]) * t;
        data[j + 1] += (col[1] - data[j + 1]) * t;
        data[j + 2] += (col[2] - data[j + 2]) * t;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Shared: glow compositing                                            */
/* ------------------------------------------------------------------ */

/**
 * Screen light planes (0..1, "emitted light") over the image. With `spill`, light also lands on
 * transparent pixels (alpha grows); otherwise only existing pixels are lit.
 */
function screenLight(img: Img, gr: Float32Array, gg: Float32Array, gb: Float32Array, k: number, spill: boolean) {
  const d = img.data;
  const n = img.width * img.height;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let lr = gr[i] * k,
      lg = gg[i] * k,
      lb = gb[i] * k;
    if (lr < 0.001 && lg < 0.001 && lb < 0.001) continue;
    lr = lr > 1 ? 1 : lr;
    lg = lg > 1 ? 1 : lg;
    lb = lb > 1 ? 1 : lb;
    const a = d[j + 3] / 255;
    if (a >= 0.999 || !spill) {
      if (a === 0) continue;
      d[j] += (255 - d[j]) * lr;
      d[j + 1] += (255 - d[j + 1]) * lg;
      d[j + 2] += (255 - d[j + 2]) * lb;
      continue;
    }
    // premultiplied screen: Cp' = Cp + L(1 − Cp), A' = A + max(L)(1 − A)
    const pr = (d[j] / 255) * a,
      pg = (d[j + 1] / 255) * a,
      pb = (d[j + 2] / 255) * a;
    const nr = pr + lr * (1 - pr),
      ng = pg + lg * (1 - pg),
      nb = pb + lb * (1 - pb);
    const lm = lr > lg ? (lr > lb ? lr : lb) : lg > lb ? lg : lb;
    const na = a + lm * (1 - a);
    if (na <= 0.002) continue;
    d[j] = (nr / na) * 255;
    d[j + 1] = (ng / na) * 255;
    d[j + 2] = (nb / na) * 255;
    d[j + 3] = na * 255;
  }
}

/** Soft-knee bright pass → premultiplied light planes. */
function brightPass(img: Img, threshold: number, knee = 0.12) {
  const d = img.data;
  const n = img.width * img.height;
  const r = new Float32Array(n),
    g = new Float32Array(n),
    b = new Float32Array(n);
  const lo = threshold - knee,
    hi = threshold + knee;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3] / 255;
    if (a === 0) continue;
    const R = d[j] / 255,
      G = d[j + 1] / 255,
      B = d[j + 2] / 255;
    const l = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const k = smoothstep(lo, hi, l) * a;
    if (k <= 0) continue;
    r[i] = R * k;
    g[i] = G * k;
    b[i] = B * k;
  }
  return { r, g, b };
}

/* ------------------------------------------------------------------ */
/* Bloom                                                               */
/* ------------------------------------------------------------------ */

export const bloom: FilterDef = {
  id: 'bloom',
  name: 'Bloom',
  category: 'Light',
  icon: Sun,
  description: 'Bright areas bleed light into their surroundings (multi-scale glow).',
  keywords: ['glow', 'highlights', 'dreamy', 'hdr', 'light'],
  params: [
    pctP('threshold', 'Threshold', 0.7),
    pxP('radius', 'Radius', 1, 300, 30),
    numP('intensity', 'Intensity', 0, 3, 1, { step: 0.01 }),
    pctP('saturation', 'Glow saturation', 1, {}, 0, 2),
    boolP('spill', 'Glow outside shapes', true),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h } = img;
    const n = w * h;
    const r = Math.max(1, num(p.radius, 30)) * sc(ctx);
    const k = clamp(num(p.intensity, 1), 0, 3);
    if (k <= 0) return img;
    const bp = brightPass(img, clamp(num(p.threshold, 0.7), 0, 1));
    const sat = clamp(num(p.saturation, 1), 0, 2);
    const scales = [
      { s: r * 0.2, w: 0.45 },
      { s: r * 0.5, w: 0.35 },
      { s: r, w: 0.3 },
    ];
    const gl = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const src = [bp.r, bp.g, bp.b];
    for (const sc0 of scales) {
      for (let c = 0; c < 3; c++) {
        const bl = blurPlaneMultires(src[c], w, h, Math.max(0.5, sc0.s), blurFn);
        const o = gl[c];
        for (let i = 0; i < n; i++) o[i] += bl[i] * sc0.w;
      }
    }
    if (Math.abs(sat - 1) > 0.01) {
      for (let i = 0; i < n; i++) {
        const l = gl[0][i] * 0.2126 + gl[1][i] * 0.7152 + gl[2][i] * 0.0722;
        gl[0][i] = Math.max(0, l + (gl[0][i] - l) * sat);
        gl[1][i] = Math.max(0, l + (gl[1][i] - l) * sat);
        gl[2][i] = Math.max(0, l + (gl[2][i] - l) * sat);
      }
    }
    screenLight(img, gl[0], gl[1], gl[2], k * 1.3, bool(p.spill, true));
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Soft glow (Orton)                                                   */
/* ------------------------------------------------------------------ */

export const glow: FilterDef = {
  id: 'glow',
  name: 'Soft Glow',
  category: 'Light',
  icon: SunDim,
  description: 'Dreamy diffuse glow (Orton effect): luminous, soft, yet keeps contrast.',
  keywords: ['orton', 'dreamy', 'diffuse', 'soft focus', 'bloom', 'ethereal'],
  params: [pxP('radius', 'Radius', 1, 150, 18), pctP('intensity', 'Intensity', 0.5), pctP('brightness', 'Brightness', 0.35)],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const k = clamp(num(p.intensity, 0.5), 0, 1);
    if (k <= 0) return img;
    const r = Math.max(1, num(p.radius, 18)) * sc(ctx);
    const br = 1 + clamp(num(p.brightness, 0.35), 0, 1) * 2;
    const P = toPlanes(img, true);
    // brightened copy (premultiplied straight-screen approximation)
    const bright = [P.r, P.g, P.b].map((pl) => {
      const o = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = P.a[i];
        if (a <= 0) continue;
        const c = pl[i] / a;
        o[i] = (1 - Math.pow(1 - c, br)) * a;
      }
      return o;
    });
    const blurred = bright.map((b) => blurPlaneMultires(b, w, h, r, blurFn));
    const ab = blurPlaneMultires(P.a, w, h, r, blurFn);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3];
      if (a === 0) continue;
      const af = a / 255;
      const bA = Math.max(ab[i], 1e-4);
      for (let c = 0; c < 3; c++) {
        const orig = data[j + c] / 255;
        const s = bright[c][i] / af; // brightened straight
        const bl = Math.min(1, blurred[c][i] / bA); // blurred straight
        const orton = s * bl + (1 - s * bl) * bl * 0.25; // multiply + a touch of screen
        data[j + c] = (orig + (orton - orig) * k) * 255;
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Light rays (procedural beams)                                       */
/* ------------------------------------------------------------------ */

export const lightRays: FilterDef = {
  id: 'light-rays',
  name: 'Light Rays',
  category: 'Light',
  icon: Sunrise,
  description: 'Crepuscular sunbeams fanning out from a point on the canvas.',
  keywords: ['god rays', 'sunbeams', 'crepuscular', 'shafts', 'burst', 'holy'],
  params: [
    pointP('center', 'Source', { x: 0.5, y: 0.12 }),
    numP('rays', 'Rays', 3, 160, 28, { step: 1 }),
    pctP('length', 'Length', 0.65),
    numP('intensity', 'Intensity', 0, 2, 0.8, { step: 0.01 }),
    pctP('spread', 'Beam width', 0.5),
    colorP('color', 'Color', '#fff1c9'),
    seedP(3),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const s = sc(ctx);
    const c = pt(p.center, { x: 0.5, y: 0.12 });
    const cx = c.x * ctx.docWidth,
      cy = c.y * ctx.docHeight;
    const rays = clamp(Math.round(num(p.rays, 28)), 3, 160);
    const len = Math.max(0.02, clamp(num(p.length, 0.65), 0, 1));
    const k = clamp(num(p.intensity, 0.8), 0, 2);
    const spread = clamp(num(p.spread, 0.5), 0, 1);
    const col = rgb(p.color, '#fff1c9').map((v) => v / 255);
    const seed = num(p.seed, 3) | 0;
    const diag = Math.hypot(ctx.docWidth, ctx.docHeight);
    const gamma = 1 + (1 - spread) * 6;
    // per-ray random strength (periodic in angle)
    const amp = new Float32Array(rays);
    for (let i = 0; i < rays; i++) amp[i] = Math.pow(hash(i, 3, seed), 0.7);
    const amp2N = rays * 3 + 1;
    const amp2 = new Float32Array(amp2N);
    for (let i = 0; i < amp2N; i++) amp2[i] = hash(i, 7, seed + 11);
    const inv = 1 / s;
    for (let y = 0; y < h; y++) {
      const Y = ctx.offsetY + (y + 0.5) * inv;
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const X = ctx.offsetX + (x + 0.5) * inv;
        const dx = X - cx,
          dy = Y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) / diag;
        const th = (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1;
        // primary beams
        const u = th * rays;
        const i0 = Math.floor(u) % rays,
          i1 = (i0 + 1) % rays;
        let f = u - Math.floor(u);
        f = f * f * (3 - 2 * f);
        const tri = 1 - Math.abs(f - 0.5) * 2; // peak between samples → beam centers
        let beam = (amp[i0] + (amp[i1] - amp[i0]) * f) * Math.pow(tri, gamma * 0.6);
        // secondary finer variation
        const u2 = th * (amp2N - 1);
        const j0 = Math.floor(u2),
          f2 = u2 - j0;
        beam *= 0.55 + 0.45 * (amp2[j0] + (amp2[(j0 + 1) % amp2N] - amp2[j0]) * f2);
        const fall = Math.exp(-dist / (len * 0.55)) * smoothstep(0, 0.02, dist);
        const core = Math.exp(-dist / 0.035) * 0.6;
        const L = (beam * fall + core) * k;
        if (L < 0.002) continue;
        data[j] += (255 - data[j]) * Math.min(1, L * col[0]);
        data[j + 1] += (255 - data[j + 1]) * Math.min(1, L * col[1]);
        data[j + 2] += (255 - data[j + 2]) * Math.min(1, L * col[2]);
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* God rays (volumetric scattering of the image's highlights)          */
/* ------------------------------------------------------------------ */

export const godRays: FilterDef = {
  id: 'god-rays',
  name: 'God Rays',
  category: 'Light',
  icon: Lightbulb,
  description: 'Volumetric light: bright areas stream rays away from a light source (through gaps between shapes).',
  keywords: ['volumetric', 'light shafts', 'scattering', 'rays', 'backlight'],
  params: [
    pointP('center', 'Light source', { x: 0.5, y: 0.3 }),
    pctP('length', 'Length', 0.5),
    numP('intensity', 'Intensity', 0, 3, 1, { step: 0.01 }),
    pctP('threshold', 'Threshold', 0.55),
    colorP('color', 'Tint', '#fff4e0'),
    boolP('spill', 'Rays outside shapes', true),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h } = img;
    const n = w * h;
    const { ax, ay, s } = anchor(ctx);
    const len = clamp(num(p.length, 0.5), 0, 1);
    const k = clamp(num(p.intensity, 1), 0, 3);
    if (len <= 0.005 || k <= 0) return img;
    const c = pt(p.center, { x: 0.5, y: 0.3 });
    const cx = c.x * ctx.docWidth * s - ax - 0.5,
      cy = c.y * ctx.docHeight * s - ay - 0.5;
    const bp = brightPass(img, clamp(num(p.threshold, 0.55), 0, 1), 0.15);
    // each pixel gathers light from the segment toward the source (scales 1 → 1 − len)
    const span = Math.log(1 - len * 0.92);
    // shafts are soft: gather at reduced resolution on big images (~300k px) and upsample
    const f = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(n / 300000))));
    let res: Float32Array[];
    if (f > 1) {
      const small = [bp.r, bp.g, bp.b].map((pl) => downsamplePlane(pl, w, h, f));
      const sw = small[0].w,
        sh = small[0].h;
      const acc = radialAccumulate(
        small.map((s0) => s0.buf),
        sw,
        sh,
        (cx + 0.5) / f - 0.5,
        (cy + 0.5) / f - 0.5,
        'zoom',
        span,
        'transparent',
        false,
        10,
      );
      res = acc.map((pl) => upsamplePlane(pl, sw, sh, f, w, h));
    } else res = radialAccumulate([bp.r, bp.g, bp.b], w, h, cx, cy, 'zoom', span, 'transparent', false, 10);
    const tint = rgb(p.color, '#fff4e0').map((v) => v / 255);
    for (let i = 0; i < n; i++) {
      res[0][i] *= tint[0];
      res[1][i] *= tint[1];
      res[2][i] *= tint[2];
    }
    screenLight(img, res[0], res[1], res[2], k * 1.6, bool(p.spill, true));
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Lens flare                                                          */
/* ------------------------------------------------------------------ */

interface Ghost {
  t: number;
  r: number;
  a: number;
  col: [number, number, number];
  ring: boolean;
}

export const lensFlare: FilterDef = {
  id: 'lens-flare',
  name: 'Lens Flare',
  category: 'Light',
  icon: Sparkle,
  description: 'Camera lens flare: hot core, star streaks, anamorphic streak, halo and colored ghosts.',
  keywords: ['flare', 'sun', 'anamorphic', 'jj abrams', 'light', 'cinematic'],
  params: [
    pointP('position', 'Position', { x: 0.28, y: 0.25 }),
    numP('brightness', 'Brightness', 0, 2, 1, { step: 0.01 }),
    numP('size', 'Size', 0.2, 3, 1, { step: 0.01 }),
    colorP('color', 'Tint', '#ffd7a8'),
    selectP('style', 'Style', [['classic', 'Classic (ghosts)'], ['anamorphic', 'Anamorphic streak'], ['star', 'Star burst']], 'classic'),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const s = sc(ctx);
    const pos = pt(p.position, { x: 0.28, y: 0.25 });
    const D = Math.hypot(ctx.docWidth, ctx.docHeight);
    const fx = pos.x * ctx.docWidth,
      fy = pos.y * ctx.docHeight;
    const mx = ctx.docWidth / 2,
      my = ctx.docHeight / 2;
    const B = clamp(num(p.brightness, 1), 0, 2);
    const S = clamp(num(p.size, 1), 0.05, 5) * D;
    const tint = rgb(p.color, '#ffd7a8').map((v) => v / 255);
    const style = str(p.style, 'classic');
    const ghosts: Ghost[] =
      style === 'star'
        ? []
        : [
            { t: 0.45, r: 0.018, a: 0.35, col: [0.4, 1, 0.6], ring: false },
            { t: 0.7, r: 0.045, a: 0.18, col: [0.5, 0.7, 1], ring: false },
            { t: 1.05, r: 0.012, a: 0.4, col: [1, 0.8, 0.4], ring: false },
            { t: 1.3, r: 0.07, a: 0.12, col: [1, 0.5, 0.3], ring: true },
            { t: 1.6, r: 0.03, a: 0.22, col: [0.6, 0.4, 1], ring: false },
            { t: 2.05, r: 0.1, a: 0.08, col: [0.3, 0.8, 1], ring: true },
          ];
    const gx = ghosts.map((g) => fx + (mx - fx) * g.t),
      gy = ghosts.map((g) => fy + (my - fy) * g.t);
    const inv = 1 / s;
    const starRays = style === 'star' ? 8 : 6;
    for (let y = 0; y < h; y++) {
      const Y = ctx.offsetY + (y + 0.5) * inv;
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const X = ctx.offsetX + (x + 0.5) * inv;
        const dx = X - fx,
          dy = Y - fy;
        const d = Math.sqrt(dx * dx + dy * dy) / S;
        let lr = 0,
          lg = 0,
          lb = 0;
        // hot core + wide glow
        const core = Math.exp(-(d * d) / 0.00018) * 1.4 + Math.exp(-d / 0.06) * 0.45 + Math.exp(-d / 0.25) * 0.08;
        lr += core;
        lg += core * 0.92;
        lb += core * 0.8;
        // star streaks
        const th = Math.atan2(dy, dx);
        const star = Math.pow(Math.abs(Math.cos((th * starRays) / 2)), style === 'star' ? 120 : 260) * Math.exp(-d / (style === 'star' ? 0.22 : 0.12));
        lr += star * 0.7;
        lg += star * 0.7;
        lb += star * 0.75;
        // anamorphic horizontal streak
        if (style === 'anamorphic' || style === 'classic') {
          const st =
            Math.exp(-Math.abs(dy) / (S * (style === 'anamorphic' ? 0.0025 : 0.0015))) *
            Math.exp(-Math.abs(dx) / (S * (style === 'anamorphic' ? 0.5 : 0.18))) *
            (style === 'anamorphic' ? 0.9 : 0.35);
          lr += st * 0.55;
          lg += st * 0.75;
          lb += st * 1.1;
        }
        // halo ring with chromatic edge
        const hr = 0.16;
        const ringR = Math.exp(-((d - hr * 1.02) ** 2) / 0.00009),
          ringG = Math.exp(-((d - hr) ** 2) / 0.00009),
          ringB = Math.exp(-((d - hr * 0.98) ** 2) / 0.00009);
        lr += ringR * 0.12;
        lg += ringG * 0.1;
        lb += ringB * 0.12;
        // ghosts along the axis through the image center
        for (let g = 0; g < ghosts.length; g++) {
          const G = ghosts[g];
          const gd = Math.hypot(X - gx[g], Y - gy[g]) / S;
          if (gd > G.r * 1.3) continue;
          const disc = G.ring ? Math.exp(-((gd - G.r * 0.9) ** 2) / (G.r * G.r * 0.012)) : smoothstep(G.r, G.r * 0.75, gd) * (0.6 + 0.4 * (gd / G.r));
          const v = disc * G.a;
          lr += v * G.col[0];
          lg += v * G.col[1];
          lb += v * G.col[2];
        }
        lr *= B * tint[0];
        lg *= B * tint[1];
        lb *= B * tint[2];
        if (lr < 0.002 && lg < 0.002 && lb < 0.002) continue;
        data[j] += (255 - data[j]) * Math.min(1, lr);
        data[j + 1] += (255 - data[j + 1]) * Math.min(1, lg);
        data[j + 2] += (255 - data[j + 2]) * Math.min(1, lb);
      }
    }
    return img;
  },
};

/* ------------------------------------------------------------------ */
/* Color glow                                                          */
/* ------------------------------------------------------------------ */

export const colorGlow: FilterDef = {
  id: 'color-glow',
  name: 'Color Glow',
  category: 'Light',
  icon: Flame,
  description: 'Neon aura in a color around the subject’s silhouette (or from its highlights), plus inner edge light.',
  keywords: ['neon', 'aura', 'outer glow', 'rim', 'energy', 'power up'],
  params: [
    colorP('color', 'Color', '#ff2b4a'),
    pxP('size', 'Size', 1, 200, 26),
    numP('intensity', 'Intensity', 0, 3, 1.2, { step: 0.01 }),
    pctP('inner', 'Inner glow', 0.35),
    selectP('source', 'Source', [['auto', 'Auto'], ['silhouette', 'Silhouette'], ['highlights', 'Highlights']], 'auto'),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const col = rgb(p.color, '#ff2b4a').map((v) => v / 255);
    const size = Math.max(1, num(p.size, 26)) * sc(ctx);
    const k = clamp(num(p.intensity, 1.2), 0, 3);
    const inner = clamp(num(p.inner, 0.35), 0, 1);
    let src = str(p.source, 'auto');
    if (src === 'auto') src = hasTransparency(img) ? 'silhouette' : 'highlights';
    if (src === 'silhouette') {
      const A = new Float32Array(n);
      for (let i = 0; i < n; i++) A[i] = data[i * 4 + 3] / 255;
      const wide = blurPlaneMultires(A, w, h, size * 0.5, blurFn);
      const tight = blurPlaneMultires(A, w, h, Math.max(0.6, size * 0.12), blurFn);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const a = A[i];
        const glowA = clamp((wide[i] * 0.8 + tight[i] * 0.6) * k, 0, 1);
        if (a < 0.999) {
          // composite the pixel over the glow color
          const ga = glowA * (1 - a);
          const na = a + ga;
          if (na <= 0.002) continue;
          for (let c = 0; c < 3; c++) data[j + c] = ((data[j + c] / 255) * a + col[c] * ga) / na * 255;
          data[j + 3] = na * 255;
        }
        if (inner > 0 && a > 0) {
          // inner edge light: strongest where the blurred alpha drops (near the silhouette edge)
          const e = clamp((1 - tight[i]) * 2.2 + (1 - wide[i]) * 0.6, 0, 1) * inner * Math.min(1, k);
          if (e > 0.002) for (let c = 0; c < 3; c++) data[j + c] += (255 - data[j + c]) * col[c] * e;
        }
      }
      return img;
    }
    // highlights: bright areas emit colored light
    const L = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const l = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255;
      L[i] = smoothstep(0.45, 0.95, l) * (data[j + 3] / 255);
    }
    const g = blurPlaneMultires(L, w, h, size * 0.5, blurFn);
    const gr = new Float32Array(n),
      gg = new Float32Array(n),
      gb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = g[i] * (1 + inner);
      gr[i] = v * col[0];
      gg[i] = v * col[1];
      gb[i] = v * col[2];
    }
    screenLight(img, gr, gg, gb, k * 1.4, true);
    return img;
  },
};

export const lightFilters: FilterDef[] = [vignette, bloom, glow, lightRays, godRays, lensFlare, colorGlow];
