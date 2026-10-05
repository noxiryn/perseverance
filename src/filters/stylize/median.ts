/**
 * Fast median filters on 8-bit channels.
 *  - radius ≤ 6: true 2D square-window median (Huang's sliding histogram, O(r) per pixel).
 *  - larger radii: separable median (horizontal then vertical sliding histograms, O(1) per pixel)
 *    which keeps edges crisp at a fraction of the cost.
 */
import type { Img } from './util';
import { premultiplyInPlace } from './util';

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

/**
 * Sliding median along every row (clamp-to-edge), Huang's histogram: O(1) updates per step and a
 * short walk of the median pointer. Columns are filtered as rows of the transposed plane, so
 * every pass reads memory sequentially.
 */
function medianRows(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  const hist = new Int32Array(256);
  const n = 2 * r + 1;
  const half = n >> 1;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    const last = base + w - 1;
    hist.fill(0);
    for (let k = -r; k <= r; k++) {
      const q = base + k;
      hist[src[q < base ? base : q > last ? last : q]]++;
    }
    let med = 0,
      lt = 0;
    while (lt + hist[med] <= half) {
      lt += hist[med];
      med++;
    }
    dst[base] = med;
    for (let i = 1; i < w; i++) {
      const qo = base + i - r - 1,
        qi = base + i + r;
      const vo = src[qo < base ? base : qo];
      hist[vo]--;
      if (vo < med) lt--;
      const vi = src[qi > last ? last : qi];
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
      dst[base + i] = med;
    }
  }
}

/*
 * Median networks for 3/5/7 taps (full sorting network for 3, Devillard's opt_med5 / opt_med7
 * compare-exchange sequences for 5 / 7) on byte values, branch free: with
 * d = (b − a) & ((b − a) >> 31) (= b − a when b < a, else 0), a += d / b −= d orders the pair —
 * no mispredicted branches on noisy data. The interior loops are written out (V8 does not inline
 * the network functions there); the clamped ends call medN().
 */
function med3(p0: number, p1: number, p2: number): number {
  let d: number;
  d = (p1 - p0) & ((p1 - p0) >> 31);
  p0 += d;
  p1 -= d;
  d = (p2 - p1) & ((p2 - p1) >> 31);
  p1 += d;
  p2 -= d;
  d = (p1 - p0) & ((p1 - p0) >> 31);
  p0 += d;
  p1 -= d;
  return p1;
}

function med5(p0: number, p1: number, p2: number, p3: number, p4: number): number {
  let d: number;
  d = (p1 - p0) & ((p1 - p0) >> 31);
  p0 += d;
  p1 -= d;
  d = (p4 - p3) & ((p4 - p3) >> 31);
  p3 += d;
  p4 -= d;
  d = (p3 - p0) & ((p3 - p0) >> 31);
  p0 += d;
  p3 -= d;
  d = (p4 - p1) & ((p4 - p1) >> 31);
  p1 += d;
  p4 -= d;
  d = (p2 - p1) & ((p2 - p1) >> 31);
  p1 += d;
  p2 -= d;
  d = (p3 - p2) & ((p3 - p2) >> 31);
  p2 += d;
  p3 -= d;
  d = (p2 - p1) & ((p2 - p1) >> 31);
  p1 += d;
  p2 -= d;
  return p2;
}

function med7(p0: number, p1: number, p2: number, p3: number, p4: number, p5: number, p6: number): number {
  let d: number;
  d = (p5 - p0) & ((p5 - p0) >> 31);
  p0 += d;
  p5 -= d;
  d = (p3 - p0) & ((p3 - p0) >> 31);
  p0 += d;
  p3 -= d;
  d = (p6 - p1) & ((p6 - p1) >> 31);
  p1 += d;
  p6 -= d;
  d = (p4 - p2) & ((p4 - p2) >> 31);
  p2 += d;
  p4 -= d;
  d = (p1 - p0) & ((p1 - p0) >> 31);
  p0 += d;
  p1 -= d;
  d = (p5 - p3) & ((p5 - p3) >> 31);
  p3 += d;
  p5 -= d;
  d = (p6 - p2) & ((p6 - p2) >> 31);
  p2 += d;
  p6 -= d;
  d = (p3 - p2) & ((p3 - p2) >> 31);
  p2 += d;
  p3 -= d;
  d = (p6 - p3) & ((p6 - p3) >> 31);
  p3 += d;
  p6 -= d;
  d = (p5 - p4) & ((p5 - p4) >> 31);
  p4 += d;
  p5 -= d;
  d = (p4 - p1) & ((p4 - p1) >> 31);
  p1 += d;
  p4 -= d;
  d = (p3 - p1) & ((p3 - p1) >> 31);
  p1 += d;
  p3 -= d;
  d = (p4 - p3) & ((p4 - p3) >> 31);
  p3 += d;
  p4 -= d;
  return p3;
}

