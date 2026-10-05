/** Light filters: vignette (adjustment), bloom, soft glow, light rays, god rays, lens flare, color glow. */
import { Flame, Lightbulb, Sparkle, Sun, Sunrise, SunDim, Aperture } from 'lucide-react';
import type { FilterDef } from '../../../registry';
import type { Img } from '../util';
import { anchor, blurPlane, bool, clamp, hash, isEmpty, multiresBlurGrid, multiresFactor, num, pt, rgb, sc, smoothstep, str, toPlanes, usesMultires } from '../util';
import { blurPlaneMultires, downsamplePlane, radialAccumulate, upsamplePlane } from '../ops';
import { hasTransparency } from '../edges';
import { boolP, colorP, numP, pctP, pointP, pxP, seedP, selectP } from '../params';
import { wasm, wasmAlloc, wasmHeap, wasmMark, wasmRelease } from '../../../core/wasm/runtime';

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
    vignetteBlend(img, ctx.offsetX, ctx.offsetY, s, shape, amount, col[0], col[1], col[2]);
    return img;
  },
};

/**
 * Blend the vignette color over a w×h image placed at (ox, oy) (doc px) with preview scale s —
 * same values as evaluating the shape per pixel, at a fraction of the cost and without any
 * full-size buffer or cache (so region updates and full renders cost the same per pixel):
 *  - columns: |u| (and u² / u^pw) once per distinct column (columns mirrored around the center share it);
 *  - rows: the strength of the distinct columns once per row, shared with the mirrored row
 *    (same |v|), as v² / v^pw plus a column term; the root (sqrt, or the superellipse power for
 *    negative roundness) only runs in the feather band, the inner / outer parts are decided in
 *    the squared space;
 *  - the blend is the plain float mix per channel.
 */
function vignetteBlend(img: Img, ox: number, oy: number, s: number, o: VignetteShape, amount: number, c0: number, c1: number, c2: number) {
  const { width: w, height: h } = img;
  if (w < 1 || h < 1) return;
  const P = vignettePrep(o);
  const inv = 1 / s;
  // distinct |u| values (float32, like the per-column table of the per-pixel evaluation)
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
  const UP = new Float64Array(nu);
  for (let k = 0; k < nu; k++) UP[k] = round ? Math.pow(uniq[k], pw) : uniq[k] * uniq[k];
  const e0 = P.e0,
    e1 = P.e1;
  // thresholds in the squared / powered space with a safety margin (decided exactly in between)
  const lo = e0 <= 0 ? -1 : (round ? Math.pow(e0, pw) : e0 * e0) * (1 - 1e-9);
  const hi = (round ? Math.pow(e1, pw) : e1 * e1) * (1 + 1e-9);
  const T = new Float64Array(nu);
  const d = img.data;
  const done = new Uint8Array(h);
  // image rows y and m − y have the same |v| when the center row is on a pixel center or edge
  const mirror = Math.round(2 * ((o.cy - oy) * s - 0.5));
  for (let y = 0; y < h; y++) {
    if (done[y]) continue;
    const v = Math.abs(oy + (y + 0.5) * inv - o.cy) * P.iry;
    const ym = mirror - y;
    const pair = ym > y && ym < h && Math.abs(oy + (ym + 0.5) * inv - o.cy) * P.iry === v;
    if (pair) done[ym] = 1;
    if (!vignetteRow(T, UP, nu, round ? Math.pow(v, pw) : v * v, round, pw, lo, hi, e0, e1, amount)) continue; // nothing to blend
    vignetteRowBlend(d, y * w, w, colIdx, T, c0, c1, c2);
    if (pair) vignetteRowBlend(d, ym * w, w, colIdx, T, c0, c1, c2);
  }
}

/**
 * Vignette strength × amount of each distinct column for one row (vp = v² or v^pw) into T.
 * Returns false when the whole row stays below the blend cut-off (t ≤ 0.0005).
 */
