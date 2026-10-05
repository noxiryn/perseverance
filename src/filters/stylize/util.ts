/**
 * Shared pixel helpers for the creative filter library (pure, DOM-free so they run in unit tests).
 *
 * Conventions used by every filter in this module:
 *  - Filters write their result back into `img.data` and return `img` (no `new ImageData`, so the
 *    code also runs on plain `{ data, width, height }` objects in jsdom tests).
 *  - Size params are in document pixels and are multiplied by `ctx.scale`.
 *  - Document-anchored patterns use `docX = ctx.offsetX + x / ctx.scale` (see `anchor`).
 *  - Float planes hold 0..1 values unless noted.
 */
import type { FilterContext } from '../../registry';
import { parseColor } from '../../core/color';

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type Edge = 'transparent' | 'clamp' | 'wrap';

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function num(v: unknown, d = 0): number {
  return typeof v === 'number' && isFinite(v) ? v : d;
}
export function bool(v: unknown, d = false): boolean {
  return typeof v === 'boolean' ? v : d;
}
export function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}
export function pt(v: unknown, d = { x: 0.5, y: 0.5 }): { x: number; y: number } {
  if (v && typeof v === 'object' && 'x' in v && 'y' in v) {
    const p = v as { x: unknown; y: unknown };
    return { x: num(p.x, d.x), y: num(p.y, d.y) };
  }
  return d;
}

/** Color param → [r, g, b] 0..255 */
export function rgb(color: unknown, fallback = '#000000'): [number, number, number] {
  const c = parseColor(typeof color === 'string' ? color : fallback);
  return [c.r, c.g, c.b];
}

/** True on little-endian hosts (every platform Electron ships on): RGBA bytes = r | g<<8 | b<<16 | a<<24. */
export const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * The pixels as little-endian 32-bit words (one load/store per pixel instead of four), or null
 * when that view isn't possible (big-endian host, unaligned buffer) — callers then fall back to
 * byte access. Int32 (not Uint32) keeps values in integer registers; test alpha with `p >>> 24`.
 */
export function pixelWords(img: Img): Int32Array | null {
  const d = img.data;
  if (!LITTLE_ENDIAN || d.byteOffset & 3 || d.length & 3) return null;
  return new Int32Array(d.buffer, d.byteOffset, d.length >> 2);
}

const scratchPool = new Map<string, WeakRef<Float32Array>>();

/**
 * A Float32Array of `n` elements reused across calls under `key` (contents are left over from the
 * previous use — overwrite before reading). Fresh multi-megabyte arrays cost a lot to zero and
 * fault in; the pool only holds them weakly, so idle memory can still be reclaimed. Only for
 * temporaries that don't outlive the call; one live user per key at a time.
 */
export function scratchF32(key: string, n: number): Float32Array {
  const a = scratchPool.get(key)?.deref();
  if (a && a.length >= n) return a.length === n ? a : a.subarray(0, n);
  const b = new Float32Array(n);
  scratchPool.set(key, new WeakRef(b));
  return b;
}

/** Effective scale (never 0). */
export function sc(ctx: FilterContext): number {
  return ctx.scale > 0 ? ctx.scale : 1;
}

/**
 * Document anchoring: offset (in image px) to add to image coordinates so that patterns stay
 * fixed to the document, i.e. `gx = x + ax` is "document px × scale".
 */
export function anchor(ctx: FilterContext): { ax: number; ay: number; s: number } {
  const s = sc(ctx);
  return { ax: ctx.offsetX * s, ay: ctx.offsetY * s, s };
}

/** Rec.709 luma of 0..255 channels → 0..1 */
export const LR = 0.2126 / 255,
  LG = 0.7152 / 255,
  LB = 0.0722 / 255;

export function lumaPlane(img: Img): Float32Array {
  const { data } = img;
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = data[j] * LR + data[j + 1] * LG + data[j + 2] * LB;
  return out;
}

export function alphaPlane(img: Img): Float32Array {
  const { data } = img;
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0, j = 3; i < n; i++, j += 4) out[i] = data[j] / 255;
  return out;
}

/** True when every pixel is fully opaque (alpha 255). */
export function isOpaque(d: Uint8ClampedArray): boolean {
  for (let j = 3; j < d.length; j += 4) if (d[j] !== 255) return false;
  return true;
}

/** True when every pixel is fully transparent (filters can bail out early). */
export function isEmpty(img: Img): boolean {
  const d = img.data;
  for (let j = 3; j < d.length; j += 4) if (d[j] !== 0) return false;
  return true;
}

/** Premultiplied float planes (0..1). */
export interface Planes {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
}

export function toPlanes(img: Img, premultiply = true): Planes {
  const n = img.width * img.height;
  const d = img.data;
  const r = new Float32Array(n),
    g = new Float32Array(n),
    b = new Float32Array(n),
    a = new Float32Array(n);
  const k = 1 / 255;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const al = d[j + 3] * k;
    const m = premultiply ? al * k : k;
    r[i] = d[j] * m;
    g[i] = d[j + 1] * m;
    b[i] = d[j + 2] * m;
    a[i] = al;
  }
  return { r, g, b, a };
}

/** Write premultiplied planes back into img (unpremultiplied). */
export function fromPlanes(img: Img, p: Planes, premultiplied = true) {
  const n = img.width * img.height;
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = p.a[i];
    if (a <= 1e-5) {
      d[j] = d[j + 1] = d[j + 2] = d[j + 3] = 0;
      continue;
    }
    const m = premultiplied ? 255 / a : 255;
    d[j] = p.r[i] * m;
    d[j + 1] = p.g[i] * m;
    d[j + 2] = p.b[i] * m;
    d[j + 3] = a * 255;
  }
}

/* ------------------------------------------------------------------ */
/* Blur                                                                */
/* ------------------------------------------------------------------ */

function gaussKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * Horizontal small-kernel convolution of one row of a float plane (clamp-to-edge): `src` row at
 * `row` → `dst`. Interior pixels run a branch-free loop; only the r pixels at each end clamp.
 */
function convolveRow(src: Float32Array, dst: Float32Array, row: number, w: number, k: Float32Array, r: number) {
  const K = k.length;
  const last = row + w - 1;
  const xa = Math.min(r, w),
    xb = Math.max(xa, w - r);
  for (let x = 0; x < xa; x++) {
    let s = 0;
    for (let i = 0; i < K; i++) {
      const q = row + x - r + i;
      s += src[q < row ? row : q > last ? last : q] * k[i];
    }
    dst[row + x] = s;
  }
  // interior: unrolled for the common kernel sizes (same sums in the same order: s = 0 + t0 + t1 …)
  if (K === 3) hTaps3(src, dst, row, xa, xb, k);
  else if (K === 5) hTaps5(src, dst, row, xa, xb, k);
  else if (K === 7) hTaps7(src, dst, row, xa, xb, k);
  else
    for (let x = xa; x < xb; x++) {
      let s = 0;
      const p = row + x - r;
      for (let i = 0; i < K; i++) s += src[p + i] * k[i];
      dst[row + x] = s;
    }
  for (let x = xb; x < w; x++) {
    let s = 0;
    for (let i = 0; i < K; i++) {
      const q = row + x - r + i;
      s += src[q < row ? row : q > last ? last : q] * k[i];
    }
    dst[row + x] = s;
  }
}

function hTaps3(src: Float32Array, dst: Float32Array, row: number, xa: number, xb: number, k: Float32Array) {
  const k0 = k[0],
    k1 = k[1],
    k2 = k[2];
  for (let x = xa, p = row + xa - 1; x < xb; x++, p++) dst[row + x] = 0 + src[p] * k0 + src[p + 1] * k1 + src[p + 2] * k2;
}

function hTaps5(src: Float32Array, dst: Float32Array, row: number, xa: number, xb: number, k: Float32Array) {
  const k0 = k[0],
    k1 = k[1],
    k2 = k[2],
    k3 = k[3],
    k4 = k[4];
  for (let x = xa, p = row + xa - 2; x < xb; x++, p++) dst[row + x] = 0 + src[p] * k0 + src[p + 1] * k1 + src[p + 2] * k2 + src[p + 3] * k3 + src[p + 4] * k4;
}