/** Horizontal median of 3 taps, clamp-to-edge. */
function rowsMed3(src: Uint8Array, dst: Uint8Array, w: number, h: number) {
  const r = 1;
  for (let y = 0; y < h; y++) {
    const base = y * w,
      last = w - 1;
    const at = (x: number, k: number) => src[base + (x + k < 0 ? 0 : x + k > last ? last : x + k)];
    for (let x = 0; x < w && x < r; x++) dst[base + x] = med3(at(x, -1), at(x, 0), at(x, 1));
    for (let q = base + r, e = base + w - r; q < e; q++) {
      let p0 = src[q - 1],
        p1 = src[q],
        p2 = src[q + 1],
        d: number;
      d = (p1 - p0) & ((p1 - p0) >> 31);
      p0 += d;
      p1 -= d;
      d = (p2 - p1) & ((p2 - p1) >> 31);
      p1 += d;
      p2 -= d;
      d = (p1 - p0) & ((p1 - p0) >> 31);
      p0 += d;
      p1 -= d;
      dst[q] = p1;
    }
    for (let x = Math.max(r, w - r); x < w; x++) dst[base + x] = med3(at(x, -1), at(x, 0), at(x, 1));
  }
}

/** Vertical median of 3 taps, clamp-to-edge, read from 3 row streams. */
function colsMed3(src: Uint8Array, dst: Uint8Array, w: number, h: number) {
  const row = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y) * w;
  for (let y = 0; y < h; y++) {
    const o = y * w,
      r0 = row(y - 1),
      r1 = row(y + 0),
      r2 = row(y + 1);
    for (let x = 0; x < w; x++) {
      let p0 = src[r0 + x],
        p1 = src[r1 + x],
        p2 = src[r2 + x],
        d: number;
      d = (p1 - p0) & ((p1 - p0) >> 31);
      p0 += d;
      p1 -= d;
      d = (p2 - p1) & ((p2 - p1) >> 31);
      p1 += d;
      p2 -= d;
      d = (p1 - p0) & ((p1 - p0) >> 31);
      p0 += d;
      p1 -= d;
      dst[o + x] = p1;
    }
  }
}

/** Horizontal median of 5 taps, clamp-to-edge. */
function rowsMed5(src: Uint8Array, dst: Uint8Array, w: number, h: number) {
  const r = 2;
  for (let y = 0; y < h; y++) {
    const base = y * w,
      last = w - 1;
    const at = (x: number, k: number) => src[base + (x + k < 0 ? 0 : x + k > last ? last : x + k)];
    for (let x = 0; x < w && x < r; x++) dst[base + x] = med5(at(x, -2), at(x, -1), at(x, 0), at(x, 1), at(x, 2));
    for (let q = base + r, e = base + w - r; q < e; q++) {
      let p0 = src[q - 2],
        p1 = src[q - 1],
        p2 = src[q],
        p3 = src[q + 1],
        p4 = src[q + 2],
        d: number;
      d = (p1 - p0) & ((p1 - p0) >> 31);
      p0 += d;
      p1 -= d;
      d = (p4 - p3) & ((p4 - p3) >> 31);
      p3 += d;
      p4 -= d;
      d = (p3 - p0) & ((p3 - p0) >> 31);
      p0 += d;
      p3 -= d;
      d = (p4 - p1) & ((p4 - p1) >> 31);
      p1 += d;
      p4 -= d;
      d = (p2 - p1) & ((p2 - p1) >> 31);
      p1 += d;
      p2 -= d;
      d = (p3 - p2) & ((p3 - p2) >> 31);
      p2 += d;
      p3 -= d;
      d = (p2 - p1) & ((p2 - p1) >> 31);
      p1 += d;
      p2 -= d;
      dst[q] = p2;
    }
    for (let x = Math.max(r, w - r); x < w; x++) dst[base + x] = med5(at(x, -2), at(x, -1), at(x, 0), at(x, 1), at(x, 2));
  }
}

