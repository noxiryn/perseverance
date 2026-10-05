/**
 * Test-only reference: the creative-filter code paths exactly as they were before the
 * performance pass (commit f08283b), copied verbatim (helpers that did not change are imported
 * from the live modules). perf.test.ts checks the optimized filters against these on random
 * images. Not imported by the app.
 */
/* eslint-disable */
import type { FilterContext, FilterDef } from '../../registry';
import type { ParamValues } from '../../core/types';
import { Aperture, Binary, CircleDot, Film, Glasses, Layers2, Scissors, Sun } from 'lucide-react';
import type { BoxPass, Img, Planes } from './util';
import {
  anchor,
  autoEdge,
  bool,
  boundedDistance,
  boxForSigma,
  clamp,
  contrastFactor,
  edgeSeeds,
  hash,
  hashGauss,
  insideDistance,
  isEmpty,
  lumaPlane,
  mixWith,
  num,
  premultiplyInPlace,
  pt,
  rgb,
  saturateInPlace,
  sc,
  smoothstep,
  str,
  toPlanes,
} from './util';
import { edgeLuma, edgeThresholdValue, hasTransparency, type OutlineOptions } from './edges';
import { spotLUT, toneSigma, SPOT_SHAPES, type ScreenParams, type SpotShape } from './screen';
import { bandRepresentatives, quantizeSmooth, toneRange } from './defs/stylize';
import { fromOklab, kmeansPalette, toOklab } from './defs/artistic';
import { angleP, boolP, colorP, numP, pctP, pointP, pxP, seedP, selectP } from './params';


/* ---------------- util.ts (blur, sobel) ---------------- */

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

const MULTIRES_SIGMA = 6;

/**
 * Large-sigma blur of interleaved data in place at 1/f resolution (box downsample → extended box
 * blur → bilinear upsample), f ≈ σ/3. At that factor the gaussian has no energy left near the
 * low-resolution Nyquist frequency (no aliasing) and the result stays within ~1-2% (a few levels)
 * of the full-resolution blur at the sharpest blurred edge. The variance added by the resampling
 * (≈ f²/4) is taken off the low-resolution blur, so the overall sigma stays right; ~f² less work.
 */