function hTaps7(src: Float32Array, dst: Float32Array, row: number, xa: number, xb: number, k: Float32Array) {
  const k0 = k[0],
    k1 = k[1],
    k2 = k[2],
    k3 = k[3],
    k4 = k[4],
    k5 = k[5],
    k6 = k[6];
  for (let x = xa, p = row + xa - 3; x < xb; x++, p++)
    dst[row + x] = 0 + src[p] * k0 + src[p + 1] * k1 + src[p + 2] * k2 + src[p + 3] * k3 + src[p + 4] * k4 + src[p + 5] * k5 + src[p + 6] * k6;
}

/** Exact separable gaussian on a float plane in place (small sigmas). Clamp-to-edge. */
function gaussSmallPlane(buf: Float32Array, w: number, h: number, sigma: number) {
  const k = gaussKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) convolveRow(buf, tmp, y * w, w, k, r);
  // vertical: the taps of a column are accumulated in float32 (one rounding per tap, as a
  // Float32Array accumulator row would), kept in a register instead of read back from memory
  const rows = new Int32Array(2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let i = -r; i <= r; i++) rows[i + r] = (y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i) * w;
    if (r === 1) vTaps3(tmp, buf, y * w, w, rows, k);
    else if (r === 2) vTaps5(tmp, buf, y * w, w, rows, k);
    else if (r === 3) vTaps7(tmp, buf, y * w, w, rows, k);
    else {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = 0; i <= 2 * r; i++) s = Math.fround(s + tmp[rows[i] + x] * k[i]);
        buf[y * w + x] = s;
      }
    }
  }
}

function vTaps3(t: Float32Array, out: Float32Array, o: number, w: number, rows: Int32Array, k: Float32Array) {
  const a = rows[0],
    b = rows[1],
    c = rows[2];
  const k0 = k[0],
    k1 = k[1],
    k2 = k[2];
  for (let x = 0; x < w; x++) {
    let s = Math.fround(0 + t[a + x] * k0);
    s = Math.fround(s + t[b + x] * k1);
    out[o + x] = s + t[c + x] * k2;
  }
}

function vTaps5(t: Float32Array, out: Float32Array, o: number, w: number, rows: Int32Array, k: Float32Array) {
  const a = rows[0],
    b = rows[1],
    c = rows[2],
    d = rows[3],
    e = rows[4];
  const k0 = k[0],
    k1 = k[1],
    k2 = k[2],
    k3 = k[3],
    k4 = k[4];
  for (let x = 0; x < w; x++) {
    let s = Math.fround(0 + t[a + x] * k0);
    s = Math.fround(s + t[b + x] * k1);
    s = Math.fround(s + t[c + x] * k2);
    s = Math.fround(s + t[d + x] * k3);
    out[o + x] = s + t[e + x] * k4;
  }
}

function vTaps7(t: Float32Array, out: Float32Array, o: number, w: number, rows: Int32Array, k: Float32Array) {
  const a = rows[0],
    b = rows[1],
    c = rows[2],
    d = rows[3],
    e = rows[4],
    f = rows[5],
    g = rows[6];
  const k0 = k[0],
    k1 = k[1],
    k2 = k[2],
    k3 = k[3],
    k4 = k[4],
    k5 = k[5],
    k6 = k[6];
  for (let x = 0; x < w; x++) {
    let s = Math.fround(0 + t[a + x] * k0);
    s = Math.fround(s + t[b + x] * k1);
    s = Math.fround(s + t[c + x] * k2);
    s = Math.fround(s + t[d + x] * k3);
    s = Math.fround(s + t[e + x] * k4);
    s = Math.fround(s + t[f + x] * k5);
    out[o + x] = s + t[g + x] * k6;
  }
}

/**
 * Box radius r and fractional end-tap weight α such that `passes` extended boxes (weights 1 for
 * |k| ≤ r, α for |k| = r + 1) have exactly the variance of a gaussian of `sigma` — so the blur
 * changes smoothly with the radius instead of in whole-pixel steps.
 */
export function boxForSigma(sigma: number, passes = 3): { r: number; alpha: number } {
  const v = (sigma * sigma) / passes;
  const r = Math.max(0, Math.floor((-1 + Math.sqrt(1 + 12 * v)) / 2));
  const den = 2 * ((r + 1) * (r + 1) - v);
  let alpha = den > 1e-9 ? ((2 * r + 1) * (v - (r * (r + 1)) / 3)) / den : 0;
  alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return { r, alpha };
}

/** Blur sigma from which blurs run at reduced resolution (the result is smooth at that scale). */
const MULTIRES_SIGMA = 6;

/**
 * Large-sigma blur of interleaved data in place at 1/f resolution (box downsample → extended box
 * blur → bilinear upsample), f ≈ σ/3. At that factor the gaussian has no energy left near the
 * low-resolution Nyquist frequency (no aliasing) and the result stays within ~1-2% (a few levels)
 * of the full-resolution blur at the sharpest blurred edge. The variance added by the resampling
 * (≈ f²/4) is taken off the low-resolution blur, so the overall sigma stays right; ~f² less work.
 */
function blurMultires(buf: Float32Array, w: number, h: number, ch: number, sigma: number) {
  const m = multiresGrid(buf, w, h, ch, sigma);
  const { small, w2, h2, f } = m;
  // bilinear upsample (cell centers at (i + 0.5)·f)
  const invF = 1 / f;
  const xi0 = new Int32Array(w),
    xi1 = new Int32Array(w),
    xt = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let fx = (x + 0.5) * invF - 0.5;
    if (fx < 0) fx = 0;
    else if (fx > w2 - 1) fx = w2 - 1;
    const i0 = fx | 0;
    xi0[x] = i0 * ch;
    xi1[x] = (i0 < w2 - 1 ? i0 + 1 : i0) * ch;
    xt[x] = fx - i0;
  }
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * invF - 0.5;
    if (fy < 0) fy = 0;
    else if (fy > h2 - 1) fy = h2 - 1;
    const j0 = fy | 0;
    const ty = fy - j0;
    const r0 = j0 * w2 * ch,
      r1 = (j0 < h2 - 1 ? j0 + 1 : j0) * w2 * ch;
    let o = y * w * ch;
    for (let x = 0; x < w; x++) {
      const a0 = r0 + xi0[x],
        a1 = r0 + xi1[x],
        b0 = r1 + xi0[x],
        b1 = r1 + xi1[x];
      const tx = xt[x];
      for (let c = 0; c < ch; c++, o++) {
        const top = small[a0 + c] + (small[a1 + c] - small[a0 + c]) * tx;
        const bot = small[b0 + c] + (small[b1 + c] - small[b0 + c]) * tx;
        buf[o] = top + (bot - top) * ty;
      }
    }
  }
}

/** Whether blurPlane / blurImage take the reduced-resolution path for this sigma and size. */
export function usesMultires(sigma: number, w: number, h: number): boolean {
  return sigma >= MULTIRES_SIGMA && w >= 16 && h >= 16;
}

/**
 * The reduced-resolution half of blurMultires: box downsample by f ≈ σ/3, then the remaining blur
 * on the small grid. Upsampling it bilinearly (cell centers at (i + 0.5)·f) gives blurPlane's
 * result for big sigmas.
 */