function vignetteRow(T: Float64Array, UP: Float64Array, nu: number, vp: number, round: boolean, pw: number, lo: number, hi: number, e0: number, e1: number, amount: number): boolean {
  const span = e1 - e0;
  const invPw = 1 / pw;
  let any = false;
  for (let k = 0; k < nu; k++) {
    const sum = UP[k] + vp;
    let t: number;
    if (sum <= lo) t = 0;
    else if (sum >= hi) t = amount;
    else {
      const d = round ? Math.pow(sum, invPw) : Math.sqrt(sum);
      if (d <= e0) t = 0;
      else if (d >= e1) t = amount;
      else {
        const f = (d - e0) / span;
        t = f * f * (3 - 2 * f) * amount;
      }
    }
    T[k] = t;
    if (t > 0.0005) any = true;
  }
  return any;
}

/**
 * Blend one row: v + (c − v)·t per channel, stored through the clamped bytes (rounded half to
 * even). Transparent pixels and t ≤ 0.0005 are skipped. (Byte stores beat word stores with
 * manual rounding here.)
 */
function vignetteRowBlend(d: Uint8ClampedArray, i0: number, w: number, colIdx: Int32Array, T: Float64Array, c0: number, c1: number, c2: number) {
  for (let x = 0, j = i0 * 4; x < w; x++, j += 4) {
    const t = T[colIdx[x]];
    if (t <= 0.0005 || d[j + 3] === 0) continue;
    d[j] += (c0 - d[j]) * t;
    d[j + 1] += (c1 - d[j + 1]) * t;
    d[j + 2] += (c2 - d[j + 2]) * t;
  }
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
    const r = Math.max(1, num(p.radius, 30)) * sc(ctx);
    const k = clamp(num(p.intensity, 1), 0, 3);
    if (k <= 0) return img;
    const threshold = clamp(num(p.threshold, 0.7), 0, 1);
    const sat = clamp(num(p.saturation, 1), 0, 2);
    const scales = [
      { s: r * 0.2, w: 0.45 },
      { s: r * 0.5, w: 0.35 },
      { s: r, w: 0.3 },
    ];
    bloomFused(img, threshold, scales, sat, k * 1.3, bool(p.spill, true));
    return img;
  },
};

/**
 * Bloom: brightPass → blurPlane per channel and scale → weighted sum → saturation → screenLight,
 * fused into two passes over the full-size image: (1) the bright pass is accumulated straight
 * into the downsampled grids of the three scales (dark pixels add nothing and are skipped);
 * scales blurPlane would blur at full resolution use a full-size "grid" (factor 1), (2) each
 * output pixel interpolates the blurred grids (factor 1 reproduces the plane exactly), sums the
 * scales and is screened at once. Every value is rounded to float32 where the step-by-step
 * version stores it, so the result is identical — without a dozen-plus full-size float planes
 * being written and read back.
 */
function bloomFused(img: Img, threshold: number, scales: { s: number; w: number }[], sat: number, k: number, spill: boolean) {
  if (bloomFusedWasm(img, threshold, scales, sat, k, spill)) return;
  const { width: w, height: h, data: d } = img;
  // three scales; per-scale numbers in typed arrays (monomorphic loops)
  const sig = Float64Array.from(scales, (sc0) => Math.max(0.5, sc0.s));
  const F = Int32Array.from(sig, (sg) => (usesMultires(sg, w, h) ? multiresFactor(sg) : 1));
  const W2 = Int32Array.from(F, (f) => Math.ceil(w / f)),
    H2 = Int32Array.from(F, (f) => Math.ceil(h / f));
  const g = (s: number) => new Float32Array(W2[s] * H2[s]);
  const r0 = g(0),
    g0 = g(0),
    b0 = g(0),
    r1 = g(1),
    g1 = g(1),
    b1 = g(1),
    r2 = g(2),
    g2 = g(2),
    b2 = g(2);
  // (1) bright pass → downsampled sums (rows of a cell top to bottom, pixels left to right: the
  // order of the cell-by-cell box downsample)
  bloomDownsample(d, w, h, threshold, F, W2, r0, g0, b0, r1, g1, b1, r2, g2, b2);
  const grids = [r0, g0, b0, r1, g1, b1, r2, g2, b2];
  for (let q = 0; q < 9; q++) {
    const s = (q / 3) | 0;
    if (F[s] === 1) {
      blurPlane(grids[q], w, h, sig[s]); // full resolution, like blurPlane on the bright plane
      continue;
    }
    normalizeCells(grids[q], W2[s], H2[s], F[s], w, h);
    multiresBlurGrid(grids[q], W2[s], H2[s], 1, sig[s], F[s]);
  }
  // (2) upsample (bilinear, cell centers at (i + 0.5)·f) + weighted sum + saturation + screen
  const up = [0, 1, 2].map((s) => new UpRows(grids[s * 3], grids[s * 3 + 1], grids[s * 3 + 2], W2[s], H2[s], F[s], w));
  const wts = Float64Array.from(scales, (sc0) => sc0.w);
  const desat = Math.abs(sat - 1) > 0.01;
  for (let y = 0; y < h; y++) {
    const a0 = up[0].row(y),
      a1 = up[1].row(y),
      a2 = up[2].row(y);
    if (!a0 && !a1 && !a2) continue; // no light reaches this row
    bloomRow(d, y * w * 4, w, up[0], up[1], up[2], wts[0], wts[1], wts[2], desat, sat, k, spill);
  }
}