function blurMultires(buf: Float32Array, w: number, h: number, ch: number, sigma: number) {
  const f = Math.max(2, Math.min(8, Math.floor(sigma / 3)));
  const w2 = Math.ceil(w / f),
    h2 = Math.ceil(h / f);
  const small = new Float32Array(w2 * h2 * ch);
  // box downsample (edge cells average the pixels they have)
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
  const sl = Math.sqrt(Math.max(0.09, sigma * sigma - (f * f) / 4)) / f;
  if (sl < 1 && ch === 1) gaussSmallPlane(small, w2, h2, sl);
  else if (sl < 1 && ch === 4) gaussSmallRGBA(small, w2, h2, sl);
  else boxBlurPasses(small, w2, h2, ch, boxPassesForSigma(sl));
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

/** Run a list of (extended) box passes over interleaved data in place (clamp-to-edge). */
export function boxBlurPasses(buf: Float32Array, w: number, h: number, ch: number, list: BoxPass[]): Float32Array {
  if (w < 1 || h < 1) return buf;
  const stride = w * ch;
  let tmp: Float32Array | null = null;
  let sums: Float64Array | null = null;
  for (const pass of list) {
    const r = Math.max(0, Math.floor(pass.r));
    const alpha = pass.alpha;
    const ext = alpha > 1e-6;
    if (r === 0 && !ext) continue;
    tmp ??= new Float32Array(buf.length);
    sums ??= new Float64Array(stride);
    const inv = 1 / (2 * r + 1 + (ext ? 2 * alpha : 0));
    // x ranges where the add / remove taps are clamped
    const xAdd = Math.max(0, Math.min(w, w - r - 1)); // x < xAdd: add tap x+r+1 inside
    const xRem = Math.min(w, r + 1); // x >= xRem: remove tap x-r inside (> 0)
    const xm = Math.min(xAdd, xRem);
    // horizontal: buf → tmp
    for (let y = 0; y < h; y++) {
      const row = y * stride;
      for (let c = 0; c < ch; c++) {
        const b0 = row + c;
        const first = buf[b0],
          lastV = buf[b0 + (w - 1) * ch];
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += k < 0 ? first : k >= w ? lastV : buf[b0 + k * ch];
        let o = b0;
        let x = 0;
        if (!ext) {
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
        } else {
          // same phases plus the fractional taps at x − r − 1 (the previous removed tap, kept in a
          // register) and x + r + 1 (the tap being added)
          let prevRem = first;
          for (; x < xm; x++, o += ch) {
            const add = buf[b0 + (x + r + 1) * ch];
            tmp[o] = (sum + alpha * (first + add)) * inv;
            sum += add - first;
          }
          if (xAdd >= xRem) {
            let ia = b0 + (x + r + 1) * ch,
              ir = b0 + (x - r) * ch;
            prevRem = x - r - 1 > 0 ? buf[ir - ch] : first;
            for (; x < xAdd; x++, o += ch, ia += ch, ir += ch) {
              const add = buf[ia],
                rem = buf[ir];
              tmp[o] = (sum + alpha * (prevRem + add)) * inv;
              sum += add - rem;
              prevRem = rem;
            }
          } else {
            for (; x < xRem; x++, o += ch) {
              tmp[o] = (sum + alpha * (first + lastV)) * inv;
              sum += lastV - first;
            }
          }
          for (; x < w; x++, o += ch) {
            const rem = x - r;
            const left = rem - 1 > 0 ? buf[b0 + (rem - 1) * ch] : first;
            tmp[o] = (sum + alpha * (left + lastV)) * inv;
            sum += lastV - (rem > 0 ? buf[b0 + rem * ch] : first);
          }
        }
      }
    }
    // vertical: tmp → buf, row by row (one running sum per column → sequential memory)
    sums.fill(0);
    for (let k = -r; k <= r; k++) {
      const rk = (k < 0 ? 0 : k >= h ? h - 1 : k) * stride;
      for (let q = 0; q < stride; q++) sums[q] += tmp[rk + q];
    }
    for (let y = 0; y < h; y++) {
      const o = y * stride;
      const addRow = (y + r + 1 < h ? y + r + 1 : h - 1) * stride;
      const remRow = (y - r > 0 ? y - r : 0) * stride;
      if (!ext) {
        for (let q = 0; q < stride; q++) {
          buf[o + q] = sums[q] * inv;
          sums[q] += tmp[addRow + q] - tmp[remRow + q];
        }
      } else {
        const upRow = (y - r - 1 > 0 ? y - r - 1 : 0) * stride;
        for (let q = 0; q < stride; q++) {
          const add = tmp[addRow + q];
          buf[o + q] = (sums[q] + alpha * (tmp[upRow + q] + add)) * inv;
          sums[q] += add - tmp[remRow + q];
        }
      }
    }
  }
  return buf;
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
  const f = premultipliedFloats(img.data);
  if (sigma < 1) gaussSmallRGBA(f, w, h, sigma);
  else if (sigma >= MULTIRES_SIGMA && w >= 16 && h >= 16) blurMultires(f, w, h, 4, sigma);
  else boxBlurPasses(f, w, h, 4, boxPassesForSigma(sigma));
  unpremultiplyFloats(f, img.data);
  return img;
}

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

export function blurPlanes(p: Planes, w: number, h: number, sigma: number) {
  blurPlane(p.r, w, h, sigma);
  blurPlane(p.g, w, h, sigma);
  blurPlane(p.b, w, h, sigma);
  blurPlane(p.a, w, h, sigma);
}

/* ---------------- ops.ts ---------------- */

/**
 * Gaussian-ish blur of a copy of a plane (σ in px). Big radii run at reduced resolution inside
 * blurPlane; `blur` is kept for callers that pass a custom small-radius blur.
 */
export function blurPlaneMultires(src: Float32Array, w: number, h: number, sigma: number, blur: (b: Float32Array, w: number, h: number, s: number) => void): Float32Array {
  const c = Float32Array.from(src);
  if (sigma >= 8) blurPlane(c, w, h, sigma);
  else blur(c, w, h, sigma);
  return c;
}

/* ---------------- edges.ts ---------------- */

/**
 * Edge seeds with hysteresis (weak edges connected to strong ones are kept) and removal of tiny
 * isolated fragments. Returns 0/1 mask.
 */
export function detectEdges(lum: Float32Array, w: number, h: number, threshold: number, minLength = 3): Uint8Array {
  const { gx, gy, mag } = sobel(lum, w, h);
  const strong = edgeThresholdValue(threshold);
  const weak = strong * 0.5;
  const cand = edgeSeeds(mag, gx, gy, w, h, weak);
  const out = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comp: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!cand[i] || visited[i] || mag[i] < strong) continue;
    // flood the connected candidate component starting from a strong pixel
    let sp = 0;
    stack[sp++] = i;
    visited[i] = 1;
    comp.length = 0;
    while (sp > 0) {
      const p = stack[--sp];
      comp.push(p);
      const px = p % w,
        py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (cand[q] && !visited[q]) {
            visited[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    if (comp.length >= minLength) for (const p of comp) out[p] = 1;
  }
  return out;
}

/** Anti-aliased outline coverage (0..1 per pixel). */
export function outlineCoverage(img: Img, o: OutlineOptions): Float32Array {
  const { width: w, height: h } = img;
  const n = w * h;
  const cov = new Float32Array(n);
  const T = Math.max(0, o.thickness);
  if (T <= 0.01) return cov;
  const lum = o.luma ? Float32Array.from(o.luma) : edgeLuma(img);
  blurPlane(lum, w, h, o.smooth ?? 1);
  const seeds = detectEdges(lum, w, h, o.threshold, o.minLength ?? 3);
  const half = T * 0.5;
  const dEdge = boundedDistance(seeds, w, h, half + 1);
  const faint = Math.min(1, T); // sub-pixel lines fade instead of thinning further
  for (let i = 0; i < n; i++) {
    const c = half + 0.5 - dEdge[i];
    if (c > 0) cov[i] = (c >= 1 ? 1 : c) * faint;
  }
  if (o.silhouette !== false && hasTransparency(img)) {
    const dIn = insideDistance(img, false, T + 1);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      if (d[i * 4 + 3] === 0) continue;
      const c = T + 0.5 - dIn[i];
      if (c > 0) {
        const v = (c >= 1 ? 1 : c) * faint;
        if (v > cov[i]) cov[i] = v;
      }
    }
  }
  return cov;
}

/* ---------------- median.ts ---------------- */

function median2D(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  const hist = new Int32Array(256);
  const n = (2 * r + 1) * (2 * r + 1);
  const half = n >> 1;
  const cx = (x: number) => (x < 0 ? 0 : x >= w ? w - 1 : x);
  const rowIdx = new Int32Array(2 * r + 1);
  for (let y = 0; y < h; y++) {
    hist.fill(0);
    for (let k = -r; k <= r; k++) {
      const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
      rowIdx[k + r] = yy * w;
    }
    for (let k = 0; k <= 2 * r; k++) {
      const ro = rowIdx[k];
      for (let dx = -r; dx <= r; dx++) hist[src[ro + cx(dx)]]++;
    }
    let med = 0,
      lt = 0;
    while (lt + hist[med] <= half) {
      lt += hist[med];
      med++;
    }
    dst[y * w] = med;
    for (let x = 1; x < w; x++) {
      const xo = cx(x - r - 1),
        xi = cx(x + r);
      for (let k = 0; k <= 2 * r; k++) {
        const ro = rowIdx[k];
        const vo = src[ro + xo];
        hist[vo]--;
        if (vo < med) lt--;
        const vi = src[ro + xi];
        hist[vi]++;
        if (vi < med) lt++;
      }
      while (lt > half) {
        med--;
        lt -= hist[med];
      }
      while (lt + hist[med] <= half) {
        lt += hist[med];
        med++;
      }
      dst[y * w + x] = med;
    }
  }
}

/** 1D sliding median along lines; `stride` = step between samples, lines start at `starts`. */
function median1D(src: Uint8Array, dst: Uint8Array, len: number, lines: number, lineStep: number, stride: number, r: number) {
  const hist = new Int32Array(256);
  const n = 2 * r + 1;
  const half = n >> 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    const at = (i: number) => src[base + (i < 0 ? 0 : i >= len ? len - 1 : i) * stride];
    hist.fill(0);
    for (let k = -r; k <= r; k++) hist[at(k)]++;
    let med = 0,
      lt = 0;
    while (lt + hist[med] <= half) {
      lt += hist[med];
      med++;
    }
    dst[base] = med;
    for (let i = 1; i < len; i++) {
      const vo = at(i - r - 1);
      hist[vo]--;
      if (vo < med) lt--;
      const vi = at(i + r);
      hist[vi]++;
      if (vi < med) lt++;
      while (lt > half) {
        med--;
        lt -= hist[med];
      }
      while (lt + hist[med] <= half) {
        lt += hist[med];
        med++;
      }
      dst[base + i * stride] = med;
    }
  }
}