/** Vertical median of 5 taps, clamp-to-edge, read from 5 row streams. */
function colsMed5(src: Uint8Array, dst: Uint8Array, w: number, h: number) {
  const row = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y) * w;
  for (let y = 0; y < h; y++) {
    const o = y * w,
      r0 = row(y - 2),
      r1 = row(y - 1),
      r2 = row(y + 0),
      r3 = row(y + 1),
      r4 = row(y + 2);
    for (let x = 0; x < w; x++) {
      let p0 = src[r0 + x],
        p1 = src[r1 + x],
        p2 = src[r2 + x],
        p3 = src[r3 + x],
        p4 = src[r4 + x],
        d: number;
      d = (p1 - p0) & ((p1 - p0) >> 31);
      p0 += d;
      p1 -= d;
      d = (p4 - p3) & ((p4 - p3) >> 31);
      p3 += d;
      p4 -= d;
      d = (p3 - p0) & ((p3 - p0) >> 31);
      p0 += d;
      p3 -= d;
      d = (p4 - p1) & ((p4 - p1) >> 31);
      p1 += d;
      p4 -= d;
      d = (p2 - p1) & ((p2 - p1) >> 31);
      p1 += d;
      p2 -= d;
      d = (p3 - p2) & ((p3 - p2) >> 31);
      p2 += d;
      p3 -= d;
      d = (p2 - p1) & ((p2 - p1) >> 31);
      p1 += d;
      p2 -= d;
      dst[o + x] = p2;
    }
  }
}

/** Horizontal median of 7 taps, clamp-to-edge. */
function rowsMed7(src: Uint8Array, dst: Uint8Array, w: number, h: number) {
  const r = 3;
  for (let y = 0; y < h; y++) {
    const base = y * w,
      last = w - 1;
    const at = (x: number, k: number) => src[base + (x + k < 0 ? 0 : x + k > last ? last : x + k)];
    for (let x = 0; x < w && x < r; x++) dst[base + x] = med7(at(x, -3), at(x, -2), at(x, -1), at(x, 0), at(x, 1), at(x, 2), at(x, 3));
    for (let q = base + r, e = base + w - r; q < e; q++) {
      let p0 = src[q - 3],
        p1 = src[q - 2],
        p2 = src[q - 1],
        p3 = src[q],
        p4 = src[q + 1],
        p5 = src[q + 2],
        p6 = src[q + 3],
        d: number;
      d = (p5 - p0) & ((p5 - p0) >> 31);
      p0 += d;
      p5 -= d;
      d = (p3 - p0) & ((p3 - p0) >> 31);
      p0 += d;
      p3 -= d;
      d = (p6 - p1) & ((p6 - p1) >> 31);
      p1 += d;
      p6 -= d;
      d = (p4 - p2) & ((p4 - p2) >> 31);
      p2 += d;
      p4 -= d;
      d = (p1 - p0) & ((p1 - p0) >> 31);
      p0 += d;
      p1 -= d;
      d = (p5 - p3) & ((p5 - p3) >> 31);
      p3 += d;
      p5 -= d;
      d = (p6 - p2) & ((p6 - p2) >> 31);
      p2 += d;
      p6 -= d;
      d = (p3 - p2) & ((p3 - p2) >> 31);
      p2 += d;
      p3 -= d;
      d = (p6 - p3) & ((p6 - p3) >> 31);
      p3 += d;
      p6 -= d;
      d = (p5 - p4) & ((p5 - p4) >> 31);
      p4 += d;
      p5 -= d;
      d = (p4 - p1) & ((p4 - p1) >> 31);
      p1 += d;
      p4 -= d;
      d = (p3 - p1) & ((p3 - p1) >> 31);
      p1 += d;
      p3 -= d;
      d = (p4 - p3) & ((p4 - p3) >> 31);
      p3 += d;
      p4 -= d;
      dst[q] = p3;
    }
    for (let x = Math.max(r, w - r); x < w; x++) dst[base + x] = med7(at(x, -3), at(x, -2), at(x, -1), at(x, 0), at(x, 1), at(x, 2), at(x, 3));
  }
}