export function multiresGrid(buf: Float32Array, w: number, h: number, ch: number, sigma: number): { small: Float32Array; w2: number; h2: number; f: number } {
  const f = multiresFactor(sigma);
  const w2 = Math.ceil(w / f),
    h2 = Math.ceil(h / f);
  const small = new Float32Array(w2 * h2 * ch);
  // box downsample (edge cells average the pixels they have)
  if (ch === 1) {
    // row by row into the current cell row (float32 sums in the same order: rows of the cell top
    // to bottom, pixels left to right → identical to summing cell by cell)
    for (let y2 = 0; y2 < h2; y2++) {
      const y0 = y2 * f,
        y1 = Math.min(h, y0 + f);
      const o = y2 * w2;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x2 = 0, x0 = 0; x2 < w2; x2++, x0 += f) {
          const x1 = x0 + f < w ? x0 + f : w;
          let a = small[o + x2];
          for (let x = x0; x < x1; x++) a = Math.fround(a + buf[row + x]);
          small[o + x2] = a;
        }
      }
      const kh = y1 - y0;
      for (let x2 = 0, x0 = 0; x2 < w2; x2++, x0 += f) small[o + x2] *= 1 / (((x0 + f < w ? x0 + f : w) - x0) * kh);
    }
  } else {
    for (let y2 = 0; y2 < h2; y2++) {
      const y0 = y2 * f,
        y1 = Math.min(h, y0 + f);
      for (let x2 = 0; x2 < w2; x2++) {
        const x0 = x2 * f,
          x1 = Math.min(w, x0 + f);
        const o = (y2 * w2 + x2) * ch;
        for (let y = y0; y < y1; y++) {
          let q = (y * w + x0) * ch;
          for (let x = x0; x < x1; x++) for (let c = 0; c < ch; c++, q++) small[o + c] += buf[q];
        }
        const k = 1 / ((x1 - x0) * (y1 - y0));
        for (let c = 0; c < ch; c++) small[o + c] *= k;
      }
    }
  }
  multiresBlurGrid(small, w2, h2, ch, sigma, f);
  return { small, w2, h2, f };
}

/** Downsample factor of the reduced-resolution blur for `sigma`. */
export function multiresFactor(sigma: number): number {
  return Math.max(2, Math.min(8, Math.floor(sigma / 3)));
}

/** The blur applied to a downsampled grid (factor f) so that, upsampled, it has the full sigma. */
export function multiresBlurGrid(small: Float32Array, w2: number, h2: number, ch: number, sigma: number, f: number) {
  const sl = Math.sqrt(Math.max(0.09, sigma * sigma - (f * f) / 4)) / f;
  if (sl < 1 && ch === 1) gaussSmallPlane(small, w2, h2, sl);
  else if (sl < 1 && ch === 4) gaussSmallRGBA(small, w2, h2, sl);
  else boxBlurPasses(small, w2, h2, ch, boxPassesForSigma(sl));
}

const oneCache = new Map<string, number>();

/**
 * blurPlane() of a w×h plane that is 1 everywhere, without blurring it: the result is uniform
 * (every element sees the same sums) and independent of the size beyond which code path runs,
 * so a small proxy that takes the same path gives the exact value. Lets opaque images skip
 * blurring their alpha plane.
 */
export function blurredOne(w: number, h: number, sigma: number): number {
  const pw = Math.min(w, 64),
    ph = Math.min(h, 64);
  const key = `${pw}x${ph}:${sigma}`;
  let v = oneCache.get(key);
  if (v === undefined) {
    const p = new Float32Array(pw * ph).fill(1);
    blurPlane(p, pw, ph, sigma);
    v = p[0];
    if (oneCache.size > 64) oneCache.clear();
    oneCache.set(key, v);
  }
  return v;
}

/** Gaussian-like blur of a float plane in place; `sigma` in px. */
export function blurPlane(buf: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (!(sigma > 0.15) || w < 2 || h < 2) return buf;
  if (sigma < 1) {
    gaussSmallPlane(buf, w, h, sigma);
    return buf;
  }
  if (sigma >= MULTIRES_SIGMA && w >= 16 && h >= 16) {
    blurMultires(buf, w, h, 1, sigma);
    return buf;
  }
  // 3 box passes with exactly the gaussian's variance
  boxBlurPasses(buf, w, h, 1, boxPassesForSigma(sigma));
  return buf;
}

/**
 * Repeated box blur of a float plane in place (clamp-to-edge). Running sums make it O(1) per
 * pixel; the vertical pass walks rows (one running sum per column) so memory stays sequential.
 */
export function boxBlurPlane(buf: Float32Array, w: number, h: number, r: number, passes = 3): Float32Array {
  return boxBlurInterleaved(buf, w, h, 1, r, passes);
}

/** One box pass: radius r, optional fractional end taps of weight alpha at ±(r + 1). */
export interface BoxPass {
  r: number;
  alpha: number;
}

/**
 * Box passes reproducing a gaussian of `sigma` exactly (same variance): two plain boxes of
 * radius r (r(r+1) ≤ σ²) and one extended box that makes up the remaining variance. Same cost
 * as three plain boxes (+~10%), but the blur grows smoothly with σ instead of in whole-pixel steps.
 */
export function boxPassesForSigma(sigma: number): BoxPass[] {
  const V = sigma * sigma;
  const r = Math.max(0, Math.floor((-1 + Math.sqrt(1 + 4 * V)) / 2));
  if (r < 1) {
    // small blurs: three identical extended 3-tap boxes keep a gaussian-like profile
    const b = boxForSigma(sigma, 3);
    return [b, b, b];
  }
  const V3 = Math.max(0, V - (2 * r * (r + 1)) / 3);
  return [{ r, alpha: 0 }, { r, alpha: 0 }, boxForSigma(Math.sqrt(V3), 1)];
}

/**
 * Box blur of interleaved data (`ch` floats per pixel) in place, `passes` times (3 ≈ gaussian
 * with sigma = sqrt(r(r+1))). With `alpha` > 0 each box is "extended": the taps at ±(r + 1) weigh
 * alpha (see boxForSigma). Exactly normalized (a constant image stays constant), clamp-to-edge,
 * with float precision between passes (no 8-bit rounding).
 */
export function boxBlurInterleaved(buf: Float32Array, w: number, h: number, ch: number, r: number, passes = 3, alpha = 0): Float32Array {
  const list: BoxPass[] = [];
  for (let i = 0; i < passes; i++) list.push({ r, alpha });
  return boxBlurPasses(buf, w, h, ch, list);
}

/** Run a list of (extended) box passes over interleaved data in place (clamp-to-edge). */
export function boxBlurPasses(buf: Float32Array, w: number, h: number, ch: number, list: BoxPass[]): Float32Array {
  if (w < 1 || h < 1) return buf;
  runBoxPasses(buf, w, h, ch, list, null, null);
  return buf;
}

/** Row source / sink for the streaming box blur (row y as `w·ch` floats). */
type RowIO = (y: number, row: Float32Array) => void;

/**
 * Streaming implementation of boxBlurPasses: pass p is a horizontal box H_p followed by a
 * vertical box V_p, and the passes are chained row by row — V_p only needs the H_p rows within
 * its window, so they live in a small ring buffer, and each V_p output row feeds H_{p+1}
 * directly. Every value goes through exactly the same floating-point operations, in the same
 * order, as running the passes one after another over whole images (float64 running sums,
 * float32 storage between steps), so results are bit-identical — but the intermediate rows stay
 * in cache and no full-size temporaries are allocated.
 *
 * Rows are read from `buf` (or `read(y, row)`) and the result written to `buf` (or
 * `write(y, row)`); input row y is always consumed before output row y is produced, so
 * in place is fine.
 */
function runBoxPasses(buf: Float32Array | null, w: number, h: number, ch: number, list: BoxPass[], read: RowIO | null, write: RowIO | null) {
  const stride = w * ch;
  const R: number[] = [],
    A: number[] = [];
  for (const pass of list) {
    const r = Math.max(0, Math.floor(pass.r));
    const ext = pass.alpha > 1e-6;
    if (r === 0 && !ext) continue;
    R.push(r);
    A.push(ext ? pass.alpha : 0);
  }
  if (!R.length) {
    if (read && write) {
      const row = new Float32Array(stride);
      for (let y = 0; y < h; y++) {
        read(y, row);
        write(y, row);
      }
    } else if (read && buf) for (let y = 0; y < h; y++) read(y, buf.subarray(y * stride, y * stride + stride));
    else if (write && buf) for (let y = 0; y < h; y++) write(y, buf.subarray(y * stride, y * stride + stride));
    return;
  }
  const st = new BoxStream(buf, w, h, ch, Int32Array.from(R), Float64Array.from(A), read, write);
  const last = R.length - 1;
  for (let y = 0; y < h; y++) {
    if (write) {
      st.produceV(last, st.outRow, 0);
      write(y, st.outRow);
    } else st.produceV(last, buf!, y * stride);
  }
}

