/**
 * Heavier shared pixel operations (pure, DOM-free):
 *  - `lineBoxBlur`: O(1)-per-pixel box blur along an arbitrary direction (digital lines + prefix
 *    sums) → motion blur, lens-blur bokeh shapes, charcoal streaks.
 *  - `radialAccumulate`: box filter over a family of rotations (spin) or scalings (zoom) about a
 *    center, computed with log2(taps) "doubling" passes → radial blur, god rays.
 *  - `downsamplePlane` / `sampleUp`: cheap multi-resolution glow pipelines (bloom, glow).
 */
import type { Edge, Planes } from './util';
import { blurPlane } from './util';

const DEG = Math.PI / 180;

/**
 * Box blur of a float plane along direction `angleDeg` (0 = horizontal, CCW positive, screen y
 * down) with half-length `radius` px. Fractional radii are honoured with partial end weights.
 * `clampEdge`: extend the border values (opaque images); otherwise outside = 0 (premultiplied
 * transparency). Returns a new plane.
 */
export function lineBoxBlur(src: Float32Array, w: number, h: number, angleDeg: number, radius: number, clampEdge: boolean): Float32Array {
  const out = new Float32Array(w * h);
  const th = angleDeg * DEG;
  const c = Math.cos(th),
    s = Math.sin(th);
  const horiz = Math.abs(c) >= Math.abs(s);
  const slope = horiz ? -s / c : -c / s;
  const rSteps = radius * (horiz ? Math.abs(c) : Math.abs(s));
  if (!(rSteps >= 0.25)) {
    out.set(src);
    return out;
  }
  const R = Math.floor(rSteps);
  const frac = rSteps - R;
  const norm = 1 / (2 * rSteps + 1);
  const L = horiz ? w : h; // steps along the major axis
  const M = horiz ? h : w; // minor axis extent
  const off = new Int32Array(L);
  let minOff = 0,
    maxOff = 0;
  for (let k = 0; k < L; k++) {
    const o = Math.round(k * slope);
    off[k] = o;
    if (o < minOff) minOff = o;
    if (o > maxOff) maxOff = o;
  }
  const pad = R + 2;
  const vals = new Float32Array(L);
  const idx = new Int32Array(L);
  const pre = new Float64Array(L + pad * 2 + 1);
  for (let m0 = -maxOff; m0 < M - minOff; m0++) {
    let cnt = 0;
    for (let k = 0; k < L; k++) {
      const m = m0 + off[k];
      if (m < 0 || m >= M) {
        if (cnt) break; // lines are monotonic: once we leave the image we are done
        continue;
      }
      const i = horiz ? m * w + k : k * w + m;
      idx[cnt] = i;
      vals[cnt++] = src[i];
    }
    if (!cnt) continue;
    // prefix sums over the padded line
    const first = clampEdge ? vals[0] : 0,
      last = clampEdge ? vals[cnt - 1] : 0;
    let acc = 0;
    pre[0] = 0;
    const total = cnt + pad * 2;
    for (let q = 0; q < total; q++) {
      const p = q - pad;
      acc += p < 0 ? first : p >= cnt ? last : vals[p];
      pre[q + 1] = acc;
    }
    for (let p = 0; p < cnt; p++) {
      const q = p + pad;
      let sum = pre[q + R + 1] - pre[q - R];
      if (frac > 0) {
        const lo = p - R - 1,
          hi = p + R + 1;
        sum += frac * ((lo < 0 ? first : vals[lo]) + (hi >= cnt ? last : vals[hi]));
      }
      out[idx[p]] = sum * norm;
    }
  }
  return out;
}

/** lineBoxBlur on every plane of a premultiplied Planes set (returns a new set). */
export function lineBoxBlurPlanes(p: Planes, w: number, h: number, angleDeg: number, radius: number, clampEdge: boolean): Planes {
  return {
    r: lineBoxBlur(p.r, w, h, angleDeg, radius, clampEdge),
    g: lineBoxBlur(p.g, w, h, angleDeg, radius, clampEdge),
    b: lineBoxBlur(p.b, w, h, angleDeg, radius, clampEdge),
    a: lineBoxBlur(p.a, w, h, angleDeg, radius, clampEdge),
  };
}

/**
 * Average of `planes` over a uniformly spaced family of transforms about (cx, cy) (index space):
 *  - kind 'spin': rotations by angles in [-span/2, span/2] (radians) — or [0, span] if !centered;
 *  - kind 'zoom': scalings by exp(t), t in [-span/2, span/2] (log-scale) — or [0, span].
 * Implemented with doubling passes: after p passes each pixel averages 2^p taps, using only one
 * bilinear lookup per pass. Planes must be premultiplied. Returns new planes.
 */
