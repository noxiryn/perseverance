/**
 * Pure mask math on plain typed arrays (unit-testable without canvas):
 *  - exact Euclidean distance transform (Felzenszwalb & Huttenlocher) for round expand/contract/border,
 *  - color-range selection weights,
 *  - box blur + threshold (smooth).
 */

const INF = 1e20;

/** 1D squared distance transform of f (in place into d). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Squared Euclidean distance from every pixel to the nearest "feature" pixel
 * (feature[i] != 0). Returns a Float64Array of size w*h (0 at feature pixels).
 */
export function squaredDistanceTransform(feature: ArrayLike<number>, w: number, h: number): Float64Array {
  const n = Math.max(w, h);
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = feature[i] ? 0 : INF;
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  // columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  // rows
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = out[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = d[x];
  }
  return out;
}

/**
 * Grow (amount > 0) or shrink (amount < 0) a selection alpha mask by |amount| px with round
 * corners. Input/output are 0..255 alpha arrays (threshold 128 defines "inside"). Edges are
 * anti-aliased over ~1px.
 */
export function morphAlpha(alpha: ArrayLike<number>, w: number, h: number, amount: number): Uint8ClampedArray {
  const n = w * h;
  const out = new Uint8ClampedArray(n);
  if (!amount) {
    for (let i = 0; i < n; i++) out[i] = alpha[i];
    return out;
  }
  const r = Math.abs(amount);
  if (amount > 0) {
    const inside = new Uint8Array(n);
    for (let i = 0; i < n; i++) inside[i] = alpha[i] >= 128 ? 1 : 0;
    const dist = squaredDistanceTransform(inside, w, h);
    for (let i = 0; i < n; i++) {
      // center-to-center distance dd ⇒ distance from this pixel's center to the original edge ≈ dd - 0.5
      const dd = Math.sqrt(dist[i]);
      const cov = r + 1 - dd;
      out[i] = cov >= 1 ? 255 : cov <= 0 ? 0 : Math.round(cov * 255);
    }
  } else {
    const outside = new Uint8Array(n);
    for (let i = 0; i < n; i++) outside[i] = alpha[i] >= 128 ? 0 : 1;
    const dist = squaredDistanceTransform(outside, w, h);
    for (let i = 0; i < n; i++) {
      const dd = Math.sqrt(dist[i]);
      const cov = dd - r; // inside pixels farther than r from the edge stay selected
      out[i] = cov >= 1 ? 255 : cov <= 0 ? 0 : Math.round(cov * 255);
    }
  }
  return out;
}

/** Border: a band of `width` px centered on the selection edge (anti-aliased). */
export function borderAlpha(alpha: ArrayLike<number>, w: number, h: number, width: number): Uint8ClampedArray {
  const n = w * h;
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = alpha[i] >= 128;
    inside[i] = v ? 1 : 0;
    outside[i] = v ? 0 : 1;
  }
  const dIn = squaredDistanceTransform(inside, w, h); // distance for outside pixels to the shape
  const dOut = squaredDistanceTransform(outside, w, h); // distance for inside pixels to the outside
  const half = Math.max(0.5, width / 2);
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    // distance to the edge (≈ pixel-boundary distance): outside pixels use dIn, inside use dOut
    const dd = inside[i] ? Math.sqrt(dOut[i]) - 0.5 : Math.sqrt(dIn[i]) - 0.5;
    const cov = half + 0.5 - dd;
    out[i] = cov >= 1 ? 255 : cov <= 0 ? 0 : Math.round(cov * 255);
  }
  return out;
}

/** Separable box blur on a 0..255 single-channel array (radius in px, integer ≥ 1). */
export function boxBlurAlpha(src: ArrayLike<number>, w: number, h: number, radius: number): Uint8ClampedArray {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const span = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / span;
      const add = src[row + Math.min(w - 1, x + r + 1)];
      const sub = src[row + Math.max(0, x - r)];
      acc += add - sub;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(acc / span);
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x];
      const sub = tmp[Math.max(0, y - r) * w + x];
      acc += add - sub;
    }
  }
  return out;
}

/** Smooth a selection: blur by radius then re-threshold at 50% with a 1px anti-aliased ramp. */
export function smoothAlpha(alpha: ArrayLike<number>, w: number, h: number, radius: number): Uint8ClampedArray {
  const b = boxBlurAlpha(alpha, w, h, radius);
  for (let i = 0; i < b.length; i++) {
    // steepen around 128 → crisp but anti-aliased edge
    const v = (b[i] - 128) * 6 + 128;
    b[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return b;
}

/**
 * Color Range weights: for each RGBA pixel, selection strength (0..255) for the closest of the
 * sample colors. `fuzziness` 0..200 (Photoshop scale): colors within fuzziness/2 are fully
 * selected, falling off linearly to 0 at `fuzziness`. Transparent pixels are weighted by alpha.
 */
export function colorRangeAlpha(
  rgba: ArrayLike<number>,
  count: number,
  samples: { r: number; g: number; b: number }[],
  fuzziness: number,
  invert = false,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(count);
  const f = Math.max(1, fuzziness);
  const full = f / 2;
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    const r = rgba[i],
      g = rgba[i + 1],
      b = rgba[i + 2],
      a = rgba[i + 3];
    let best = 0;
    for (let s = 0; s < samples.length; s++) {
      const c = samples[s];
      const dr = r - c.r,
        dg = g - c.g,
        db = b - c.b;
      // perceptual-ish weighting, normalized to 0..255
      const d = Math.sqrt((dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11));
      let wgt = d <= full ? 1 : d >= f ? 0 : 1 - (d - full) / (f - full);
      if (wgt > best) best = wgt;
      if (best >= 1) break;
    }
    let v = best * (a / 255);
    if (invert) v = 1 - v;
    out[p] = Math.round(v * 255);
  }
  return out;
}

/** Tight bounds of alpha >= minAlpha in a single-channel array, or null. */
export function alphaBounds(alpha: ArrayLike<number>, w: number, h: number, minAlpha = 1) {
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[row + x] >= minAlpha) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
