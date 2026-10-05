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

/**
 * Sliding median along each row (clamp-to-edge) for small windows: the window is kept sorted and
 * updated by one removal + one insertion per step (O(r), no 256-bin histogram walk). Same values
 * as median1D.
 */
function medianRowsSorted(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  const n = 2 * r + 1;
  const win = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    const last = base + w - 1;
    // initial window: taps -r..r clamped, sorted (insertion sort)
    for (let k = 0; k < n; k++) {
      const q = base + k - r;
      const v = src[q < base ? base : q > last ? last : q];
      let p = k;
      while (p > 0 && win[p - 1] > v) {
        win[p] = win[p - 1];
        p--;
      }
      win[p] = v;
    }
    dst[base] = win[r];
    for (let i = 1; i < w; i++) {
      const qo = base + i - r - 1,
        qi = base + i + r;
      const vo = src[qo < base ? base : qo],
        vi = src[qi > last ? last : qi];
      if (vo !== vi) {
        // remove vo, then insert vi (shifting the values in between)
        let p = 0;
        while (win[p] !== vo) p++;
        if (vi > vo) {
          while (p < n - 1 && win[p + 1] < vi) {
            win[p] = win[p + 1];
            p++;
          }
        } else {
          while (p > 0 && win[p - 1] > vi) {
            win[p] = win[p - 1];
            p--;
          }
        }
        win[p] = vi;
      }
      dst[base + i] = win[r];
    }
  }
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
  if (r <= 12) {
    // small windows: sorted-window medians; columns as rows of the transposed plane
    medianRowsSorted(src, tmp, w, h, r); // rows
    const t = new Uint8Array(src.length);
    transposeBytes(tmp, t, w, h);
    medianRowsSorted(t, tmp, h, w, r); // columns
    transposeBytes(tmp, dst, h, w);
    return dst;
  }
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