/** Median of one 8-bit channel plane (`separable`: rows then columns, O(1) per pixel). */
export function medianChannel(src: Uint8Array, w: number, h: number, radius: number, separable = false): Uint8Array {
  const r = Math.max(0, Math.round(radius));
  const dst = new Uint8Array(src.length);
  if (r === 0) {
    dst.set(src);
    return dst;
  }
  if (r <= 6 && !separable) {
    median2D(src, dst, w, h, r);
    return dst;
  }
  const tmp = new Uint8Array(src.length);
  median1D(src, tmp, w, h, w, 1, r); // rows
  median1D(tmp, dst, h, w, 1, w, r); // columns
  return dst;
}

/**
 * Median filter of an RGBA image in place (premultiplied so transparent edges stay clean).
 * `separable` trades the exact square-window median for a ~3× faster rows-then-columns median
 * (still edge preserving) — used where the median is only a simplification pre-pass.
 */
export function medianImage<T extends Img>(img: T, radius: number, preserveAlpha = true, separable = false): T {
  const r = Math.round(radius);
  if (r < 1) return img;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const alpha = preserveAlpha ? new Uint8Array(n) : null;
  const orig = new Uint8ClampedArray(data);
  premultiplyInPlace(data);
  const ch = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    ch[0][i] = data[j];
    ch[1][i] = data[j + 1];
    ch[2][i] = data[j + 2];
    ch[3][i] = data[j + 3];
    if (alpha) alpha[i] = data[j + 3];
  }
  // constant planes (e.g. the alpha of an opaque image) are their own median
  const out = ch.map((c) => {
    const v0 = c[0];
    let flat = true;
    for (let i = 1; i < n; i++)
      if (c[i] !== v0) {
        flat = false;
        break;
      }
    return flat ? c : medianChannel(c, w, h, r, separable);
  });
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = out[3][i];
    if (a === 0) {
      data[j] = orig[j];
      data[j + 1] = orig[j + 1];
      data[j + 2] = orig[j + 2];
      data[j + 3] = alpha ? alpha[i] : 0;
      continue;
    }
    // un-premultiply with the median alpha, then restore the original coverage
    const m = 255 / a;
    data[j] = Math.min(255, out[0][i] * m);
    data[j + 1] = Math.min(255, out[1][i] * m);
    data[j + 2] = Math.min(255, out[2][i] * m);
    data[j + 3] = alpha ? alpha[i] : a;
  }
  return img;
}

/* ---------------- screen.ts ---------------- */

const LUT_N = 1024;

/** Spot metric m(fu, fv) for fu, fv ∈ [-0.5, 0.5): ink where m < t. */
function metric(id: number, fu: number, fv: number): number {
  const au = fu < 0 ? -fu : fu,
    av = fv < 0 ? -fv : fv;
  switch (id) {
    case 0:
      return Math.sqrt(fu * fu + fv * fv);
    case 1:
      return av;
    case 2:
      return au > av ? au : av;
    case 3: {
      const mn = au < av ? au : av,
        mx = au > av ? au : av;
      const k = mn * 2.2;
      return k > mx ? k : mx;
    }
    case 4:
      return au + av;
    default:
      return Math.sqrt(fu * fu * 0.64 + fv * fv * 1.5625);
  }
}

/**
 * Screen a darkness plane (0..1, already blurred to roughly the cell size) into ink coverage.
 * `extras` planes are sampled at the same cell centers into `extrasOut` (for per-cell colors).
 */
