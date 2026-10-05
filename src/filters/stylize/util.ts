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

/** Exact separable gaussian on a float plane in place (small sigmas). Clamp-to-edge. */
function gaussSmallPlane(buf: Float32Array, w: number, h: number, sigma: number) {
  const k = gaussKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) convolveRow(buf, tmp, y * w, w, k, r);
  // vertical: accumulate whole rows (sequential memory)
  const acc = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let i = -r; i <= r; i++) {
      const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
      const src = yy * w;
      const kv = k[i + r];
      for (let x = 0; x < w; x++) acc[x] += tmp[src + x] * kv;
    }
    buf.set(acc, y * w);
  }
}

/** Gaussian-like blur of a float plane in place; `sigma` in px. */
export function blurPlane(buf: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (!(sigma > 0.15) || w < 2 || h < 2) return buf;
  if (sigma < 2) {
    gaussSmallPlane(buf, w, h, sigma);
    return buf;
  }
  // 3 box passes of radius r ≈ gaussian sigma sqrt(r(r+1)).
  const r = Math.max(1, Math.round((-1 + Math.sqrt(1 + 4 * sigma * sigma)) / 2));
  boxBlurPlane(buf, w, h, Math.min(r, Math.max(w, h)), 3);
  return buf;
}

/**
 * Repeated box blur of a float plane in place (clamp-to-edge). Running sums make it O(1) per
 * pixel; the vertical pass walks rows (one running sum per column) so memory stays sequential.
 */
export function boxBlurPlane(buf: Float32Array, w: number, h: number, r: number, passes = 3): Float32Array {
  return boxBlurInterleaved(buf, w, h, 1, r, passes);
}

/**
 * Box blur of interleaved data (`ch` floats per pixel) in place, `passes` times (3 ≈ gaussian
 * with sigma = sqrt(r(r+1))). Exactly normalized: a constant image stays constant, with sub-pixel
 * float precision (no 8-bit rounding between passes).
 */
export function boxBlurInterleaved(buf: Float32Array, w: number, h: number, ch: number, r: number, passes = 3): Float32Array {
  if (r < 1 || w < 1 || h < 1) return buf;
  const inv = 1 / (2 * r + 1);
  const stride = w * ch;
  const tmp = new Float32Array(buf.length);
  const sums = new Float64Array(stride);
  // x ranges where the add / remove taps are clamped
  const xAdd = Math.max(0, Math.min(w, w - r - 1)); // x < xAdd: add tap x+r+1 inside
  const xRem = Math.min(w, r + 1); // x >= xRem: remove tap x-r inside (> 0)
  for (let p = 0; p < passes; p++) {
    // horizontal: buf → tmp
    for (let y = 0; y < h; y++) {
      const row = y * stride;
      for (let c = 0; c < ch; c++) {
        const b0 = row + c;
        const bl = b0 + (w - 1) * ch;
        const first = buf[b0],
          lastV = buf[bl];
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += k < 0 ? first : k >= w ? lastV : buf[b0 + k * ch];
        let o = b0;
        const xm = Math.min(xAdd, xRem);
        let x = 0;
        // left edge: removed tap clamps to the first pixel
        for (; x < xm; x++, o += ch) {
          tmp[o] = sum * inv;
          sum += buf[b0 + (x + r + 1) * ch] - first;
        }
        if (xAdd >= xRem) {
          // interior: both taps inside
          let ia = b0 + (x + r + 1) * ch,
            ir = b0 + (x - r) * ch;
          for (; x < xAdd; x++, o += ch, ia += ch, ir += ch) {
            tmp[o] = sum * inv;
            sum += buf[ia] - buf[ir];
          }
        } else {
          // narrow image: both taps clamped
          for (; x < xRem; x++, o += ch) {
            tmp[o] = sum * inv;
            sum += lastV - first;
          }
        }
        // right edge: added tap clamps to the last pixel
        for (; x < w; x++, o += ch) {
          tmp[o] = sum * inv;
          const rem = x - r;
          sum += lastV - (rem > 0 ? buf[b0 + rem * ch] : first);
        }
      }
    }
    // vertical: tmp → buf
    sums.fill(0);
    for (let k = -r; k <= r; k++) {
      const rk = (k < 0 ? 0 : k >= h ? h - 1 : k) * stride;
      for (let q = 0; q < stride; q++) sums[q] += tmp[rk + q];
    }
    for (let y = 0; y < h; y++) {
      const o = y * stride;
      const addRow = (y + r + 1 < h ? y + r + 1 : h - 1) * stride;
      const remRow = (y - r > 0 ? y - r : 0) * stride;
      for (let q = 0; q < stride; q++) {
        buf[o + q] = sums[q] * inv;
        sums[q] += tmp[addRow + q] - tmp[remRow + q];
      }
    }
  }
  return buf;
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
 * transparent edges). `sigma` in image px: exact gaussian for small radii, 3 box passes above.
 *
 * This (rather than core/blur's boxBlurImageData) backs Gaussian Blur and every blur-based
 * filter on purpose: it honours fractional radii (boxBlurImageData rounds to whole px and its
 * smallest blur is σ≈1.4), keeps float precision between passes (no 8-bit rounding → no banding
 * on smooth gradients or soft alpha edges), is premultiplied, and its vertical pass walks rows
 * instead of columns (cache friendly, ~2× faster at 1920×1080).
 */
export function blurImage<T extends Img>(img: T, sigma: number): T {
  if (!(sigma > 0.2)) return img;
  const { width: w, height: h } = img;
  const f = premultipliedFloats(img.data);
  if (sigma < 1.5) gaussSmallRGBA(f, w, h, sigma);
  else {
    const r = Math.max(1, Math.round((-1 + Math.sqrt(1 + 4 * sigma * sigma)) / 2));
    boxBlurInterleaved(f, w, h, 4, Math.min(r, Math.max(w, h)), 3);
  }
  unpremultiplyFloats(f, img.data);
  return img;
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
