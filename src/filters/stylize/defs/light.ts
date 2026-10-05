/** Light filters: vignette (adjustment), bloom, soft glow, light rays, god rays, lens flare, color glow. */
import { Flame, Lightbulb, Sparkle, Sun, Sunrise, SunDim, Aperture } from 'lucide-react';
import type { FilterDef } from '../../../registry';
import type { Img } from '../util';
import { anchor, blurPlane, bool, clamp, hash, isEmpty, num, pixelWords, pt, rgb, sc, smoothstep, str, toPlanes } from '../util';
import { blurPlaneMultires, downsamplePlane, radialAccumulate, upsamplePlane } from '../ops';
import { hasTransparency } from '../edges';
import { boolP, colorP, numP, pctP, pointP, pxP, seedP, selectP } from '../params';

const blurFn = (b: Float32Array, w: number, h: number, s: number) => void blurPlane(b, w, h, s);

/* ------------------------------------------------------------------ */
/* Vignette (document anchored)                                        */
/* ------------------------------------------------------------------ */

export interface VignetteShape {
  docW: number;
  docH: number;
  cx: number;
  cy: number;
  size: number;
  roundness: number;
  feather: number;
}

/** Per-call constants of the vignette shape (hoisted out of the pixel loop). */
function vignettePrep(o: VignetteShape) {
  const rc = Math.hypot(o.docW, o.docH) / (2 * Math.SQRT2);
  const rnd = clamp(o.roundness, -1, 1);
  const k = Math.max(0, rnd);
  const rx = o.docW / 2 + (rc - o.docW / 2) * k;
  const ry = o.docH / 2 + (rc - o.docH / 2) * k;
  const c = 0.2 + clamp(o.size, 0, 1) * 1.05;
  const fw = 0.04 + clamp(o.feather, 0, 1) * 1.4;
  return { irx: 1 / rx, iry: 1 / ry, rnd, pw: 2 + -rnd * 8, e0: c - fw * 0.5, e1: c + fw * 0.5 };
}
type VPrep = ReturnType<typeof vignettePrep>;

function vignetteEval(u: number, v: number, P: VPrep): number {
  const d = P.rnd < 0 ? Math.pow(Math.pow(u, P.pw) + Math.pow(v, P.pw), 1 / P.pw) : Math.sqrt(u * u + v * v);
  if (d <= P.e0) return 0;
  if (d >= P.e1) return 1;
  const t = (d - P.e0) / (P.e1 - P.e0);
  return t * t * (3 - 2 * t);
}

/**
 * Vignette strength 0..1 at document point (X, Y). Exported for unit tests.
 * Shape: ellipse fitted to the document (roundness 0), circle (1) or rounded rectangle (-1).
 */
export function vignetteAt(X: number, Y: number, o: VignetteShape): number {
  const P = vignettePrep(o);
  return vignetteEval(Math.abs(X - o.cx) * P.irx, Math.abs(Y - o.cy) * P.iry, P);
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
    const shape: VignetteShape = {
      docW: ctx.docWidth,
      docH: ctx.docHeight,
      cx: c.x * ctx.docWidth,
      cy: c.y * ctx.docHeight,
      size: num(p.size, 0.6),
      roundness: num(p.roundness, 0),
      feather: num(p.feather, 0.5),
    };
    // The falloff only depends on the geometry → cached; amount / color edits only re-blend.
    const map = vignetteFalloff(w, h, ctx.offsetX, ctx.offsetY, s, shape);
    const kT = amount / 65535;
    const c0 = col[0],
      c1 = col[1],
      c2 = col[2];
    const u = pixelWords(img);
    if (u) {
      for (let i = 0, n = w * h; i < n; i++) {
        const q = map[i];
        if (q === 0) continue;
        const px = u[i];
        const a = px >>> 24;
        if (a === 0) continue;
        const t = q === 65535 ? amount : q * kT;
        if (t <= 0.0005) continue;
        // convex mix of two bytes stays within 0..255: round half to even like a byte store
        const r = px & 255,
          g = (px >> 8) & 255,
          b = (px >> 16) & 255;
        const fr = r + (c0 - r) * t,
          fg = g + (c1 - g) * t,
          fb = b + (c2 - b) * t;
        let ir = (fr + 0.5) | 0,
          ig = (fg + 0.5) | 0,
          ib = (fb + 0.5) | 0;
        if (ir - 0.5 === fr) ir &= ~1;
        if (ig - 0.5 === fg) ig &= ~1;
        if (ib - 0.5 === fb) ib &= ~1;
        u[i] = (a << 24) | (ib << 16) | (ig << 8) | ir;
      }
      return img;
    }
    for (let i = 0, j = 0, n = w * h; i < n; i++, j += 4) {
      const q = map[i];
      if (q === 0 || data[j + 3] === 0) continue;
      const t = q === 65535 ? amount : q * kT;
      if (t <= 0.0005) continue;
      data[j] += (c0 - data[j]) * t;
      data[j + 1] += (c1 - data[j + 1]) * t;
      data[j + 2] += (c2 - data[j + 2]) * t;
    }
    return img;
  },
};