/** State of one streaming box blur (see runBoxPasses): per pass a ring of H rows and V sums. */
class BoxStream {
  readonly stride: number;
  readonly size: Int32Array;
  readonly ring: Float32Array[];
  /** per pass: a view of each ring row (the vertical step reads whole rows without offsets) */
  readonly rows: Float32Array[][];
  readonly sums: Float64Array[];
  /** next row H_p / V_p produces */
  readonly hNext: Int32Array;
  readonly vNext: Int32Array;
  /** V_p → H_{p+1} hand-over row */
  readonly mid: Float32Array;
  readonly inRow: Float32Array;
  readonly outRow: Float32Array;
  constructor(
    readonly buf: Float32Array | null,
    readonly w: number,
    readonly h: number,
    readonly ch: number,
    /** per pass: box radius and fractional end-tap weight (0 = plain box) */
    readonly R: Int32Array,
    readonly A: Float64Array,
    readonly read: RowIO | null,
    readonly write: RowIO | null,
  ) {
    const P = R.length;
    const stride = (this.stride = w * ch);
    this.size = Int32Array.from(R, (r) => Math.min(h, 2 * r + 3));
    this.ring = Array.from(this.size, (sz) => new Float32Array(sz * stride));
    this.rows = this.ring.map((rg, p) => Array.from({ length: this.size[p] }, (_, k) => rg.subarray(k * stride, k * stride + stride)));
    this.sums = Array.from(R, () => new Float64Array(stride));
    this.hNext = new Int32Array(P);
    this.vNext = new Int32Array(P);
    this.mid = new Float32Array(stride);
    this.inRow = new Float32Array(read ? stride : 0);
    this.outRow = new Float32Array(write ? stride : 0);
  }
  /** V_p: produce its next output row into dst[dOff ..]. */
  produceV(p: number, dst: Float32Array, dOff: number) {
    const r = this.R[p],
      alpha = this.A[p],
      h = this.h,
      stride = this.stride;
    const y = this.vNext[p]++;
    const need = y + r + 1 < h ? y + r + 1 : h - 1;
    while (this.hNext[p] <= need) this.produceH(p);
    const Rg = this.ring[p],
      S = this.sums[p],
      sz = this.size[p];
    const inv = 1 / (2 * r + 1 + (alpha > 0 ? 2 * alpha : 0));
    if (y === 0) {
      for (let k = -r; k <= r; k++) {
        const rk = ((k < 0 ? 0 : k >= h ? h - 1 : k) % sz) * stride;
        for (let q = 0; q < stride; q++) S[q] += Rg[rk + q];
      }
    }
    const rows = this.rows[p];
    const add = rows[(y + r + 1 < h ? y + r + 1 : h - 1) % sz],
      rem = rows[(y - r > 0 ? y - r : 0) % sz];
    if (alpha === 0) vRow(S, add, rem, dst, dOff, stride, inv);
    else vRowExt(S, add, rem, rows[(y - r - 1 > 0 ? y - r - 1 : 0) % sz], dst, dOff, stride, inv, alpha);
  }
  /** H_p: produce its next row into the ring. */
  produceH(p: number) {
    const k = this.hNext[p]++;
    let src: Float32Array, sOff: number;
    if (p > 0) {
      this.produceV(p - 1, this.mid, 0);
      src = this.mid;
      sOff = 0;
    } else if (this.read) {
      this.read(k, this.inRow);
      src = this.inRow;
      sOff = 0;
    } else {
      src = this.buf!;
      sOff = k * this.stride;
    }
    const r = this.R[p],
      alpha = this.A[p],
      ch = this.ch;
    const dOff = (k % this.size[p]) * this.stride;
    const inv = 1 / (2 * r + 1 + (alpha > 0 ? 2 * alpha : 0));
    for (let c = 0; c < ch; c++) hRow(src, sOff + c, this.ring[p], dOff + c, this.w, ch, r, inv, alpha);
  }
}

/**
 * Vertical box step for one output row (plain box): out = S·inv, then S += add − rem. (The sum
 * is held in a local: V8 can't tell the float32 stores from the float64 sums apart and would
 * reload S[q] otherwise.)
 */
function vRow(S: Float64Array, add: Float32Array, rem: Float32Array, dst: Float32Array, dOff: number, n: number, inv: number) {
  for (let q = 0; q < n; q++) {
    const s = S[q];
    dst[dOff + q] = s * inv;
    S[q] = s + (add[q] - rem[q]);
  }
}

/** Vertical box step for one output row (extended box: fractional taps at ±(r + 1)). */
function vRowExt(S: Float64Array, addR: Float32Array, remR: Float32Array, upR: Float32Array, dst: Float32Array, dOff: number, n: number, inv: number, alpha: number) {
  for (let q = 0; q < n; q++) {
    const s = S[q];
    const add = addR[q];
    dst[dOff + q] = (s + alpha * (upR[q] + add)) * inv;
    S[q] = s + (add - remR[q]);
  }
}

/**
 * Horizontal (extended) box of one channel of an interleaved row, clamp-to-edge: the samples at
 * src[s + x·ch] → dst[o + x·ch], x = 0..w−1. Same phases and arithmetic as the whole-image pass
 * (running double sum), so results are bit-identical.
 */
function hRow(src: Float32Array, s: number, dst: Float32Array, o: number, w: number, ch: number, r: number, inv: number, alpha: number) {
  const first = src[s],
    lastV = src[s + (w - 1) * ch];
  let sum = 0;
  for (let k = -r; k <= r; k++) sum += k < 0 ? first : k >= w ? lastV : src[s + k * ch];
  const xAdd = Math.max(0, Math.min(w, w - r - 1)); // x < xAdd: add tap x+r+1 inside
  const xRem = Math.min(w, r + 1); // x >= xRem: remove tap x-r inside (> 0)
  const xm = Math.min(xAdd, xRem);
  let x = 0;
  let q = o;
  if (alpha === 0) {
    for (; x < xm; x++, q += ch) {
      dst[q] = sum * inv;
      sum += src[s + (x + r + 1) * ch] - first;
    }
    if (xAdd >= xRem) {
      let ia = s + (x + r + 1) * ch,
        ir = s + (x - r) * ch;
      for (; x < xAdd; x++, q += ch, ia += ch, ir += ch) {
        dst[q] = sum * inv;
        sum += src[ia] - src[ir];
      }
    } else {
      for (; x < xRem; x++, q += ch) {
        dst[q] = sum * inv;
        sum += lastV - first;
      }
    }
    for (; x < w; x++, q += ch) {
      dst[q] = sum * inv;
      const rem = x - r;
      sum += lastV - (rem > 0 ? src[s + rem * ch] : first);
    }
    return;
  }
  for (; x < xm; x++, q += ch) {
    const add = src[s + (x + r + 1) * ch];
    dst[q] = (sum + alpha * (first + add)) * inv;
    sum += add - first;
  }
  if (xAdd >= xRem) {
    let ia = s + (x + r + 1) * ch,
      ir = s + (x - r) * ch;
    let prevRem = x - r - 1 > 0 ? src[ir - ch] : first;
    for (; x < xAdd; x++, q += ch, ia += ch, ir += ch) {
      const add = src[ia],
        rem = src[ir];
      dst[q] = (sum + alpha * (prevRem + add)) * inv;
      sum += add - rem;
      prevRem = rem;
    }
  } else {
    for (; x < xRem; x++, q += ch) {
      dst[q] = (sum + alpha * (first + lastV)) * inv;
      sum += lastV - first;
    }
  }
  for (; x < w; x++, q += ch) {
    const rem = x - r;
    const left = rem - 1 > 0 ? src[s + (rem - 1) * ch] : first;
    dst[q] = (sum + alpha * (left + lastV)) * inv;
    sum += lastV - (rem > 0 ? src[s + rem * ch] : first);
  }
}

/**
 * Evaluate a smooth field `fn(x, y)` (image px) on a coarse grid every `step` px and upsample
 * it bilinearly — for low-frequency noise (blotches, wobble, displacement) that would otherwise
 * be evaluated per pixel.
 */