/**
 * bloomFused with its full-size loops in WebAssembly (core/wasm: bloom_ds = bloomDownsample,
 * bloom_lerp = lerpRowPair, bloom_row = bloomRow + screenAt — the same float operations in the same
 * order) and the image, grids and row tables in WebAssembly memory; the grid blurs are the same
 * blurPlane / normalizeCells / multiresBlurGrid calls on views of that memory, and the row
 * bookkeeping mirrors UpRows.row. Identical bytes. False (nothing touched) when WebAssembly or its
 * memory isn't available.
 */
function bloomFusedWasm(img: Img, threshold: number, scales: { s: number; w: number }[], sat: number, k: number, spill: boolean): boolean {
  const X = wasm();
  const { width: w, height: h, data: d } = img;
  const n = w * h * 4;
  if (!X || w < 1 || h < 1 || d.length !== n || scales.length !== 3) return false;
  const sig = Float64Array.from(scales, (sc0) => Math.max(0.5, sc0.s));
  const F = Int32Array.from(sig, (sg) => (usesMultires(sg, w, h) ? multiresFactor(sg) : 1));
  const W2 = Int32Array.from(F, (f) => Math.ceil(w / f)),
    H2 = Int32Array.from(F, (f) => Math.ceil(h / f));
  const al16 = (b: number) => (b + 15) & ~15;
  const plane = [0, 1, 2].map((s) => al16(W2[s] * H2[s] * 4));
  // one block: bytes, 9 grid planes (per scale R, G, B), per scale: cell-column table, upsampling
  // tables (left / right cell byte offsets, x-fractions) and the T/D rows (6 × w float64)
  const colBytes = al16(w * 4),
    tdBytes = 6 * al16(w * 8);
  const total = al16(n) + 3 * (plane[0] + plane[1] + plane[2]) + 3 * (4 * colBytes + tdBytes) + 256 * 8;
  const mark = wasmMark();
  try {
    const base = wasmAlloc(total);
    if (!base) return false;
    let at = base;
    const take = (b: number) => {
      const p = at;
      at += al16(b);
      return p;
    };
    const bytes = take(n);
    const grid = [0, 1, 2].map((s) => take(plane[s] * 3)); // R plane, G at + plane[s], B at + 2·plane[s]
    const cx = [0, 1, 2].map(() => take(colBytes)),
      xi = [0, 1, 2].map(() => take(colBytes)),
      xi1 = [0, 1, 2].map(() => take(colBytes)),
      xt = [0, 1, 2].map(() => take(colBytes)),
      td = [0, 1, 2].map(() => take(tdBytes)),
      inv = take(256 * 8);
    let H = wasmHeap();
    H.u8.set(d, bytes);
    // v / 255 for every byte: the kernels look the quotients up instead of dividing per pixel
    for (let v = 0; v < 256; v++) H.f64[(inv >>> 3) + v] = v / 255;
    H.u8.fill(0, grid[0], grid[2] + plane[2] * 3);
    for (let s = 0; s < 3; s++) {
      const c0 = cx[s] >>> 2,
        f = F[s];
      for (let x = 0; x < w; x++) H.i32[c0 + x] = ((x / f) | 0) * 4;
    }
    // (1) bright pass → downsampled sums
    const knee = 0.12;
    X.bloom_ds(bytes, w, h, threshold - knee, threshold + knee, cx[0], cx[1], cx[2], F[0], F[1], F[2], W2[0] * 4, W2[1] * 4, W2[2] * 4, grid[0], grid[1], grid[2], plane[0], plane[1], plane[2], inv);
    // the grid blurs (may grow the memory: views are taken right before each call)
    for (let q = 0; q < 9; q++) {
      const s = (q / 3) | 0;
      const ptr = grid[s] + (q % 3) * plane[s];
      const view = () => wasmHeap().f32.subarray(ptr >>> 2, (ptr >>> 2) + W2[s] * H2[s]);
      if (F[s] === 1) {
        blurPlane(view(), w, h, sig[s]);
        continue;
      }
      normalizeCells(view(), W2[s], H2[s], F[s], w, h);
      multiresBlurGrid(view(), W2[s], H2[s], 1, sig[s], F[s]);
    }
    // (2) no allocation from here on: the views stay valid
    H = wasmHeap();
    const G = [0, 1, 2].map((s) => [0, 1, 2].map((c) => H.f32.subarray((grid[s] + c * plane[s]) >>> 2, ((grid[s] + c * plane[s]) >>> 2) + W2[s] * H2[s])));
    for (let s = 0; s < 3; s++) {
      if (F[s] === 1) continue;
      const invF = 1 / F[s],
        w2 = W2[s];
      const a0 = xi[s] >>> 2,
        a1 = xi1[s] >>> 2,
        at2 = xt[s] >>> 2;
      for (let x = 0; x < w; x++) {
        let fx = (x + 0.5) * invF - 0.5;
        if (fx < 0) fx = 0;
        else if (fx > w2 - 1) fx = w2 - 1;
        const i0 = fx | 0;
        H.i32[a0 + x] = i0 * 4;
        H.i32[a1 + x] = (i0 < w2 - 1 ? i0 + 1 : i0) * 4;
        H.f32[at2 + x] = fx - i0;
      }
    }
    const j0 = [-1, -1, -1],
      nz = [false, false, false],
      ty = [0, 0, 0],
      rowP = [0, 0, 0];
    const wts = Float64Array.from(scales, (sc0) => sc0.w);
    const desat = Math.abs(sat - 1) > 0.01 ? 1 : 0;
    const wb = w * 8; // T/D row stride inside a scale's block (bloom_row uses the same)
    for (let y = 0; y < h; y++) {
      // UpRows.row(y) of each scale
      for (let s = 0; s < 3; s++) {
        const w2 = W2[s],
          h2 = H2[s];
        if (F[s] === 1) {
          const o = y * w2;
          rowP[s] = o * 4;
          const [gr, gg, gb] = G[s];
          let any = false;
          for (let x = 0; x < w2; x++)
            if (gr[o + x] !== 0 || gg[o + x] !== 0 || gb[o + x] !== 0) {
              any = true;
              break;
            }
          nz[s] = any;
          continue;
        }
        let fy = (y + 0.5) / F[s] - 0.5;
        if (fy < 0) fy = 0;
        else if (fy > h2 - 1) fy = h2 - 1;
        const r0 = fy | 0;
        ty[s] = fy - r0;
        if (r0 !== j0[s]) {
          j0[s] = r0;
          const ra = r0 * w2,
            rb = (r0 < h2 - 1 ? r0 + 1 : r0) * w2;
          nz[s] = anyNonZero(G[s][0], ra, rb, w2) || anyNonZero(G[s][1], ra, rb, w2) || anyNonZero(G[s][2], ra, rb, w2);
          for (let c = 0; c < 3; c++) {
            const pc = grid[s] + c * plane[s];
            X.bloom_lerp(pc + ra * 4, pc + rb * 4, xi[s], xi1[s], xt[s], td[s] + 2 * c * wb, td[s] + (2 * c + 1) * wb, w);
          }
        }
      }
      if (!nz[0] && !nz[1] && !nz[2]) continue; // no light reaches this row
      const P = (s: number, c: number) => grid[s] + c * plane[s] + rowP[s];
      X.bloom_row(
        bytes + y * w * 4, w, wts[0], wts[1], wts[2], desat, sat, k, spill ? 1 : 0, inv,
        F[0] === 1 ? 1 : 0, ty[0], td[0], P(0, 0), P(0, 1), P(0, 2),
        F[1] === 1 ? 1 : 0, ty[1], td[1], P(1, 0), P(1, 1), P(1, 2),
        F[2] === 1 ? 1 : 0, ty[2], td[2], P(2, 0), P(2, 1), P(2, 2),
      );
    }
    d.set(H.u8.subarray(bytes, bytes + n));
    return true;
  } finally {
    wasmRelease(mark);
  }
}