export function screenPlane(
  dark: Float32Array,
  w: number,
  h: number,
  p: ScreenParams,
  out: Float32Array,
  extras?: Float32Array[],
  extrasOut?: Float32Array[],
) {
  const S = Math.max(0.75, p.cell);
  const spot = spotLUT(p.shape);
  const { lut, tMax, g } = spot;
  const id = spot.id;
  const th = (p.angle * Math.PI) / 180;
  const cs = Math.cos(th),
    sn = Math.sin(th);
  const k = p.contrast ?? 1;
  const invS = 1 / S;
  const aaScale = S / g;
  const ne = extras?.length ?? 0;
  // per-cell values are computed once per cell run (cell indices change every ~S px along a row)
  let lastU = 0x7fffffff,
    lastV = 0x7fffffff;
  let cellC = 0,
    cellT = 0,
    cellLo = 1,
    cellHi = 1;
  const cellX = new Float32Array(Math.max(1, ne));
  for (let y = 0; y < h; y++) {
    const gy = y + 0.5 + p.ay;
    const o0 = y * w;
    for (let x = 0; x < w; x++) {
      const gx = x + 0.5 + p.ax;
      const u = (gx * cs + gy * sn) * invS;
      const v = (-gx * sn + gy * cs) * invS;
      const iu = Math.floor(u),
        iv = Math.floor(v);
      const o = o0 + x;
      if (iu !== lastU || iv !== lastV) {
        lastU = iu;
        lastV = iv;
        // cell center back to image space, bilinear tone lookup
        const uc = (iu + 0.5) * S,
          vc = (iv + 0.5) * S;
        let ix = uc * cs - vc * sn - p.ax - 0.5;
        let iy = uc * sn + vc * cs - p.ay - 0.5;
        if (ix < 0) ix = 0;
        else if (ix > w - 1) ix = w - 1;
        if (iy < 0) iy = 0;
        else if (iy > h - 1) iy = h - 1;
        const x0 = ix | 0,
          y0 = iy | 0;
        const x1 = x0 < w - 1 ? x0 + 1 : x0,
          y1 = y0 < h - 1 ? y0 + 1 : y0;
        const tx = ix - x0,
          ty = iy - y0;
        const i00 = y0 * w + x0,
          i10 = y0 * w + x1,
          i01 = y1 * w + x0,
          i11 = y1 * w + x1;
        const w00 = (1 - tx) * (1 - ty),
          w10 = tx * (1 - ty),
          w01 = (1 - tx) * ty,
          w11 = tx * ty;
        let c = dark[i00] * w00 + dark[i10] * w10 + dark[i01] * w01 + dark[i11] * w11;
        if (k !== 1) c = (c - 0.5) * k + 0.5;
        cellC = c < 0 ? 0 : c > 1 ? 1 : c;
        for (let e = 0; e < ne; e++) {
          const pl = extras![e];
          cellX[e] = pl[i00] * w00 + pl[i10] * w10 + pl[i01] * w01 + pl[i11] * w11;
        }
        if (cellC > 0.0005 && cellC < 0.9995) {
          cellT = lut[(cellC * LUT_N + 0.5) | 0];
          // fade spots smaller than a pixel instead of leaving 50% specks (and the same for holes)
          cellLo = cellT * aaScale * 2;
          cellHi = (tMax - cellT) * aaScale * 2;
        }
      }
      for (let e = 0; e < ne; e++) extrasOut![e][o] = cellX[e];
      if (cellC <= 0.0005) {
        out[o] = 0;
        continue;
      }
      if (cellC >= 0.9995) {
        out[o] = 1;
        continue;
      }
      const m = metric(id, u - iu - 0.5, v - iv - 0.5);
      let a = (cellT - m) * aaScale + 0.5;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      if (cellLo < 1) a *= cellLo;
      if (cellHi < 1) a = 1 - (1 - a) * cellHi;
      out[o] = a;
    }
  }
}

/* ---------------- defs/noise.ts ---------------- */

export const addNoise: FilterDef = {
  id: 'add-noise',
  name: 'Add Noise',
  category: 'Noise & Grain',
  icon: Binary,
  description: 'Per-pixel random noise (gaussian or uniform), monochrome or colored.',
  keywords: ['grain', 'static', 'dither', 'texture'],
  params: [
    numP('amount', 'Amount', 0, 100, 10, { unit: '%', step: 0.5 }),
    selectP('distribution', 'Distribution', [['gaussian', 'Gaussian'], ['uniform', 'Uniform']], 'gaussian'),
    boolP('monochrome', 'Monochromatic', true),
    seedP(1),
  ],
  apply(img, p, ctx) {
    const amt = clamp(num(p.amount, 10), 0, 100) / 100;
    if (amt <= 0 || isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const { ax, ay, s } = anchor(ctx);
    const mono = bool(p.monochrome, true);
    const gauss = str(p.distribution, 'gaussian') !== 'uniform';
    const seed = num(p.seed, 1) | 0;
    const k = amt * (gauss ? 110 : 255);
    // noise is defined per DOCUMENT pixel so previews at other scales look the same
    const inv = 1 / s;
    for (let y = 0; y < h; y++) {
      const Y = Math.floor((y + 0.5 + ay) * inv);
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const X = Math.floor((x + 0.5 + ax) * inv);
        if (mono) {
          const v = (gauss ? hashGauss(X, Y, seed) : hash(X, Y, seed) - 0.5) * k;
          data[j] += v;
          data[j + 1] += v;
          data[j + 2] += v;
        } else {
          data[j] += (gauss ? hashGauss(X, Y, seed) : hash(X, Y, seed) - 0.5) * k;
          data[j + 1] += (gauss ? hashGauss(X, Y, seed + 101) : hash(X, Y, seed + 101) - 0.5) * k;
          data[j + 2] += (gauss ? hashGauss(X, Y, seed + 202) : hash(X, Y, seed + 202) - 0.5) * k;
        }
      }
    }
    return img;
  },
};

/** Smooth gaussian-valued noise: bilinear interpolation of per-cell gaussian hashes. */
function grainNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const tx = x - xi,
    ty = y - yi;
  const a = hashGauss(xi, yi, seed),
    b = hashGauss(xi + 1, yi, seed),
    c = hashGauss(xi, yi + 1, seed),
    d = hashGauss(xi + 1, yi + 1, seed);
  const r0 = a + (b - a) * tx,
    r1 = c + (d - c) * tx;
  return r0 + (r1 - r0) * ty;
}