export function coarseField(w: number, h: number, step: number, fn: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(w * h);
  const st = Math.max(1, Math.floor(step));
  if (st <= 1) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = fn(x, y);
    return out;
  }
  const gw = Math.ceil((w - 1) / st) + 1,
    gh = Math.ceil((h - 1) / st) + 1;
  const g = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) g[j * gw + i] = fn(i * st, j * st);
  const inv = 1 / st;
  for (let y = 0; y < h; y++) {
    const fy = y * inv;
    const j0 = fy | 0;
    const j1 = j0 < gh - 1 ? j0 + 1 : j0;
    const ty = fy - j0;
    const r0 = j0 * gw,
      r1 = j1 * gw;
    for (let x = 0; x < w; x++) {
      const fx = x * inv;
      const i0 = fx | 0;
      const i1 = i0 < gw - 1 ? i0 + 1 : i0;
      const tx = fx - i0;
      const a = g[r0 + i0] + (g[r0 + i1] - g[r0 + i0]) * tx;
      const b = g[r1 + i0] + (g[r1 + i1] - g[r1 + i0]) * tx;
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return out;
}

export function blurPlanes(p: Planes, w: number, h: number, sigma: number) {
  blurPlane(p.r, w, h, sigma);
  blurPlane(p.g, w, h, sigma);
  blurPlane(p.b, w, h, sigma);
  blurPlane(p.a, w, h, sigma);
}

export function premultiplyInPlace(d: Uint8ClampedArray) {
  for (let j = 0; j < d.length; j += 4) {
    const a = d[j + 3];
    if (a === 255) continue;
    const m = a / 255;
    d[j] *= m;
    d[j + 1] *= m;
    d[j + 2] *= m;
  }
}

export function unpremultiplyInPlace(d: Uint8ClampedArray) {
  for (let j = 0; j < d.length; j += 4) {
    const a = d[j + 3];
    if (a === 255) continue;
    if (a === 0) {
      d[j] = d[j + 1] = d[j + 2] = 0;
      continue;
    }
    const m = 255 / a;
    d[j] *= m;
    d[j + 1] *= m;
    d[j + 2] *= m;
  }
}

/** Premultiplied interleaved float copy of RGBA data (0..255 scale). */
function premultipliedFloats(d: Uint8ClampedArray): Float32Array {
  const f = new Float32Array(d.length);
  for (let j = 0; j < d.length; j += 4) {
    const a = d[j + 3];
    f[j + 3] = a;
    if (a === 255) {
      f[j] = d[j];
      f[j + 1] = d[j + 1];
      f[j + 2] = d[j + 2];
    } else if (a !== 0) {
      const m = a / 255;
      f[j] = d[j] * m;
      f[j + 1] = d[j + 1] * m;
      f[j + 2] = d[j + 2] * m;
    }
  }
  return f;
}

/** premultipliedFloats for one row: d[o..o+n) → f[0..n). */
function premultiplyRow(d: Uint8ClampedArray, o: number, f: Float32Array, n: number) {
  for (let j = 0; j < n; j += 4) {
    const a = d[o + j + 3];
    f[j + 3] = a;
    if (a === 255) {
      f[j] = d[o + j];
      f[j + 1] = d[o + j + 1];
      f[j + 2] = d[o + j + 2];
    } else if (a !== 0) {
      const m = a / 255;
      f[j] = d[o + j] * m;
      f[j + 1] = d[o + j + 1] * m;
      f[j + 2] = d[o + j + 2] * m;
    } else {
      f[j] = f[j + 1] = f[j + 2] = 0;
    }
  }
}

/** unpremultiplyFloats for one row: f[0..n) → d[o..o+n). */
function unpremultiplyRow(f: Float32Array, d: Uint8ClampedArray, o: number, n: number) {
  for (let j = 0; j < n; j += 4) {
    const a = f[j + 3];
    const k = o + j;
    if (a >= 254.5) {
      d[k] = f[j];
      d[k + 1] = f[j + 1];
      d[k + 2] = f[j + 2];
      d[k + 3] = 255;
    } else if (a < 0.5) {
      d[k] = d[k + 1] = d[k + 2] = d[k + 3] = 0;
    } else {
      const m = 255 / a;
      d[k] = f[j] * m;
      d[k + 1] = f[j + 1] * m;
      d[k + 2] = f[j + 2] * m;
      d[k + 3] = a;
    }
  }
}

/** Write premultiplied interleaved floats back as straight RGBA. */
function unpremultiplyFloats(f: Float32Array, d: Uint8ClampedArray) {
  for (let j = 0; j < d.length; j += 4) {
    const a = f[j + 3];
    if (a >= 254.5) {
      d[j] = f[j];
      d[j + 1] = f[j + 1];
      d[j + 2] = f[j + 2];
      d[j + 3] = 255;
    } else if (a < 0.5) {
      d[j] = d[j + 1] = d[j + 2] = d[j + 3] = 0;
    } else {
      const m = 255 / a;
      d[j] = f[j] * m;
      d[j + 1] = f[j + 1] * m;
      d[j + 2] = f[j + 2] * m;
      d[j + 3] = a;
    }
  }
}

/** Exact separable gaussian of interleaved RGBA floats in place (small sigmas). Clamp-to-edge. */
function gaussSmallRGBA(f: Float32Array, w: number, h: number, sigma: number) {
  const k = gaussKernel(sigma);
  const r = (k.length - 1) >> 1;
  const K = k.length;
  const stride = w * 4;
  const tmp = new Float32Array(f.length);
  const xa = Math.min(r, w),
    xb = Math.max(xa, w - r);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      let s0 = 0,
        s1 = 0,
        s2 = 0,
        s3 = 0;
      if (x >= xa && x < xb) {
        let p = row + (x - r) * 4;
        for (let i = 0; i < K; i++, p += 4) {
          const kv = k[i];
          s0 += f[p] * kv;
          s1 += f[p + 1] * kv;
          s2 += f[p + 2] * kv;
          s3 += f[p + 3] * kv;
        }
      } else {
        for (let i = 0; i < K; i++) {
          const xx = x - r + i;
          const p = row + (xx < 0 ? 0 : xx >= w ? w - 1 : xx) * 4;
          const kv = k[i];
          s0 += f[p] * kv;
          s1 += f[p + 1] * kv;
          s2 += f[p + 2] * kv;
          s3 += f[p + 3] * kv;
        }
      }
      const o = row + x * 4;
      tmp[o] = s0;
      tmp[o + 1] = s1;
      tmp[o + 2] = s2;
      tmp[o + 3] = s3;
    }
  }
  const acc = new Float32Array(stride);
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let i = -r; i <= r; i++) {
      const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
      const src = yy * stride;
      const kv = k[i + r];
      for (let q = 0; q < stride; q++) acc[q] += tmp[src + q] * kv;
    }
    f.set(acc, y * stride);
  }
}

/**
 * Gaussian blur of an RGBA image in place with premultiplied alpha (no dark fringes at
 * transparent edges). `sigma` in image px: exact gaussian kernel below 1 px, 3 box passes of
 * exactly the same variance above (at reduced resolution for big radii).
 *
 * This (rather than core/blur's boxBlurImageData) backs Gaussian Blur and every blur-based
 * filter on purpose: it honours fractional radii (boxBlurImageData rounds to whole px and its
 * smallest blur is σ≈1.4), keeps float precision between passes (no 8-bit rounding → no banding
 * on smooth gradients or soft alpha edges), is premultiplied, and its vertical pass walks rows
 * instead of columns (cache friendly: ~3× faster at 1920×1080, measured 313 vs 881 ms at σ≈4.5).
 */