/** Last few falloff maps (one per vignette geometry; 2 bytes per pixel). */
const falloffCache: { key: string; map: Uint16Array }[] = [];

/**
 * Vignette strength (0..65535 ≙ 0..1) for every pixel of a w×h image placed at (ox, oy) (doc px)
 * with the given preview scale. The shape is mirror-symmetric around the center, so each distinct
 * row offset and each distinct column offset is evaluated once (≈ ¼ of the pixels), and only the
 * feather band needs the root (sqrt, or the superellipse power for negative roundness).
 */
export function vignetteFalloff(w: number, h: number, ox: number, oy: number, s: number, o: VignetteShape): Uint16Array {
  const key = [w, h, ox, oy, s, o.docW, o.docH, o.cx, o.cy, o.size, o.roundness, o.feather].join(',');
  for (let k = 0; k < falloffCache.length; k++) {
    if (falloffCache[k].key === key) {
      const hit = falloffCache[k];
      if (k > 0) {
        falloffCache.splice(k, 1);
        falloffCache.unshift(hit);
      }
      return hit.map;
    }
  }
  const P = vignettePrep(o);
  const inv = 1 / s;
  // distinct |u| values: columns mirrored around the center share one evaluation
  const colIdx = new Int32Array(w);
  const uniq: number[] = [];
  const seen = new Map<number, number>();
  for (let x = 0; x < w; x++) {
    const uu = Math.fround(Math.abs(ox + (x + 0.5) * inv - o.cx) * P.irx);
    let k = seen.get(uu);
    if (k === undefined) {
      k = uniq.length;
      uniq.push(uu);
      seen.set(uu, k);
    }
    colIdx[x] = k;
  }
  const nu = uniq.length;
  const round = P.rnd < 0;
  const pw = P.pw;
  // per distinct column: u² (or u^pw)
  const UP = new Float64Array(nu);
  for (let k = 0; k < nu; k++) UP[k] = round ? Math.pow(uniq[k], pw) : uniq[k] * uniq[k];
  const e0 = P.e0,
    e1 = P.e1,
    span = e1 - e0;
  // thresholds in the same (squared / powered) space: inside e0 → 0, beyond e1 → 1
  const lo = e0 <= 0 ? -1 : round ? Math.pow(e0, pw) : e0 * e0;
  const hi = round ? Math.pow(e1, pw) : e1 * e1;
  const invPw = 1 / pw;
  const rowVals = new Uint16Array(nu);
  const map = new Uint16Array(w * h);
  const rowOf = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    const v = Math.abs(oy + (y + 0.5) * inv - o.cy) * P.iry;
    const prev = rowOf.get(v);
    if (prev !== undefined) {
      map.copyWithin(y * w, prev * w, prev * w + w);
      continue;
    }
    rowOf.set(v, y);
    const vp = round ? Math.pow(v, pw) : v * v;
    for (let k = 0; k < nu; k++) {
      const sum = UP[k] + vp;
      let q: number;
      if (sum <= lo) q = 0;
      else if (sum >= hi) q = 65535;
      else {
        const d = round ? Math.pow(sum, invPw) : Math.sqrt(sum);
        if (d <= e0) q = 0;
        else if (d >= e1) q = 65535;
        else {
          const t = (d - e0) / span;
          q = Math.round(t * t * (3 - 2 * t) * 65535);
        }
      }
      rowVals[k] = q;
    }
    const row = y * w;
    for (let x = 0; x < w; x++) map[row + x] = rowVals[colIdx[x]];
  }
  falloffCache.unshift({ key, map });
  if (falloffCache.length > 3) falloffCache.length = 3;
  return map;
}

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