/** Bright pass of every pixel, summed into the cells of the three scales' grids. */
function bloomDownsample(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number,
  F: Int32Array,
  W2: Int32Array,
  r0: Float32Array,
  g0: Float32Array,
  b0: Float32Array,
  r1: Float32Array,
  g1: Float32Array,
  b1: Float32Array,
  r2: Float32Array,
  g2: Float32Array,
  b2: Float32Array,
) {
  const knee = 0.12;
  const lo = threshold - knee,
    hi = threshold + knee;
  const f0 = F[0],
    f1 = F[1],
    f2 = F[2];
  for (let y = 0; y < h; y++) {
    const o0 = ((y / f0) | 0) * W2[0],
      o1 = ((y / f1) | 0) * W2[1],
      o2 = ((y / f2) | 0) * W2[2];
    for (let x = 0, j = y * w * 4; x < w; x++, j += 4) {
      const a = d[j + 3] / 255;
      if (a === 0) continue;
      const R = d[j] / 255,
        G = d[j + 1] / 255,
        B = d[j + 2] / 255;
      const l = R * 0.2126 + G * 0.7152 + B * 0.0722;
      const kk = smoothstep(lo, hi, l) * a;
      if (kk <= 0) continue; // adds nothing to any cell
      const vr = Math.fround(R * kk),
        vg = Math.fround(G * kk),
        vb = Math.fround(B * kk);
      let o = o0 + ((x / f0) | 0);
      r0[o] += vr;
      g0[o] += vg;
      b0[o] += vb;
      o = o1 + ((x / f1) | 0);
      r1[o] += vr;
      g1[o] += vg;
      b1[o] += vb;
      o = o2 + ((x / f2) | 0);
      r2[o] += vr;
      g2[o] += vg;
      b2[o] += vb;
    }
  }
}