export function blurImage<T extends Img>(img: T, sigma: number): T {
  if (!(sigma > 0.2)) return img;
  const { width: w, height: h } = img;
  if (sigma >= 1 && !(sigma >= MULTIRES_SIGMA && w >= 16 && h >= 16)) {
    // box passes, streamed row by row straight from / to the bytes (no full-size float copy)
    const d = img.data;
    const rs = w * 4;
    const passes = boxPassesForSigma(sigma);
    if (isOpaque(d)) {
      // Opaque: premultiplying is the identity and the alpha plane stays exactly 255 (a box of a
      // constant reproduces it after float32 rounding), so only the three color channels are
      // blurred (interleaved RGB rows) — same values as the 4-channel path, 25% less work.
      runBoxPasses(
        null,
        w,
        h,
        3,
        passes,
        (y, row) => {
          for (let x = 0, k = y * rs, q = 0; x < w; x++, k += 4, q += 3) {
            row[q] = d[k];
            row[q + 1] = d[k + 1];
            row[q + 2] = d[k + 2];
          }
        },
        (y, row) => {
          for (let x = 0, k = y * rs, q = 0; x < w; x++, k += 4, q += 3) {
            d[k] = row[q];
            d[k + 1] = row[q + 1];
            d[k + 2] = row[q + 2];
          }
        },
      );
      return img;
    }
    runBoxPasses(
      null,
      w,
      h,
      4,
      passes,
      (y, row) => premultiplyRow(d, y * rs, row, rs),
      (y, row) => unpremultiplyRow(row, d, y * rs, rs),
    );
    return img;
  }
  if (sigma >= MULTIRES_SIGMA && w >= 16 && h >= 16) {
    blurImageMultires(img.data, w, h, sigma);
    return img;
  }
  const f = premultipliedFloats(img.data);
  if (sigma < 1) gaussSmallRGBA(f, w, h, sigma);
  else boxBlurPasses(f, w, h, 4, boxPassesForSigma(sigma));
  unpremultiplyFloats(f, img.data);
  return img;
}

/**
 * blurImage for big sigmas = premultipliedFloats → blurMultires(…, 4, σ) → unpremultiplyFloats,
 * without the full-size float copy: the premultiplied values are summed into the downsampled
 * cells straight from the bytes (per channel in the same order: rows of a cell top to bottom,
 * pixels left to right, float32 sums), and each upsampled value (rounded to float32 like the
 * float plane stores it) is un-premultiplied straight into the bytes. Identical results.
 */
function blurImageMultires(d: Uint8ClampedArray, w: number, h: number, sigma: number) {
  const f = multiresFactor(sigma);
  const w2 = Math.ceil(w / f),
    h2 = Math.ceil(h / f);
  const small = new Float32Array(w2 * h2 * 4);
  for (let y2 = 0; y2 < h2; y2++) {
    const y0 = y2 * f,
      y1 = Math.min(h, y0 + f);
    const o = y2 * w2 * 4;
    for (let y = y0; y < y1; y++) downsampleRowPremul(d, y * w * 4, w, f, w2, small, o);
    const kh = y1 - y0;
    for (let x2 = 0, x0 = 0; x2 < w2; x2++, x0 += f) {
      const k = 1 / (((x0 + f < w ? x0 + f : w) - x0) * kh);
      const oc = o + x2 * 4;
      small[oc] *= k;
      small[oc + 1] *= k;
      small[oc + 2] *= k;
      small[oc + 3] *= k;
    }
  }
  multiresBlurGrid(small, w2, h2, 4, sigma, f);
  // bilinear upsample (cell centers at (i + 0.5)·f) → un-premultiplied bytes
  const invF = 1 / f;
  const xi0 = new Int32Array(w),
    xi1 = new Int32Array(w),
    xt = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let fx = (x + 0.5) * invF - 0.5;
    if (fx < 0) fx = 0;
    else if (fx > w2 - 1) fx = w2 - 1;
    const i0 = fx | 0;
    xi0[x] = i0 * 4;
    xi1[x] = (i0 < w2 - 1 ? i0 + 1 : i0) * 4;
    xt[x] = fx - i0;
  }
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * invF - 0.5;
    if (fy < 0) fy = 0;
    else if (fy > h2 - 1) fy = h2 - 1;
    const j0 = fy | 0;
    upsampleRowUnpremul(small, j0 * w2 * 4, (j0 < h2 - 1 ? j0 + 1 : j0) * w2 * 4, fy - j0, xi0, xi1, xt, d, y * w * 4, w);
  }
}

/** One image row's premultiplied pixels (bytes at d[j..]) added into its cells (float32 sums). */
function downsampleRowPremul(d: Uint8ClampedArray, j: number, w: number, f: number, w2: number, small: Float32Array, o: number) {
  for (let x2 = 0, x0 = 0; x2 < w2; x2++, x0 += f) {
    const x1 = x0 + f < w ? x0 + f : w;
    const oc = o + x2 * 4;
    let s0 = small[oc],
      s1 = small[oc + 1],
      s2 = small[oc + 2],
      s3 = small[oc + 3];
    for (let x = x0; x < x1; x++, j += 4) {
      const a = d[j + 3];
      if (a === 255) {
        s0 = Math.fround(s0 + d[j]);
        s1 = Math.fround(s1 + d[j + 1]);
        s2 = Math.fround(s2 + d[j + 2]);
        s3 = Math.fround(s3 + 255);
      } else if (a !== 0) {
        // premultipliedFloats: the float32 of byte · a/255
        const m = a / 255;
        s0 = Math.fround(s0 + Math.fround(d[j] * m));
        s1 = Math.fround(s1 + Math.fround(d[j + 1] * m));
        s2 = Math.fround(s2 + Math.fround(d[j + 2] * m));
        s3 = Math.fround(s3 + a);
      }
      // a = 0 adds 0 to every channel (s + 0 = s)
    }
    small[oc] = s0;
    small[oc + 1] = s1;
    small[oc + 2] = s2;
    small[oc + 3] = s3;
  }
}

/**
 * One output row of the bilinear upsample of the 4-channel grid (grid rows r0 / r1, y-fraction
 * ty) un-premultiplied into the bytes at d[j..] (unpremultiplyFloats on the float32 values).
 */