/**
 * Screen one pixel with light (lr, lg, lb ≥ 0, clamped to 1). Opaque pixels brighten; with
 * `spill`, transparent ones receive the light as new coverage (premultiplied screen), so light
 * effects also work on an empty layer.
 */
function screenPixel(d: Uint8ClampedArray, j: number, lr: number, lg: number, lb: number, spill: boolean) {
  lr = lr > 1 ? 1 : lr;
  lg = lg > 1 ? 1 : lg;
  lb = lb > 1 ? 1 : lb;
  const a8 = d[j + 3];
  if (a8 === 255 || (!spill && a8 > 0)) {
    d[j] += (255 - d[j]) * lr;
    d[j + 1] += (255 - d[j + 1]) * lg;
    d[j + 2] += (255 - d[j + 2]) * lb;
    return;
  }
  if (!spill) return;
  const a = a8 / 255;
  const pr = (d[j] / 255) * a,
    pg = (d[j + 1] / 255) * a,
    pb = (d[j + 2] / 255) * a;
  const lm = lr > lg ? (lr > lb ? lr : lb) : lg > lb ? lg : lb;
  const na = a + lm * (1 - a);
  if (na <= 0.002) return;
  const k = 255 / na;
  d[j] = (pr + lr * (1 - pr)) * k;
  d[j + 1] = (pg + lg * (1 - pg)) * k;
  d[j + 2] = (pb + lb * (1 - pb)) * k;
  d[j + 3] = na * 255;
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
  params: [pctP('threshold', 'Threshold', 0), pxP('radius', 'Radius', 1, 150, 18), pctP('intensity', 'Intensity', 0.5), pctP('brightness', 'Brightness', 0.35)],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const k = clamp(num(p.intensity, 0.5), 0, 1);
    if (k <= 0) return img;
    const r = Math.max(1, num(p.radius, 18)) * sc(ctx);
    const br = 1 + clamp(num(p.brightness, 0.35), 0, 1) * 2;
    const thr = clamp(num(p.threshold, 0), 0, 1);
    const P = toPlanes(img, true);
    // threshold: the glow only blooms around tones above it (soft knee, spread by the radius)
    let gate: Float32Array | null = null;
    if (thr > 0.001) {
      const g0 = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = P.a[i];
        if (a <= 0) continue;
        g0[i] = smoothstep(thr - 0.08, thr + 0.08, (P.r[i] * 0.2126 + P.g[i] * 0.7152 + P.b[i] * 0.0722) / a);
      }
      gate = blurPlaneMultires(g0, w, h, r * 0.75, blurFn);
    }
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
      const kk = gate ? k * Math.min(1, gate[i] * 1.6) : k;
      if (kk <= 0.001) continue;
      for (let c = 0; c < 3; c++) {
        const orig = data[j + c] / 255;
        const s = bright[c][i] / af; // brightened straight
        const bl = Math.min(1, blurred[c][i] / bA); // blurred straight
        const orton = s * bl + (1 - s * bl) * bl * 0.25; // multiply + a touch of screen
        data[j + c] = (orig + (orton - orig) * kk) * 255;
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
    boolP('spill', 'Rays on transparent areas', true),
    seedP(3),
  ],
  apply(img, p, ctx) {
    const spill = bool(p.spill, true);
    if (!spill && isEmpty(img)) return img;
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
    const invDiag = 1 / diag;
    // beyond this distance (diag units) the falloff makes every beam invisible (L < 0.002)
    const maxDist = Math.max(len * 0.55 * Math.log(Math.max(1, (k * 1.2) / 0.002)), 0.035 * Math.log(Math.max(1, (k * 0.75) / 0.002)));
    for (let y = 0; y < h; y++) {
      const Y = ctx.offsetY + (y + 0.5) * inv;
      const dy = Y - cy;
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (!spill && data[j + 3] === 0) continue;
        const X = ctx.offsetX + (x + 0.5) * inv;
        const dx = X - cx;
        const dist = Math.sqrt(dx * dx + dy * dy) * invDiag;
        if (dist > maxDist) continue;
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
        screenPixel(data, j, L * col[0], L * col[1], L * col[2], spill);
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
    boolP('spill', 'Flare on transparent areas', true),
  ],
  apply(img, p, ctx) {
    const spill = bool(p.spill, true);
    if (!spill && isEmpty(img)) return img;
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
    // ghost reach in document px (squared), compared before any sqrt
    const gReach2 = ghosts.map((g) => (g.r * 1.3 * S) ** 2);
    const inv = 1 / s;
    const starRays = style === 'star' ? 8 : 6;
    const starPow = style === 'star' ? 120 : 260;
    const starFall = style === 'star' ? 0.22 : 0.12;
    const streak = style === 'anamorphic' || style === 'classic';
    const stY = 1 / (S * (style === 'anamorphic' ? 0.0025 : 0.0015)),
      stX = 1 / (S * (style === 'anamorphic' ? 0.5 : 0.18)),
      stK = style === 'anamorphic' ? 0.9 : 0.35;
    // distances (in S units) beyond which a term is below visibility (< 0.002 after brightness)
    const vis = 0.002 / Math.max(1e-3, B);
    const coreMax = 0.25 * Math.log(Math.max(1, 0.08 / vis)) + 0.05;
    const starMax = starFall * Math.log(Math.max(1, 0.75 / vis));
    const hr = 0.16;
    const invS = 1 / S;
    for (let y = 0; y < h; y++) {
      const Y = ctx.offsetY + (y + 0.5) * inv;
      const dy = Y - fy;
      const ady = Math.abs(dy);
      // the streak only exists within a few px of the flare's row
      const stRow = streak ? Math.exp(-ady * stY) * stK : 0;
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (!spill && data[j + 3] === 0) continue;
        const X = ctx.offsetX + (x + 0.5) * inv;
        const dx = X - fx;
        const d = Math.sqrt(dx * dx + dy * dy) * invS;
        let lr = 0,
          lg = 0,
          lb = 0;
        if (d < coreMax) {
          // hot core + wide glow
          const core = Math.exp(-(d * d) / 0.00018) * 1.4 + Math.exp(-d / 0.06) * 0.45 + Math.exp(-d / 0.25) * 0.08;
          lr += core;
          lg += core * 0.92;
          lb += core * 0.8;
        }
        if (d < starMax) {
          // star streaks
          const th = Math.atan2(dy, dx);
          const star = Math.pow(Math.abs(Math.cos((th * starRays) / 2)), starPow) * Math.exp(-d / starFall);
          lr += star * 0.7;
          lg += star * 0.7;
          lb += star * 0.75;
        }
        if (stRow > vis * 0.5) {
          // anamorphic horizontal streak
          const st = stRow * Math.exp(-Math.abs(dx) * stX);
          lr += st * 0.55;
          lg += st * 0.75;
          lb += st * 1.1;
        }
        const dr = d - hr;
        if (dr > -0.05 && dr < 0.05) {
          // halo ring with chromatic edge
          const ringR = Math.exp(-((d - hr * 1.02) ** 2) / 0.00009),
            ringG = Math.exp(-(dr * dr) / 0.00009),
            ringB = Math.exp(-((d - hr * 0.98) ** 2) / 0.00009);
          lr += ringR * 0.12;
          lg += ringG * 0.1;
          lb += ringB * 0.12;
        }
        // ghosts along the axis through the image center
        for (let g = 0; g < ghosts.length; g++) {
          const ex = X - gx[g],
            ey = Y - gy[g];
          const e2 = ex * ex + ey * ey;
          if (e2 > gReach2[g]) continue;
          const G = ghosts[g];
          const gd = Math.sqrt(e2) * invS;
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
        screenPixel(data, j, lr, lg, lb, spill);
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