/** Vertical median of 7 taps, clamp-to-edge, read from 7 row streams. */
function colsMed7(src: Uint8Array, dst: Uint8Array, w: number, h: number) {
  const row = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y) * w;
  for (let y = 0; y < h; y++) {
    const o = y * w,
      r0 = row(y - 3),
      r1 = row(y - 2),
      r2 = row(y - 1),
      r3 = row(y + 0),
      r4 = row(y + 1),
      r5 = row(y + 2),
      r6 = row(y + 3);
    for (let x = 0; x < w; x++) {
      let p0 = src[r0 + x],
        p1 = src[r1 + x],
        p2 = src[r2 + x],
        p3 = src[r3 + x],
        p4 = src[r4 + x],
        p5 = src[r5 + x],
        p6 = src[r6 + x],
        d: number;
      d = (p5 - p0) & ((p5 - p0) >> 31);
      p0 += d;
      p5 -= d;
      d = (p3 - p0) & ((p3 - p0) >> 31);
      p0 += d;
      p3 -= d;
      d = (p6 - p1) & ((p6 - p1) >> 31);
      p1 += d;
      p6 -= d;
      d = (p4 - p2) & ((p4 - p2) >> 31);
      p2 += d;
      p4 -= d;
      d = (p1 - p0) & ((p1 - p0) >> 31);
      p0 += d;
      p1 -= d;
      d = (p5 - p3) & ((p5 - p3) >> 31);
      p3 += d;
      p5 -= d;
      d = (p6 - p2) & ((p6 - p2) >> 31);
      p2 += d;
      p6 -= d;
      d = (p3 - p2) & ((p3 - p2) >> 31);
      p2 += d;
      p3 -= d;
      d = (p6 - p3) & ((p6 - p3) >> 31);
      p3 += d;
      p6 -= d;
      d = (p5 - p4) & ((p5 - p4) >> 31);
      p4 += d;
      p5 -= d;
      d = (p4 - p1) & ((p4 - p1) >> 31);
      p1 += d;
      p4 -= d;
      d = (p3 - p1) & ((p3 - p1) >> 31);
      p1 += d;
      p3 -= d;
      d = (p4 - p3) & ((p4 - p3) >> 31);
      p3 += d;
      p4 -= d;
      dst[o + x] = p3;
    }
  }
}

/** Horizontal median of 2r + 1 taps (r ≤ 3), clamp-to-edge. */
function medianRowsNet(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  if (r === 1) rowsMed3(src, dst, w, h);
  else if (r === 2) rowsMed5(src, dst, w, h);
  else rowsMed7(src, dst, w, h);
}

/** Vertical median of 2r + 1 taps (r ≤ 3), clamp-to-edge. */
function medianColsNet(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  if (r === 1) colsMed3(src, dst, w, h);
  else if (r === 2) colsMed5(src, dst, w, h);
  else colsMed7(src, dst, w, h);
}

/** Blocked transpose of a w×h byte plane into dst (h×w). */
function transposeBytes(src: Uint8Array, dst: Uint8Array, w: number, h: number) {
  const B = 32;
  for (let y0 = 0; y0 < h; y0 += B) {
    const y1 = Math.min(h, y0 + B);
    for (let x0 = 0; x0 < w; x0 += B) {
      const x1 = Math.min(w, x0 + B);
      for (let y = y0; y < y1; y++) {
        const ro = y * w;
        for (let x = x0; x < x1; x++) dst[x * h + y] = src[ro + x];
      }
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
  if (r <= 3) {
    // small windows (3/5/7 taps): a median network per pixel (no dependency between pixels, the
    // columns read straight from 2r+1 row streams — no transposes); same medians
    medianRowsNet(src, tmp, w, h, r);
    medianColsNet(tmp, dst, w, h, r);
    return dst;
  }
  // rows, then columns as rows of the transposed plane (sequential memory in both passes)
  medianRows(src, tmp, w, h, r);
  const t = new Uint8Array(src.length);
  transposeBytes(tmp, t, w, h);
  medianRows(t, tmp, h, w, r);
  transposeBytes(tmp, dst, h, w);
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