function upsampleRowUnpremul(small: Float32Array, r0: number, r1: number, ty: number, xi0: Int32Array, xi1: Int32Array, xt: Float32Array, d: Uint8ClampedArray, j: number, w: number) {
  for (let x = 0; x < w; x++, j += 4) {
    const a0 = r0 + xi0[x],
      a1 = r0 + xi1[x],
      b0 = r1 + xi0[x],
      b1 = r1 + xi1[x];
    const tx = xt[x];
    let top = small[a0 + 3] + (small[a1 + 3] - small[a0 + 3]) * tx;
    let bot = small[b0 + 3] + (small[b1 + 3] - small[b0 + 3]) * tx;
    const a = Math.fround(top + (bot - top) * ty);
    if (a < 0.5) {
      d[j] = d[j + 1] = d[j + 2] = d[j + 3] = 0;
      continue;
    }
    top = small[a0] + (small[a1] - small[a0]) * tx;
    bot = small[b0] + (small[b1] - small[b0]) * tx;
    const v0 = Math.fround(top + (bot - top) * ty);
    top = small[a0 + 1] + (small[a1 + 1] - small[a0 + 1]) * tx;
    bot = small[b0 + 1] + (small[b1 + 1] - small[b0 + 1]) * tx;
    const v1 = Math.fround(top + (bot - top) * ty);
    top = small[a0 + 2] + (small[a1 + 2] - small[a0 + 2]) * tx;
    bot = small[b0 + 2] + (small[b1 + 2] - small[b0 + 2]) * tx;
    const v2 = Math.fround(top + (bot - top) * ty);
    if (a >= 254.5) {
      d[j] = v0;
      d[j + 1] = v1;
      d[j + 2] = v2;
      d[j + 3] = 255;
    } else {
      const m = 255 / a;
      d[j] = v0 * m;
      d[j + 1] = v1 * m;
      d[j + 2] = v2 * m;
      d[j + 3] = a;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Gradients, edges, distance                                          */
/* ------------------------------------------------------------------ */

/** Sobel gradient of a float plane. Returns gx, gy (each ≈ ±1 for a unit step) and magnitude. */
export function sobel(buf: Float32Array, w: number, h: number): { gx: Float32Array; gy: Float32Array; mag: Float32Array } {
  const gx = new Float32Array(w * h),
    gy = new Float32Array(w * h),
    mag = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w,
      y0 = y * w,
      yp = (y < h - 1 ? y + 1 : y) * w;
    if (w >= 3) {
      sobelRow(buf, gx, gy, mag, ym, y0, yp, w);
      continue;
    }
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0,
        xp = x < w - 1 ? x + 1 : x;
      const a = buf[ym + xm],
        b = buf[ym + x],
        c = buf[ym + xp],
        d = buf[y0 + xm],
        f = buf[y0 + xp],
        g = buf[yp + xm],
        hh = buf[yp + x],
        k = buf[yp + xp];
      const sx = (c + 2 * f + k - a - 2 * d - g) * 0.25;
      const sy = (g + 2 * hh + k - a - 2 * b - c) * 0.25;
      const i = y0 + x;
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return { gx, gy, mag };
}

/** sobel() for one row (w ≥ 3): clamped end columns, branch-free interior; same arithmetic. */
function sobelRow(buf: Float32Array, gx: Float32Array, gy: Float32Array, mag: Float32Array, ym: number, y0: number, yp: number, w: number) {
  for (let x = 0; x < w; x++) {
    const xm = x > 0 ? x - 1 : 0,
      xp = x < w - 1 ? x + 1 : x;
    if (x === 1) {
      // interior: x − 1 and x + 1 inside
      const end = w - 1;
      for (; x < end; x++) {
        const a = buf[ym + x - 1],
          b = buf[ym + x],
          c = buf[ym + x + 1],
          d = buf[y0 + x - 1],
          f = buf[y0 + x + 1],
          g = buf[yp + x - 1],
          hh = buf[yp + x],
          k = buf[yp + x + 1];
        const sx = (c + 2 * f + k - a - 2 * d - g) * 0.25;
        const sy = (g + 2 * hh + k - a - 2 * b - c) * 0.25;
        const i = y0 + x;
        gx[i] = sx;
        gy[i] = sy;
        mag[i] = Math.sqrt(sx * sx + sy * sy);
      }
      x--; // the loop increment moves on to the last column
      continue;
    }
    const a = buf[ym + xm],
      b = buf[ym + x],
      c = buf[ym + xp],
      d = buf[y0 + xm],
      f = buf[y0 + xp],
      g = buf[yp + xm],
      hh = buf[yp + x],
      k = buf[yp + xp];
    const sx = (c + 2 * f + k - a - 2 * d - g) * 0.25;
    const sy = (g + 2 * hh + k - a - 2 * b - c) * 0.25;
    const i = y0 + x;
    gx[i] = sx;
    gy[i] = sy;
    mag[i] = Math.sqrt(sx * sx + sy * sy);
  }
}

/**
 * Thin edges: non-maximum suppression along the gradient direction, then threshold.
 * Returns a 0/1 seed mask.
 */
export function edgeSeeds(mag: Float32Array, gx: Float32Array, gy: Float32Array, w: number, h: number, threshold: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < threshold) continue;
      const ax = Math.abs(gx[i]),
        ay = Math.abs(gy[i]);
      let n1: number, n2: number;
      if (ax > ay * 2.414) {
        n1 = mag[i - 1];
        n2 = mag[i + 1];
      } else if (ay > ax * 2.414) {
        n1 = mag[i - w];
        n2 = mag[i + w];
      } else if (gx[i] * gy[i] > 0) {
        n1 = mag[i - w - 1];
        n2 = mag[i + w + 1];
      } else {
        n1 = mag[i - w + 1];
        n2 = mag[i + w - 1];
      }
      if (m >= n1 && m >= n2) out[i] = 1;
    }
  }
  return out;
}

const EDT_INF = 1e20;

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -EDT_INF;
  z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Euclidean distance transform (Felzenszwalb–Huttenlocher): distance in px from each pixel to the
 * nearest seed (seed[i] !== 0). Pixels with no seed in the image get a huge distance.
 */
export function distanceTransform(seed: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n),
    d = new Float64Array(n),
    z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = seed[i] ? 0 : EDT_INF;
  // columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  // rows
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = Math.sqrt(d[x]);
  }
  return out;
}

/** Disc of integer offsets within radius R, sorted by distance. */
const discCache = new Map<number, { dx: Int32Array; dy: Int32Array; d: Float32Array }>();
function discOffsets(R: number) {
  let c = discCache.get(R);
  if (c) return c;
  const pts: [number, number, number][] = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= R + 0.5) pts.push([dx, dy, d]);
    }
  pts.sort((a, b) => a[2] - b[2]);
  c = { dx: Int32Array.from(pts, (p) => p[0]), dy: Int32Array.from(pts, (p) => p[1]), d: Float32Array.from(pts, (p) => p[2]) };
  discCache.set(R, c);
  return c;
}

/**
 * Euclidean distance to the nearest seed, exact up to `maxD` (farther pixels get `maxD + 1`).
 * Only seeds on the boundary of the seed set can be nearest to a non-seed pixel, so their discs
 * are stamped; far cheaper than a full transform for thin outlines and small radii (falls back
 * to the exact transform when stamping would cost more).
 */
export function boundedDistance(seed: Uint8Array, w: number, h: number, maxD: number): Float32Array {
  const n = w * h;
  const far = maxD + 1;
  const out = new Float32Array(n).fill(far);
  const R = Math.max(0, Math.ceil(maxD));
  const bnd: number[] = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!seed[i]) continue;
      out[i] = 0;
      if ((x > 0 && !seed[i - 1]) || (x < w - 1 && !seed[i + 1]) || (y > 0 && !seed[i - w]) || (y < h - 1 && !seed[i + w])) bnd.push(i);
    }
  }
  if (R === 0 || !bnd.length) return out;
  const disc = discOffsets(R);
  const m = disc.d.length;
  if (bnd.length * m > Math.max(4e6, n * 6)) {
    const dt = distanceTransform(seed, w, h);
    for (let i = 0; i < n; i++) out[i] = dt[i] < far ? dt[i] : far;
    return out;
  }
  const { dx, dy, d } = disc;
  for (let b = 0; b < bnd.length; b++) {
    const i = bnd[b];
    const x = i % w,
      y = (i - x) / w;
    const inside = x >= R && y >= R && x < w - R && y < h - R;
    for (let k = 1; k < m; k++) {
      const dk = d[k];
      if (dk > maxD + 0.5) break;
      let q: number;
      if (inside) q = i + dy[k] * w + dx[k];
      else {
        const xx = x + dx[k],
          yy = y + dy[k];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        q = yy * w + xx;
      }
      if (dk < out[q]) out[q] = dk;
    }
  }
  return out;
}

/**
 * Inside distance: distance from each pixel to the nearest "outside" pixel (alpha < 50%),
 * treating everything beyond the image border as outside when `borderIsOutside`.
 * With `maxD`, distances are exact only up to maxD (farther = maxD + 1) — much faster.
 */
export function insideDistance(img: Img, borderIsOutside = true, maxD?: number): Float32Array {
  const { width: w, height: h, data } = img;
  if (maxD !== undefined && isFinite(maxD)) {
    const n = w * h;
    const seed = new Uint8Array(n);
    for (let i = 0, j = 3; i < n; i++, j += 4) seed[i] = data[j] < 128 ? 1 : 0;
    const out = boundedDistance(seed, w, h, maxD);
    if (borderIsOutside) {
      // the virtual ring of outside pixels just beyond the border
      for (let y = 0; y < h; y++) {
        const dyb = Math.min(y + 1, h - y);
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const db = Math.min(dyb, x + 1, w - x);
          if (db < out[row + x]) out[row + x] = db;
        }
      }
    }
    return out;
  }
  // pad by 1 so the border counts as outside
  const pw = w + 2,
    ph = h + 2;
  const seed = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = y * pw + x;
      if (x === 0 || y === 0 || x === pw - 1 || y === ph - 1) {
        seed[i] = borderIsOutside ? 1 : 0;
        continue;
      }
      seed[i] = data[((y - 1) * w + (x - 1)) * 4 + 3] < 128 ? 1 : 0;
    }
  }
  const dt = distanceTransform(seed, pw, ph);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = dt[(y + 1) * pw + x + 1];
  return out;
}

/* ------------------------------------------------------------------ */
/* Sampling / remapping                                                */
/* ------------------------------------------------------------------ */