export const filmGrain: FilterDef = {
  id: 'film-grain',
  name: 'Film Grain',
  category: 'Noise & Grain',
  icon: Film,
  description: 'Organic photographic grain: clumpy, strongest in the midtones.',
  keywords: ['grain', 'analog', 'film', 'noise', 'texture', 'cinematic'],
  params: [pctP('amount', 'Amount', 0.35), pxP('size', 'Grain size', 0.5, 8, 1.5, { step: 0.1 }), pctP('color', 'Color grain', 0), pctP('shadows', 'Shadow grain', 0.5), seedP(1)],
  apply(img, p, ctx) {
    const amt = clamp(num(p.amount, 0.35), 0, 1);
    if (amt <= 0 || isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const { ax, ay, s } = anchor(ctx);
    const size = Math.max(0.35, num(p.size, 1.5));
    const colorAmt = clamp(num(p.color, 0), 0, 1);
    const shadows = clamp(num(p.shadows, 0.5), 0, 1);
    const seed = num(p.seed, 1) | 0;
    // grain coordinates in document px / size; at small preview scales fade fine grain (it would
    // alias into a different, harsher texture)
    const f = 1 / (s * size);
    const visible = Math.min(1, s * size * 1.6);
    const k = amt * 70 * (0.35 + 0.65 * visible);
    for (let y = 0; y < h; y++) {
      const Y = (y + 0.5 + ay) * f;
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (data[j + 3] === 0) continue;
        const X = (x + 0.5 + ax) * f;
        const g = grainNoise(X, Y, seed) * 0.7 + grainNoise(X * 2.1 + 17.3, Y * 2.1 - 9.1, seed + 7) * 0.45;
        const l = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255;
        // response: strongest in the midtones, configurable in shadows, weak in highlights
        const resp = l < 0.5 ? shadows + (1 - shadows) * (l * 2) : 1 - (l - 0.5) * 1.4;
        const v = g * k * Math.max(0.05, resp);
        if (colorAmt > 0) {
          const cr = grainNoise(X + 31.7, Y + 11.3, seed + 13) * colorAmt;
          const cb = grainNoise(X - 21.1, Y + 41.9, seed + 29) * colorAmt;
          data[j] += v * (1 + cr);
          data[j + 1] += v * (1 - (cr + cb) * 0.5);
          data[j + 2] += v * (1 + cb);
        } else {
          data[j] += v;
          data[j + 1] += v;
          data[j + 2] += v;
        }
      }
    }
    return img;
  },
};

/* ---------------- defs/retro.ts ---------------- */

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

/* ---------------- defs/light.ts ---------------- */

const blurFn = (b: Float32Array, w: number, h: number, s: number) => void blurPlane(b, w, h, s);

interface VignetteShape {
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
    const cx = c.x * ctx.docWidth,
      cy = c.y * ctx.docHeight;
    const P = vignettePrep({
      docW: ctx.docWidth,
      docH: ctx.docHeight,
      cx,
      cy,
      size: num(p.size, 0.6),
      roundness: num(p.roundness, 0),
      feather: num(p.feather, 0.5),
    });
    const inv = 1 / s;
    // u per column is the same for every row
    const U = new Float32Array(w);
    for (let x = 0; x < w; x++) U[x] = Math.abs(ctx.offsetX + (x + 0.5) * inv - cx) * P.irx;
    for (let y = 0; y < h; y++) {
      const v = Math.abs(ctx.offsetY + (y + 0.5) * inv - cy) * P.iry;
      let j = y * w * 4;
      for (let x = 0; x < w; x++, j += 4) {
        if (data[j + 3] === 0) continue;
        const t = vignetteEval(U[x], v, P) * amount;
        if (t <= 0.0005) continue;
        data[j] += (col[0] - data[j]) * t;
        data[j + 1] += (col[1] - data[j + 1]) * t;
        data[j + 2] += (col[2] - data[j + 2]) * t;
      }
    }
    return img;
  },
};

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

/* ---------------- defs/comic.ts ---------------- */

/** Straight (un-premultiplied) blurred color planes 0..255 + alpha 0..1. */
function blurredColor(img: Img, sigma: number) {
  const { width: w, height: h } = img;
  const p = toPlanes(img, true);
  blurPlanes(p, w, h, sigma);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const a = p.a[i];
    if (a > 1e-4) {
      const m = 255 / a;
      p.r[i] *= m;
      p.g[i] *= m;
      p.b[i] *= m;
    } else {
      p.r[i] = p.g[i] = p.b[i] = 255;
    }
  }
  return p;
}

/**
 * Darkness plane (1 − luma of the blurred straight color; transparent areas count as paper) from
 * just two blurred planes — premultiplied luma and alpha — instead of four (mono screens).
 */
function blurredDarkness(img: Img, sigma: number): Float32Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const L = new Float32Array(n),
    A = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = data[j + 3] / 255;
    A[i] = a;
    L[i] = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) * (a / 255);
  }
  blurPlane(L, w, h, sigma);
  blurPlane(A, w, h, sigma);
  for (let i = 0; i < n; i++) {
    const a = A[i];
    L[i] = a > 1e-4 ? 1 - Math.min(1, L[i] / a) : 0;
  }
  return L;
}

const PROCESS = {
  c: [0, 158, 224],
  m: [228, 0, 124],
  y: [255, 237, 0],
};