/** Divide each cell sum of a downsampled grid by its pixel count (edge cells have fewer). */
function normalizeCells(g: Float32Array, w2: number, h2: number, f: number, w: number, h: number) {
  for (let y2 = 0; y2 < h2; y2++) {
    const kh = Math.min(h, y2 * f + f) - y2 * f;
    const o = y2 * w2;
    for (let x2 = 0, x0 = 0; x2 < w2; x2++, x0 += f) g[o + x2] *= 1 / (((x0 + f < w ? x0 + f : w) - x0) * kh);
  }
}

/**
 * Bilinear upsampling of three blurred grids (r, g, b) one output row at a time. Per column: the
 * left cell and the float32 x-fraction. Whenever the pair of grid rows changes (every f output
 * rows), the horizontal halves of every column's taps are computed once: T = a + (a1 − a)·tx on
 * the top row and D = (b + (b1 − b)·tx) − T — then each output pixel is one T + D·ty per channel
 * (the same doubles as the full per-pixel tap).
 */
class UpRows {
  readonly xi: Int32Array;
  readonly xt: Float32Array;
  readonly tr: Float64Array;
  readonly dr: Float64Array;
  readonly tg: Float64Array;
  readonly dg: Float64Array;
  readonly tb: Float64Array;
  readonly db: Float64Array;
  ty = 0;
  /** Factor 1: the grids are the full-size planes, read directly at `off + x` (no interpolation). */
  readonly direct: boolean;
  off = 0;
  private j0 = -1;
  private nz = false;
  constructor(
    readonly gr: Float32Array,
    readonly gg: Float32Array,
    readonly gb: Float32Array,
    private readonly w2: number,
    private readonly h2: number,
    private readonly f: number,
    private readonly w: number,
  ) {
    this.direct = f === 1;
    this.xi = new Int32Array(w);
    this.xt = new Float32Array(w);
    const invF = 1 / f;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) * invF - 0.5;
      if (fx < 0) fx = 0;
      else if (fx > w2 - 1) fx = w2 - 1;
      const i0 = fx | 0;
      this.xi[x] = i0;
      this.xt[x] = fx - i0;
    }
    const nc = this.direct ? 0 : w;
    this.tr = new Float64Array(nc);
    this.dr = new Float64Array(nc);
    this.tg = new Float64Array(nc);
    this.dg = new Float64Array(nc);
    this.tb = new Float64Array(nc);
    this.db = new Float64Array(nc);
  }
  /** Prepare output row y; false when both grid rows are all zero (no light). */
  row(y: number): boolean {
    if (this.direct) {
      // interpolating at factor 1 lands exactly on the samples: a + (a1 − a)·0 = a
      const o = y * this.w2;
      this.off = o;
      const { gr, gg, gb } = this;
      for (let x = 0, e = this.w2; x < e; x++) if (gr[o + x] !== 0 || gg[o + x] !== 0 || gb[o + x] !== 0) return true;
      return false;
    }
    const h2 = this.h2;
    let fy = (y + 0.5) / this.f - 0.5;
    if (fy < 0) fy = 0;
    else if (fy > h2 - 1) fy = h2 - 1;
    const j0 = fy | 0;
    this.ty = fy - j0;
    if (j0 !== this.j0) {
      this.j0 = j0;
      const w2 = this.w2;
      const r0 = j0 * w2,
        r1 = (j0 < h2 - 1 ? j0 + 1 : j0) * w2;
      this.nz = anyNonZero(this.gr, r0, r1, w2) || anyNonZero(this.gg, r0, r1, w2) || anyNonZero(this.gb, r0, r1, w2);
      // (also when all zero: another scale may still light this row and read these)
      lerpRowPair(this.gr, r0, r1, w2, this.xi, this.xt, this.tr, this.dr, this.w);
      lerpRowPair(this.gg, r0, r1, w2, this.xi, this.xt, this.tg, this.dg, this.w);
      lerpRowPair(this.gb, r0, r1, w2, this.xi, this.xt, this.tb, this.db, this.w);
    }
    return this.nz;
  }
}

