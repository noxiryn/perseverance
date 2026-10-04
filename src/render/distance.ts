/**
 * Anti-aliasing-aware Euclidean distance transform (Felzenszwalb & Huttenlocher, exact EDT)
 * used for crisp strokes, chokes and bevels at any size.
 *
 * Input is an 8-bit coverage (alpha) map. "Inside" = coverage ≥ 50%. For every pixel we return
 * the distance (px) from its center to the estimated shape edge, with a sub-pixel correction
 * from the coverage of the nearest site and of the pixel itself — giving smooth edges after a
 * 1px ramp.
 */

let fBuf = new Float64Array(0);
let dBuf = new Float64Array(0);
let zBuf = new Float64Array(0);
let vBuf = new Int32Array(0);
let argBuf = new Int32Array(0);

function ensure(n: number) {
  if (fBuf.length < n) {
    fBuf = new Float64Array(n);
    dBuf = new Float64Array(n);
    zBuf = new Float64Array(n + 1);
    vBuf = new Int32Array(n);
    argBuf = new Int32Array(n);
  }
}

const INF = 1e20;

/** 1D squared distance transform of f[0..n) into dBuf / argBuf. */
function dt1d(n: number) {
  const f = fBuf,
    d = dBuf,
    z = zBuf,
    v = vBuf,
    arg = argBuf;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let s = (fq - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (fq - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
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
    arg[q] = v[k];
  }
}

/**
 * Distance from each pixel to the edge of the shape described by `cov` (0..255 coverage).
 *  - mode 'outside': distance for pixels outside the shape (0 inside).
 *  - mode 'inside': distance for pixels inside the shape (0 outside).
 * The result is in pixels, sub-pixel corrected, ≥ 0. Pixels farther than `maxDist` may be
 * clamped to `maxDist` (pass Infinity for exact).
 */
export function edgeDistance(cov: Uint8Array | Uint8ClampedArray, w: number, h: number, mode: 'outside' | 'inside', maxDist = Infinity): Float32Array {
  const n = w * h;
  const out = new Float32Array(n);
  if (!n) return out;
  const site = new Uint8Array(n);
  if (mode === 'outside') for (let i = 0; i < n; i++) site[i] = cov[i] >= 128 ? 1 : 0;
  else for (let i = 0; i < n; i++) site[i] = cov[i] < 128 ? 1 : 0;
  ensure(Math.max(w, h));
  // Pass 1: per column, vertical distance (squared) to the nearest site + its row.
  const g = new Float32Array(n);
  const gy = new Int32Array(n);
  for (let x = 0; x < w; x++) {
    let last = -1;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      if (site[i]) last = y;
      if (last >= 0) {
        const dy = y - last;
        g[i] = dy * dy;
        gy[i] = last;
      } else {
        g[i] = INF;
        gy[i] = -1;
      }
    }
    let next = -1;
    for (let y = h - 1; y >= 0; y--) {
      const i = y * w + x;
      if (site[i]) next = y;
      if (next >= 0) {
        const dy = next - y;
        if (dy * dy < g[i]) {
          g[i] = dy * dy;
          gy[i] = next;
        }
      }
    }
  }
  // Pass 2: per row, lower envelope of parabolas.
  const f = fBuf;
  const md2 = Number.isFinite(maxDist) ? (maxDist + 2) * (maxDist + 2) : INF;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = g[row + x];
    dt1d(w);
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const a = cov[i];
      if (site[i]) {
        out[i] = 0;
        continue;
      }
      const d2 = dBuf[x];
      if (d2 >= md2) {
        out[i] = maxDist;
        continue;
      }
      const sx = argBuf[x];
      const sy = gy[row + sx];
      let d = Math.sqrt(d2);
      if (sy >= 0) {
        // Sub-pixel correction: the edge lies (coverage - 0.5) beyond the nearest site's center.
        const sa = cov[sy * w + sx] / 255;
        d -= mode === 'outside' ? sa - 0.5 : 0.5 - sa;
      } else {
        d -= 0.5;
      }
      // A partially covered pixel bounds the distance from above by its own coverage.
      if (mode === 'outside' ? a > 0 : a < 255) {
        const own = mode === 'outside' ? 0.5 - a / 255 : a / 255 - 0.5;
        if (own < d) d = own;
      }
      out[i] = d > 0 ? d : 0;
    }
  }
  return out;
}

/** Signed distance to the edge: negative inside, positive outside (px). */
export function signedEdgeDistance(cov: Uint8Array | Uint8ClampedArray, w: number, h: number, maxDist = Infinity): Float32Array {
  const outD = edgeDistance(cov, w, h, 'outside', maxDist);
  const inD = edgeDistance(cov, w, h, 'inside', maxDist);
  for (let i = 0; i < outD.length; i++) outD[i] = cov[i] >= 128 ? -inD[i] : outD[i];
  return outD;
}

/** Extract the alpha channel of RGBA pixels. */
export function alphaOf(rgba: Uint8ClampedArray, out?: Uint8Array): Uint8Array {
  const n = rgba.length >> 2;
  const a = out && out.length >= n ? out : new Uint8Array(n);
  for (let i = 0, j = 3; i < n; i++, j += 4) a[i] = rgba[j];
  return a;
}