function applyHalftone<T extends Img>(img: T, p: ParamValues, ctx: FilterContext): T {
  if (isEmpty(img)) return img;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const { ax, ay, s } = anchor(ctx);
  const S = Math.max(1, num(p.size, 8) * s);
  const angle = num(p.angle, 45);
  const shape = str(p.shape, 'dot') as SpotShape;
  const k = contrastFactor(num(p.contrast, 0));
  const mode = str(p.mode, 'mono');
  const ink = rgb(p.ink, '#111111');
  const paper = rgb(p.paper, '#f5f1e8');
  const transparent = bool(p.transparentPaper, false);
  const mix = clamp(num(p.mix, 1), 0, 1);
  const orig = mix < 0.999 ? new Uint8ClampedArray(data) : null;
  const screen = { cell: S, angle, shape, ax, ay, contrast: k };
  // mono only needs the tone: blur luma + alpha (2 planes) instead of the 4 color planes
  const col = mode === 'mono' ? null : blurredColor(img, toneSigma(S));

  if (mode === 'cmyk' && col) {
    const C = new Float32Array(n),
      M = new Float32Array(n),
      Y = new Float32Array(n),
      K = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = col.r[i] / 255,
        g = col.g[i] / 255,
        b = col.b[i] / 255;
      const kk = 1 - Math.max(r, g, b);
      K[i] = kk;
      if (kk < 0.999) {
        const inv = 1 / (1 - kk);
        C[i] = (1 - r - kk) * inv;
        M[i] = (1 - g - kk) * inv;
        Y[i] = (1 - b - kk) * inv;
      }
    }
    const cc = new Float32Array(n),
      cm = new Float32Array(n),
      cy = new Float32Array(n),
      ck = new Float32Array(n);
    screenPlane(C, w, h, { ...screen, angle: angle - 30 }, cc);
    screenPlane(M, w, h, { ...screen, angle: angle + 30 }, cm);
    screenPlane(Y, w, h, { ...screen, angle: angle - 45 }, cy);
    screenPlane(K, w, h, screen, ck);
    const fC = PROCESS.c.map((v) => 1 - v / 255),
      fM = PROCESS.m.map((v) => 1 - v / 255),
      fY = PROCESS.y.map((v) => 1 - v / 255),
      fK = ink.map((v) => 1 - v / 255);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3];
      if (a === 0) continue;
      const vc = cc[i],
        vm = cm[i],
        vy = cy[i],
        vk = ck[i];
      if (transparent) {
        const A = 1 - (1 - vc) * (1 - vm) * (1 - vy) * (1 - vk);
        if (A < 0.002) {
          data[j + 3] = 0;
          continue;
        }
        for (let ch = 0; ch < 3; ch++) {
          const over = 255 * (1 - vc * fC[ch]) * (1 - vm * fM[ch]) * (1 - vy * fY[ch]) * (1 - vk * fK[ch]);
          data[j + ch] = 255 - (255 - over) / A;
        }
        data[j + 3] = a * A;
      } else {
        for (let ch = 0; ch < 3; ch++)
          data[j + ch] = paper[ch] * (1 - vc * fC[ch]) * (1 - vm * fM[ch]) * (1 - vy * fY[ch]) * (1 - vk * fK[ch]);
      }
    }
  } else if (mode === 'color' && col) {
    const P = paper.map((v) => Math.max(1, v));
    const cov = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = Math.max((P[0] - col.r[i]) / P[0], (P[1] - col.g[i]) / P[1], (P[2] - col.b[i]) / P[2]);
      cov[i] = c < 0 ? 0 : c > 1 ? 1 : c;
    }
    const out = new Float32Array(n);
    const cr = new Float32Array(n),
      cg = new Float32Array(n),
      cb = new Float32Array(n);
    screenPlane(cov, w, h, screen, out, [col.r, col.g, col.b], [cr, cg, cb]);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3];
      if (a === 0) continue;
      const v = out[i];
      // ink color = the cell color pushed to full strength (paper + ink·cov averages to the cell color)
      let c = Math.max((P[0] - cr[i]) / P[0], (P[1] - cg[i]) / P[1], (P[2] - cb[i]) / P[2]);
      c = c < 0.02 ? 0.02 : c > 1 ? 1 : c;
      const ir = P[0] - (P[0] - cr[i]) / c,
        ig = P[1] - (P[1] - cg[i]) / c,
        ib = P[2] - (P[2] - cb[i]) / c;
      if (transparent) {
        data[j] = ir;
        data[j + 1] = ig;
        data[j + 2] = ib;
        data[j + 3] = a * v;
      } else {
        data[j] = paper[0] + (ir - paper[0]) * v;
        data[j + 1] = paper[1] + (ig - paper[1]) * v;
        data[j + 2] = paper[2] + (ib - paper[2]) * v;
      }
    }
  } else {
    const dark = blurredDarkness(img, toneSigma(S));
    const out = new Float32Array(n);
    screenPlane(dark, w, h, screen, out);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3];
      if (a === 0) continue;
      const v = out[i];
      if (transparent) {
        data[j] = ink[0];
        data[j + 1] = ink[1];
        data[j + 2] = ink[2];
        data[j + 3] = a * v;
      } else {
        data[j] = paper[0] + (ink[0] - paper[0]) * v;
        data[j + 1] = paper[1] + (ink[1] - paper[1]) * v;
        data[j + 2] = paper[2] + (ink[2] - paper[2]) * v;
      }
    }
  }
  if (orig) mixWith(orig, data, mix);
  return img;
}

export const halftone: FilterDef = {
  id: 'halftone',
  name: 'Halftone',
  category: 'Comic & Print',
  icon: CircleDot,
  description: 'Rotated print screen: dot size follows the tone. Mono ink, spot color or CMYK separations.',
  keywords: ['dots', 'comic', 'screen', 'print', 'cmyk', 'pop art', 'manga'],
  params: [
    selectP('mode', 'Mode', [['mono', 'Mono (ink on paper)'], ['color', 'Color'], ['cmyk', 'CMYK']], 'mono'),
    selectP('shape', 'Shape', SPOT_SHAPES, 'dot'),
    pxP('size', 'Size', 2, 80, 8),
    angleP('angle', 'Angle', 45),
    numP('contrast', 'Contrast', -100, 100, 0),
    colorP('ink', 'Ink', '#111111', { showIf: (v) => v.mode !== 'color' }),
    colorP('paper', 'Paper', '#f5f1e8'),
    boolP('transparentPaper', 'Transparent paper', false),
    pctP('mix', 'Mix', 1),
  ],
  apply: applyHalftone,
};

/* ---------------- defs/stylize.ts ---------------- */

/** Re-light a color to luminance Lq (0..1) keeping hue: darken by ratio, lighten towards white. */
function relight(d: Uint8ClampedArray, j: number, L0: number, Lq: number) {
  if (Lq < L0) {
    const k = Lq / Math.max(L0, 1e-4);
    d[j] *= k;
    d[j + 1] *= k;
    d[j + 2] *= k;
  } else if (Lq > L0) {
    const k = (Lq - L0) / Math.max(1 - L0, 1e-4);
    d[j] += (255 - d[j]) * k;
    d[j + 1] += (255 - d[j + 1]) * k;
    d[j + 2] += (255 - d[j + 2]) * k;
  }
}