export function radialAccumulate(
  planes: Float32Array[],
  w: number,
  h: number,
  cx: number,
  cy: number,
  kind: 'spin' | 'zoom',
  span: number,
  edge: Edge,
  centered = true,
  maxPasses = 11,
): Float32Array[] {
  const n = w * h;
  // farthest corner distance → largest displacement in px
  const R = Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy));
  const maxDisp = kind === 'spin' ? R * Math.abs(span) : R * Math.abs(Math.exp(Math.abs(span)) - 1);
  if (maxDisp < 0.5) return planes.map((p) => Float32Array.from(p));
  const passes = Math.max(1, Math.min(maxPasses, Math.ceil(Math.log2(maxDisp / 0.7))));
  const T = 1 << passes;
  const d = span / T;
  const start = centered ? (-(T - 1) * d) / 2 : 0;
  const k = planes.length;
  // interleaved ping-pong buffers: one bilinear fetch reads all channels from adjacent memory
  let cur = new Float32Array(n * k);
  let next = new Float32Array(n * k);
  for (let c = 0; c < k; c++) {
    const p = planes[c];
    for (let i = 0, o = c; i < n; i++, o += k) cur[o] = p[i];
  }
  for (let pass = 0; pass < passes; pass++) {
    // pass 0: taps at start and start + d (relative to the source); later: identity and +d·2^pass
    const offA = pass === 0 ? start : 0;
    const offB = pass === 0 ? start + d : d * (1 << pass);
    const ca = kind === 'spin' ? Math.cos(offA) : Math.exp(offA),
      sa = kind === 'spin' ? Math.sin(offA) : 0;
    const cb = kind === 'spin' ? Math.cos(offB) : Math.exp(offB),
      sb = kind === 'spin' ? Math.sin(offB) : 0;
    const identityA = Math.abs(offA) < 1e-12;
    if (identityA) next.set(cur);
    for (let y = 0; y < h; y++) {
      const dy = y - cy;
      let o = y * w * k;
      for (let x = 0; x < w; x++, o += k) {
        const dx = x - cx;
        if (!identityA) sampleInterleaved(cur, k, w, h, cx + dx * ca - dy * sa, cy + dx * sa + dy * ca, edge, next, o, false);
        sampleInterleaved(cur, k, w, h, cx + dx * cb - dy * sb, cy + dx * sb + dy * cb, edge, next, o, true);
      }
    }
    const t = cur;
    cur = next;
    next = t;
  }
  return planes.map((_, c) => {
    const p = new Float32Array(n);
    for (let i = 0, o = c; i < n; i++, o += k) p[i] = cur[o];
    return p;
  });
}

/**
 * Bilinear sample of interleaved data (k channels) at (fx, fy). Writes into dst[o..o+k) or, with
 * `average`, replaces dst with the mean of its current value and the sample.
 */
function sampleInterleaved(src: Float32Array, k: number, w: number, h: number, fx: number, fy: number, edge: Edge, dst: Float32Array, o: number, average: boolean) {
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
  if (x0 < 0 || y0 < 0 || x1 >= w || y1 >= h) {
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
  }
  const i00 = (y0 * w + x0) * k,
    i10 = (y0 * w + x1) * k,
    i01 = (y1 * w + x0) * k,
    i11 = (y1 * w + x1) * k;
  for (let c = 0; c < k; c++) {
    const v = src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11;
    dst[o + c] = average ? (dst[o + c] + v) * 0.5 : v;
  }
}

/** Box-average downsample by an integer factor. */
export function downsamplePlane(src: Float32Array, w: number, h: number, f: number): { buf: Float32Array; w: number; h: number } {
  if (f <= 1) return { buf: Float32Array.from(src), w, h };
  const w2 = Math.max(1, Math.ceil(w / f)),
    h2 = Math.max(1, Math.ceil(h / f));
  const buf = new Float32Array(w2 * h2);
  const cnt = new Float32Array(w2 * h2);
  for (let y = 0; y < h; y++) {
    const ro = ((y / f) | 0) * w2;
    for (let x = 0; x < w; x++) {
      const k = ro + ((x / f) | 0);
      buf[k] += src[y * w + x];
      cnt[k]++;
    }
  }
  for (let i = 0; i < buf.length; i++) buf[i] /= cnt[i] || 1;
  return { buf, w: w2, h: h2 };
}

/** Bilinear upsample lookup of a plane downsampled by factor f at full-res pixel (x, y). */
export function sampleUp(buf: Float32Array, w2: number, h2: number, f: number, x: number, y: number): number {
  let fx = (x + 0.5) / f - 0.5,
    fy = (y + 0.5) / f - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > w2 - 1) fx = w2 - 1;
  if (fy < 0) fy = 0;
  else if (fy > h2 - 1) fy = h2 - 1;
  const x0 = fx | 0,
    y0 = fy | 0;
  const x1 = x0 < w2 - 1 ? x0 + 1 : x0,
    y1 = y0 < h2 - 1 ? y0 + 1 : y0;
  const tx = fx - x0,
    ty = fy - y0;
  const a = buf[y0 * w2 + x0],
    b = buf[y0 * w2 + x1],
    c = buf[y1 * w2 + x0],
    d = buf[y1 * w2 + x1];
  return a + (b - a) * tx + (c - a + (a - b - c + d) * tx) * ty;
}

/** Upsample a whole plane back to (w, h). */
export function upsamplePlane(buf: Float32Array, w2: number, h2: number, f: number, w: number, h: number): Float32Array {
  if (f <= 1 && w2 === w && h2 === h) return buf;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = sampleUp(buf, w2, h2, f, x, y);
  return out;
}

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