/** Pick an edge mode: images opaque at their border clamp, cut-outs sample transparency. */
export function autoEdge(img: Img): Edge {
  const { width: w, height: h, data } = img;
  let opaque = 0,
    total = 0;
  const stepX = Math.max(1, Math.floor(w / 64)),
    stepY = Math.max(1, Math.floor(h / 64));
  for (let x = 0; x < w; x += stepX) {
    total += 2;
    if (data[x * 4 + 3] > 250) opaque++;
    if (data[((h - 1) * w + x) * 4 + 3] > 250) opaque++;
  }
  for (let y = 0; y < h; y += stepY) {
    total += 2;
    if (data[y * w * 4 + 3] > 250) opaque++;
    if (data[(y * w + w - 1) * 4 + 3] > 250) opaque++;
  }
  return opaque >= total * 0.9 ? 'clamp' : 'transparent';
}

/**
 * Premultiplied bilinear sample of `src` at index-space (fx, fy) into dst[o..o+3].
 * Out-of-range taps follow `edge`.
 */
export function sampleBilinear(src: Uint8ClampedArray, w: number, h: number, fx: number, fy: number, dst: Uint8ClampedArray, o: number, edge: Edge) {
  let x0 = Math.floor(fx),
    y0 = Math.floor(fy);
  const tx = fx - x0,
    ty = fy - y0;
  let x1 = x0 + 1,
    y1 = y0 + 1;
  let w00 = (1 - tx) * (1 - ty),
    w10 = tx * (1 - ty),
    w01 = (1 - tx) * ty,
    w11 = tx * ty;
  if (edge === 'clamp') {
    x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
    x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1;
    y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
    y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1;
  } else if (edge === 'wrap') {
    x0 = ((x0 % w) + w) % w;
    x1 = ((x1 % w) + w) % w;
    y0 = ((y0 % h) + h) % h;
    y1 = ((y1 % h) + h) % h;
  } else {
    if (x0 < 0 || x0 >= w) w00 = w01 = 0;
    if (x1 < 0 || x1 >= w) w10 = w11 = 0;
    if (y0 < 0 || y0 >= h) w00 = w10 = 0;
    if (y1 < 0 || y1 >= h) w01 = w11 = 0;
    x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
    x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1;
    y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
    y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1;
  }
  const i00 = (y0 * w + x0) * 4,
    i10 = (y0 * w + x1) * 4,
    i01 = (y1 * w + x0) * 4,
    i11 = (y1 * w + x1) * 4;
  const a00 = src[i00 + 3] * w00,
    a10 = src[i10 + 3] * w10,
    a01 = src[i01 + 3] * w01,
    a11 = src[i11 + 3] * w11;
  const A = a00 + a10 + a01 + a11;
  if (A <= 0.001) {
    dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0;
    return;
  }
  const inv = 1 / A;
  dst[o] = (src[i00] * a00 + src[i10] * a10 + src[i01] * a01 + src[i11] * a11) * inv;
  dst[o + 1] = (src[i00 + 1] * a00 + src[i10 + 1] * a10 + src[i01 + 1] * a01 + src[i11 + 1] * a11) * inv;
  dst[o + 2] = (src[i00 + 2] * a00 + src[i10 + 2] * a10 + src[i01 + 2] * a01 + src[i11 + 2] * a11) * inv;
  dst[o + 3] = A;
}

/** Bilinear sample of a float plane (clamped). */
export function samplePlane(buf: Float32Array, w: number, h: number, fx: number, fy: number): number {
  if (fx < 0) fx = 0;
  else if (fx > w - 1) fx = w - 1;
  if (fy < 0) fy = 0;
  else if (fy > h - 1) fy = h - 1;
  const x0 = fx | 0,
    y0 = fy | 0;
  const x1 = x0 < w - 1 ? x0 + 1 : x0,
    y1 = y0 < h - 1 ? y0 + 1 : y0;
  const tx = fx - x0,
    ty = fy - y0;
  const r0 = buf[y0 * w + x0] + (buf[y0 * w + x1] - buf[y0 * w + x0]) * tx;
  const r1 = buf[y1 * w + x0] + (buf[y1 * w + x1] - buf[y1 * w + x0]) * tx;
  return r0 + (r1 - r0) * ty;
}

/**
 * Inverse-mapping distortion helper. `fill(sx, sy, y)` must write, for every output pixel x of row
 * y, the index-space source coordinates. Sampling is premultiplied bilinear.
 */
export function remap<T extends Img>(img: T, fill: (sx: Float32Array, sy: Float32Array, y: number) => void, edge: Edge = autoEdge(img)): T {
  const { width: w, height: h } = img;
  const src = new Uint8ClampedArray(img.data);
  const dst = img.data;
  const sx = new Float32Array(w),
    sy = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    fill(sx, sy, y);
    let o = y * w * 4;
    for (let x = 0; x < w; x++, o += 4) sampleBilinear(src, w, h, sx[x], sy[x], dst, o, edge);
  }
  return img;
}

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

/** Fast integer hash → [0,1). */
export function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1] (bilinear with smoothstep). */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  let tx = x - xi,
    ty = y - yi;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const a = hash(xi, yi, seed),
    b = hash(xi + 1, yi, seed),
    c = hash(xi, yi + 1, seed),
    d = hash(xi + 1, yi + 1, seed);
  const r0 = a + (b - a) * tx,
    r1 = c + (d - c) * tx;
  return r0 + (r1 - r0) * ty;
}

/** Fractal value noise in [0,1]. */
export function fbmValue(x: number, y: number, seed: number, octaves = 4, gain = 0.5): number {
  let amp = 1,
    sum = 0,
    norm = 0,
    f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, y * f, seed + o * 1013) * amp;
    norm += amp;
    amp *= gain;
    f *= 2.03;
  }
  return sum / norm;
}

/** Approximately gaussian random in ~[-1,1] from a hash (sum of 3 uniforms, centered). */
export function hashGauss(x: number, y: number, seed: number): number {
  return (hash(x, y, seed) + hash(x, y, seed + 7919) + hash(x, y, seed + 15485) - 1.5) * 1.1547;
}

/**
 * `out[k] = hashGauss(x0 + k, y, seed)` for k = 0..n−1 — the same values, with the y and seed
 * terms of the three hashes computed once per row.
 */
export function hashGaussRow(out: Float64Array, x0: number, n: number, y: number, seed: number) {
  const ty = Math.imul(y | 0, 668265263);
  const s1 = Math.imul(seed | 0, 1442695041),
    s2 = Math.imul((seed + 7919) | 0, 1442695041),
    s3 = Math.imul((seed + 15485) | 0, 1442695041);
  for (let k = 0; k < n; k++) {
    const b = Math.imul((x0 + k) | 0, 374761393) ^ ty;
    let h1 = b ^ s1;
    h1 = Math.imul(h1 ^ (h1 >>> 13), 1274126177);
    h1 ^= h1 >>> 16;
    let h2 = b ^ s2;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 1274126177);
    h2 ^= h2 >>> 16;
    let h3 = b ^ s3;
    h3 = Math.imul(h3 ^ (h3 >>> 13), 1274126177);
    h3 ^= h3 >>> 16;
    out[k] = ((h1 >>> 0) / 4294967296 + (h2 >>> 0) / 4294967296 + (h3 >>> 0) / 4294967296 - 1.5) * 1.1547;
  }
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Color                                                               */
/* ------------------------------------------------------------------ */

/** Saturation adjust around luma, factor 1 = unchanged. Writes into data in place. */
export function saturateInPlace(d: Uint8ClampedArray, factor: number) {
  if (Math.abs(factor - 1) < 1e-3) return;
  for (let j = 0; j < d.length; j += 4) {
    if (d[j + 3] === 0) continue;
    const l = d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722;
    d[j] = l + (d[j] - l) * factor;
    d[j + 1] = l + (d[j + 1] - l) * factor;
    d[j + 2] = l + (d[j + 2] - l) * factor;
  }
}

/** Contrast factor for a -100..100 slider (Photoshop-like curve). */
export function contrastFactor(c: number): number {
  const v = clamp(c, -100, 100) / 100;
  return v >= 0 ? 1 / Math.max(0.02, 1 - v * 0.98) : 1 + v;
}

/** Blend result over the original (mix 0..1) in place: data = orig + (data - orig) * mix. */
export function mixWith(orig: Uint8ClampedArray, data: Uint8ClampedArray, mix: number) {
  if (mix >= 0.999) return;
  const m = clamp01(mix);
  for (let j = 0; j < data.length; j++) data[j] = orig[j] + (data[j] - orig[j]) * m;
}