export function applyCelShade<T extends Img>(img: T, p: ParamValues, ctx: FilterContext): T {
  if (isEmpty(img)) return img;
  const { width: w, height: h, data } = img;
  const s = sc(ctx);
  const levels = clamp(Math.round(num(p.levels, 4)), 2, 8);
  const smooth = clamp(num(p.smoothness, 0.2), 0, 1);
  const outline = bool(p.outline, true);
  const thick = num(p.outlineThickness, 2) * s;
  const oc = rgb(p.outlineColor, '#000000');
  const thr = clamp(num(p.edgeThreshold, 0.35), 0, 1);
  const sat = 1 + num(p.saturation, 10) / 100;
  const lum0 = lumaPlane(img);
  // outline is detected on the source before re-lighting
  const cov = outline && thick > 0 ? outlineCoverage(img, { thickness: thick, threshold: thr, smooth: Math.max(0.8, 1.1 * s), minLength: Math.max(3, Math.round(6 * s)) }) : null;
  const lumS = Float32Array.from(lum0);
  blurPlane(lumS, w, h, Math.max(0.5, 0.9 * s));
  const n = w * h;
  const { lo, hi } = toneRange(lumS, data);
  const reps = bandRepresentatives(lumS, data, levels, lo, hi);
  const invSpan = 1 / (hi - lo);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (data[j + 3] === 0) continue;
    const t = (lumS[i] - lo) * invSpan;
    const Lq = quantizeSmooth(t < 0 ? 0 : t > 1 ? 1 : t, levels, smooth, reps);
    relight(data, j, lum0[i], Lq);
  }
  saturateInPlace(data, sat);
  if (cov) {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = cov[i];
      if (v <= 0 || data[j + 3] === 0) continue;
      data[j] += (oc[0] - data[j]) * v;
      data[j + 1] += (oc[1] - data[j + 1]) * v;
      data[j + 2] += (oc[2] - data[j + 2]) * v;
    }
  }
  return img;
}

export const celShade: FilterDef = {
  id: 'cel-shade',
  name: 'Cel Shade',
  category: 'Stylize',
  icon: Layers2,
  description: 'Toon shading: flat luminance bands that keep each color’s hue, plus clean ink outlines.',
  keywords: ['toon', 'anime', 'cartoon', 'posterize', 'outline', 'roblox', 'flat shading'],
  params: [
    numP('levels', 'Tone levels', 2, 8, 4, { step: 1 }),
    pctP('smoothness', 'Smoothness', 0.2),
    numP('saturation', 'Saturation', -100, 100, 10),
    boolP('outline', 'Outline', true, { group: 'Outline' }),
    pxP('outlineThickness', 'Thickness', 0, 10, 2, { group: 'Outline', showIf: (v) => v.outline !== false }),
    colorP('outlineColor', 'Color', '#000000', { group: 'Outline', showIf: (v) => v.outline !== false }),
    pctP('edgeThreshold', 'Edge threshold', 0.35, { group: 'Outline', showIf: (v) => v.outline !== false }),
  ],
  apply: applyCelShade,
};

/* ---------------- defs/artistic.ts ---------------- */

/**
 * Cut-paper quantization: pixels are grouped into K color families (k-means weighted towards
 * hue/chroma), then each family is split into T flat lightness tones (1-D k-means on OKLab L),
 * so every material keeps its own light/mid/dark shades like a hand-cut poster.
 * Returns per-pixel labels (family·T + tone, 255 = transparent) and the label palette in OKLab.
 */
export function cutoutQuantize(lab: Float32Array, alpha: Uint8ClampedArray | null, n: number, K: number, T: number): { lbl: Uint8Array; pal: Float32Array; count: number } {
  const cent = kmeansPalette(lab, alpha, n, K, 10, 0.45);
  const group = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (alpha && alpha[i * 4 + 3] === 0) {
      group[i] = 255;
      continue;
    }
    const L = lab[i * 3],
      A = lab[i * 3 + 1],
      B = lab[i * 3 + 2];
    let bc = 0,
      bd = Infinity;
    for (let c = 0; c < K; c++) {
      const dl = (L - cent[c * 3]) * 0.45,
        da = A - cent[c * 3 + 1],
        db = B - cent[c * 3 + 2];
      const d = dl * dl + da * da + db * db;
      if (d < bd) {
        bd = d;
        bc = c;
      }
    }
    group[i] = bc;
  }
  // tone centers per family (1-D k-means on lightness, quantile-initialized)
  const tones = new Float32Array(K * T);
  const step = Math.max(1, Math.floor(n / 60000));
  const samples: number[][] = Array.from({ length: K }, () => []);
  for (let i = 0; i < n; i += step) if (group[i] !== 255) samples[group[i]].push(lab[i * 3]);
  for (let c = 0; c < K; c++) {
    const v = Float32Array.from(samples[c]).sort();
    const m = v.length;
    for (let t = 0; t < T; t++) tones[c * T + t] = m ? v[Math.min(m - 1, Math.floor(((t + 0.5) / T) * m))] : cent[c * 3];
    if (m < 2 || T < 2) continue;
    const sum = new Float64Array(T),
      cnt = new Float64Array(T);
    for (let it = 0; it < 8; it++) {
      sum.fill(0);
      cnt.fill(0);
      for (let q = 0; q < m; q++) {
        const L = v[q];
        let bt = 0,
          bd = Infinity;
        for (let t = 0; t < T; t++) {
          const d = Math.abs(L - tones[c * T + t]);
          if (d < bd) {
            bd = d;
            bt = t;
          }
        }
        sum[bt] += L;
        cnt[bt]++;
      }
      for (let t = 0; t < T; t++) if (cnt[t]) tones[c * T + t] = sum[t] / cnt[t];
    }
  }
  const count = K * T;
  const lbl = new Uint8Array(n);
  const acc = new Float64Array(count * 4);
  for (let i = 0; i < n; i++) {
    const c = group[i];
    if (c === 255) {
      lbl[i] = 255;
      continue;
    }
    const L = lab[i * 3];
    let bt = 0,
      bd = Infinity;
    for (let t = 0; t < T; t++) {
      const d = Math.abs(L - tones[c * T + t]);
      if (d < bd) {
        bd = d;
        bt = t;
      }
    }
    const k = c * T + bt;
    lbl[i] = k;
    acc[k * 4] += L;
    acc[k * 4 + 1] += lab[i * 3 + 1];
    acc[k * 4 + 2] += lab[i * 3 + 2];
    acc[k * 4 + 3]++;
  }
  const pal = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    const cn = acc[k * 4 + 3];
    const c = Math.floor(k / T);
    pal[k * 3] = cn ? acc[k * 4] / cn : tones[k];
    pal[k * 3 + 1] = cn ? acc[k * 4 + 1] / cn : cent[c * 3 + 1];
    pal[k * 3 + 2] = cn ? acc[k * 4 + 2] / cn : cent[c * 3 + 2];
  }
  return { lbl, pal, count };
}