/** Whether any cell of grid rows r0 / r1 is non-zero. */
function anyNonZero(g: Float32Array, r0: number, r1: number, w2: number): boolean {
  for (let i = 0; i < w2; i++) if (g[r0 + i] !== 0 || g[r1 + i] !== 0) return true;
  return false;
}

/** Horizontal halves of the bilinear taps of every output column between grid rows r0 and r1. */
function lerpRowPair(g: Float32Array, r0: number, r1: number, w2: number, xi: Int32Array, xt: Float32Array, T: Float64Array, D: Float64Array, w: number) {
  for (let x = 0; x < w; x++) {
    const i = xi[x];
    const i1 = i < w2 - 1 ? i + 1 : i;
    const tx = xt[x];
    const a0 = g[r0 + i],
      b0 = g[r1 + i];
    const top = a0 + (g[r0 + i1] - a0) * tx;
    T[x] = top;
    D[x] = b0 + (g[r1 + i1] - b0) * tx - top;
  }
}

/** One output row of bloom: sum the three upsampled scales, saturation, screen. */
function bloomRow(
  d: Uint8ClampedArray,
  j0: number,
  w: number,
  u0: UpRows,
  u1: UpRows,
  u2: UpRows,
  w0: number,
  w1: number,
  w2: number,
  desat: boolean,
  sat: number,
  k: number,
  spill: boolean,
) {
  const TR0 = u0.tr,
    DR0 = u0.dr,
    TG0 = u0.tg,
    DG0 = u0.dg,
    TB0 = u0.tb,
    DB0 = u0.db,
    ty0 = u0.ty;
  const TR1 = u1.tr,
    DR1 = u1.dr,
    TG1 = u1.tg,
    DG1 = u1.dg,
    TB1 = u1.tb,
    DB1 = u1.db,
    ty1 = u1.ty;
  const TR2 = u2.tr,
    DR2 = u2.dr,
    TG2 = u2.tg,
    DG2 = u2.dg,
    TB2 = u2.tb,
    DB2 = u2.db,
    ty2 = u2.ty;
  const D0 = u0.direct,
    D1 = u1.direct,
    D2 = u2.direct,
    o0 = u0.off,
    o1 = u1.off,
    o2 = u2.off;
  const P0r = u0.gr,
    P0g = u0.gg,
    P0b = u0.gb,
    P1r = u1.gr,
    P1g = u1.gg,
    P1b = u1.gb,
    P2r = u2.gr,
    P2g = u2.gg,
    P2b = u2.gb;
  for (let x = 0, j = j0; x < w; x++, j += 4) {
    // each upsampled value is rounded to float32 (as stored by blurPlane) and summed in float32
    let gr: number, gg: number, gb: number;
    if (D0) {
      gr = Math.fround(P0r[o0 + x] * w0);
      gg = Math.fround(P0g[o0 + x] * w0);
      gb = Math.fround(P0b[o0 + x] * w0);
    } else {
      gr = Math.fround(Math.fround(TR0[x] + DR0[x] * ty0) * w0);
      gg = Math.fround(Math.fround(TG0[x] + DG0[x] * ty0) * w0);
      gb = Math.fround(Math.fround(TB0[x] + DB0[x] * ty0) * w0);
    }
    if (D1) {
      gr = Math.fround(gr + P1r[o1 + x] * w1);
      gg = Math.fround(gg + P1g[o1 + x] * w1);
      gb = Math.fround(gb + P1b[o1 + x] * w1);
    } else {
      gr = Math.fround(gr + Math.fround(TR1[x] + DR1[x] * ty1) * w1);
      gg = Math.fround(gg + Math.fround(TG1[x] + DG1[x] * ty1) * w1);
      gb = Math.fround(gb + Math.fround(TB1[x] + DB1[x] * ty1) * w1);
    }
    if (D2) {
      gr = Math.fround(gr + P2r[o2 + x] * w2);
      gg = Math.fround(gg + P2g[o2 + x] * w2);
      gb = Math.fround(gb + P2b[o2 + x] * w2);
    } else {
      gr = Math.fround(gr + Math.fround(TR2[x] + DR2[x] * ty2) * w2);
      gg = Math.fround(gg + Math.fround(TG2[x] + DG2[x] * ty2) * w2);
      gb = Math.fround(gb + Math.fround(TB2[x] + DB2[x] * ty2) * w2);
    }
    if (desat) {
      const l = gr * 0.2126 + gg * 0.7152 + gb * 0.0722;
      gr = Math.fround(Math.max(0, l + (gr - l) * sat));
      gg = Math.fround(Math.max(0, l + (gg - l) * sat));
      gb = Math.fround(Math.max(0, l + (gb - l) * sat));
    }
    screenAt(d, j, gr * k, gg * k, gb * k, spill);
  }
}

/** screenLight() for one pixel (light already multiplied by the intensity). */
function screenAt(d: Uint8ClampedArray, j: number, lr: number, lg: number, lb: number, spill: boolean) {
  if (lr < 0.001 && lg < 0.001 && lb < 0.001) return;
  lr = lr > 1 ? 1 : lr;
  lg = lg > 1 ? 1 : lg;
  lb = lb > 1 ? 1 : lb;
  const a = d[j + 3] / 255;
  if (a >= 0.999 || !spill) {
    if (a === 0) return;
    d[j] += (255 - d[j]) * lr;
    d[j + 1] += (255 - d[j + 1]) * lg;
    d[j + 2] += (255 - d[j + 2]) * lb;
    return;
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
  if (na <= 0.002) return;
  d[j] = (nr / na) * 255;
  d[j + 1] = (ng / na) * 255;
  d[j + 2] = (nb / na) * 255;
  d[j + 3] = na * 255;
}

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