/** 3×3 majority (mode) filter on a label map, ignoring pixels marked 255 (transparent). */
function modeFilter(lbl: Uint8Array, w: number, h: number, K: number): Uint8Array {
  const out = new Uint8Array(lbl);
  const cnt = new Uint8Array(Math.max(K, 1));
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const c0 = lbl[i];
      if (c0 === 255) continue;
      const up = i - w,
        dn = i + w;
      // flat interior (the common case): nothing to vote on
      if (
        lbl[i - 1] === c0 &&
        lbl[i + 1] === c0 &&
        lbl[up] === c0 &&
        lbl[dn] === c0 &&
        lbl[up - 1] === c0 &&
        lbl[up + 1] === c0 &&
        lbl[dn - 1] === c0 &&
        lbl[dn + 1] === c0
      )
        continue;
      let bestC = c0,
        bestN = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const c = lbl[i + dy * w + dx];
          if (c === 255) continue;
          const v = ++cnt[c] + (c === c0 ? 0.5 : 0);
          if (v > bestN) {
            bestN = v;
            bestC = c;
          }
        }
      // reset only the touched counters
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const c = lbl[i + dy * w + dx];
          if (c !== 255) cnt[c] = 0;
        }
      out[i] = bestC;
    }
  }
  return out;
}

export const cutout: FilterDef = {
  id: 'cutout',
  name: 'Cutout',
  category: 'Artistic',
  icon: Scissors,
  description: 'Flat cut-paper color regions: simplified shapes with a few flat tones (great on Roblox renders).',
  keywords: ['posterize', 'flat', 'vector', 'paper cut', 'cel', 'simplify', 'poster'],
  params: [
    numP('colors', 'Colors', 2, 16, 8, { step: 1, hint: 'Number of color families (materials)' }),
    numP('tones', 'Tones per color', 1, 5, 3, { step: 1, hint: 'Flat light/mid/dark shades kept inside each color family' }),
    pxP('simplicity', 'Simplicity', 0, 12, 3, { step: 1 }),
    pctP('fidelity', 'Edge fidelity', 0.6),
    numP('saturation', 'Saturation', -100, 100, 0, { step: 1 }),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const s = ctx.scale > 0 ? ctx.scale : 1;
    const K = clamp(Math.round(num(p.colors, 8)), 2, 16);
    const T = clamp(Math.round(num(p.tones, 3)), 1, 5);
    const simp = Math.max(0, num(p.simplicity, 3)) * s;
    const fid = clamp(num(p.fidelity, 0.6), 0, 1);
    const work = { data: new Uint8ClampedArray(data), width: w, height: h };
    // simplification pre-pass: the separable median is plenty here (quantization + mode filter follow)
    if (simp >= 0.75) medianImage(work, simp, true, true);
    const wd = work.data;
    const lab = new Float32Array(n * 3);
    for (let i = 0, j = 0; i < n; i++, j += 4) toOklab(wd[j], wd[j + 1], wd[j + 2], lab, i * 3);
    const q = cutoutQuantize(lab, data, n, K, T);
    let lbl = q.lbl;
    // smooth region outlines (fewer jaggies/specks at lower fidelity)
    const passes = Math.round((1 - fid) * 4 * Math.max(0.5, s)) + (simp > 0 ? 1 : 0);
    for (let k = 0; k < passes; k++) lbl = modeFilter(lbl, w, h, q.count);
    const NC = q.count;
    const pal = new Float32Array(NC * 3);
    for (let c = 0; c < NC; c++) {
      const [r, g, b] = fromOklab(q.pal[c * 3], q.pal[c * 3 + 1], q.pal[c * 3 + 2]);
      pal[c * 3] = r;
      pal[c * 3 + 1] = g;
      pal[c * 3 + 2] = b;
    }
    const satK = 1 + num(p.saturation, 0) / 100;
    if (Math.abs(satK - 1) > 1e-3) {
      for (let c = 0; c < NC; c++) {
        const l = pal[c * 3] * 0.2126 + pal[c * 3 + 1] * 0.7152 + pal[c * 3 + 2] * 0.0722;
        for (let ch = 0; ch < 3; ch++) pal[c * 3 + ch] = clamp(l + (pal[c * 3 + ch] - l) * satK, 0, 255);
      }
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const c = lbl[i];
      if (c === 255) continue;
      data[j] = pal[c * 3];
      data[j + 1] = pal[c * 3 + 1];
      data[j + 2] = pal[c * 3 + 2];
    }
    // anti-alias region boundaries: average with neighbours only where labels change
    const src = new Uint8ClampedArray(data);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = lbl[i];
        if (c === 255) continue;
        const l = x > 0 ? lbl[i - 1] : c,
          r = x < w - 1 ? lbl[i + 1] : c,
          u = y > 0 ? lbl[i - w] : c,
          d = y < h - 1 ? lbl[i + w] : c;
        if ((l === c || l === 255) && (r === c || r === 255) && (u === c || u === 255) && (d === c || d === 255)) continue;
        const j = i * 4;
        let sr = src[j] * 2,
          sg = src[j + 1] * 2,
          sb = src[j + 2] * 2,
          cnt = 2;
        const add = (k: number, lab2: number) => {
          if (lab2 === 255) return;
          sr += src[k];
          sg += src[k + 1];
          sb += src[k + 2];
          cnt++;
        };
        if (x > 0) add(j - 4, l);
        if (x < w - 1) add(j + 4, r);
        if (y > 0) add(j - w * 4, u);
        if (y < h - 1) add(j + w * 4, d);
        data[j] = sr / cnt;
        data[j + 1] = sg / cnt;
        data[j + 2] = sb / cnt;
      }
    }
    return img;
  },
};
