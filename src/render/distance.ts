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
let siteBuf = new Uint8Array(0);
let gBuf = new Float32Array(0);
let gyBuf = new Int32Array(0);
let colBuf = new Int32Array(0);

function ensureMap(n: number, w: number) {
  if (siteBuf.length < n) {
    siteBuf = new Uint8Array(n);
    gBuf = new Float32Array(n);
    gyBuf = new Int32Array(n);
  }
  if (colBuf.length < w) colBuf = new Int32Array(w);
}

export function edgeDistance(cov: Uint8Array | Uint8ClampedArray, w: number, h: number, mode: 'outside' | 'inside', maxDist = Infinity): Float32Array {
  const n = w * h;
  const out = new Float32Array(n);
  if (!n) return out;
  ensureMap(n, w);
  ensure(Math.max(w, h));
  const site = siteBuf;
  const outside = mode === 'outside';
  // Pass 1, forward sweep (row-major for cache locality), fused with site detection: per
  // column, squared vertical distance to the last site above and that site's row.
  const g = gBuf;
  const gy = gyBuf;
  const col = colBuf;
  col.fill(-1, 0, w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const s = outside ? cov[i] >= 128 : cov[i] < 128;
      site[i] = s ? 1 : 0;
      if (s) col[x] = y;
      const last = col[x];
      if (last >= 0) {
        const dy = y - last;
        g[i] = dy * dy;
        gy[i] = last;
      } else {
        g[i] = INF;
        gy[i] = -1;
      }
    }
  }
  // Backward sweep fused with pass 2: once row y has seen the sites below it, its column
  // distances are final and its 1D envelope can run immediately (one less pass over memory).
  const md2 = Number.isFinite(maxDist) ? (maxDist + 2) * (maxDist + 2) : INF;
  const R = Number.isFinite(maxDist) ? Math.ceil(maxDist) + 3 : w;
  if (nearBuf.length < w) nearBuf = new Int32Array(w);
  near = nearBuf;
  col.fill(-1, 0, w);
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    // Rows entirely made of sites are 0; rows with no site within reach are all `maxDist`
    // (every candidate distance is ≥ its vertical part) — both skip the envelope.
    let allSite = true;
    let minG = INF;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (site[i]) col[x] = y;
      else allSite = false;
      const next = col[x];
      if (next >= 0) {
        const dy = next - y;
        if (dy * dy < g[i]) {
          g[i] = dy * dy;
          gy[i] = next;
        }
      }
      if (g[i] < minG) minG = g[i];
    }
    if (allSite) continue;
    if (minG >= md2) {
      out.fill(maxDist, row, row + w);
      continue;
    }
    if (R >= w) {
      envelope(cov, w, mode, maxDist, md2, out, row, 0, w, 0, w);
      continue;
    }
    // Bounded distance: a pixel can be closer than maxDist + 2 only through a column with
    // g < md2 within R columns. Run the envelope only over windows of ±R around such pixels
    // (the deep interior and far exterior of large shapes are skipped entirely).
    let lastRel = -INF_I;
    for (let x = 0; x < w; x++) {
      if (g[row + x] < md2) lastRel = x;
      near[x] = x - lastRel;
    }
    lastRel = INF_I;
    for (let x = w - 1; x >= 0; x--) {
      if (g[row + x] < md2) lastRel = x;
      if (lastRel - x < near[x]) near[x] = lastRel - x;
    }
    let x = 0;
    while (x < w) {
      // Next candidate (non-site pixel with a relevant column in reach).
      while (x < w && (site[row + x] || near[x] > R)) {
        if (!site[row + x]) out[row + x] = maxDist;
        x++;
      }
      if (x >= w) break;
      const c0 = x;
      let c1 = x; // last candidate of this run of overlapping windows
      x++;
      while (x < w && x <= c1 + 2 * R + 1) {
        if (!site[row + x] && near[x] <= R) c1 = x;
        else if (!site[row + x]) out[row + x] = maxDist;
        x++;
      }
      const s0 = Math.max(0, c0 - R);
      const s1 = Math.min(w, c1 + R + 1);
      envelope(cov, w, mode, maxDist, md2, out, row, s0, s1, c0, c1 + 1);
      // Pixels in (c1, x) were non-candidates (already resolved); continue from x.
    }
  }
  return out;
}

const INF_I = 1 << 30;
let nearBuf = new Int32Array(0);
let near = nearBuf;

/**
 * 1D envelope over columns [s0, s1) of a row and final (sub-pixel corrected) distances for the
 * non-site pixels in [o0, o1) (whose ±R windows lie inside [s0, s1)).
 */
function envelope(cov: Uint8Array | Uint8ClampedArray, w: number, mode: 'outside' | 'inside', maxDist: number, md2: number, out: Float32Array, row: number, s0: number, s1: number, o0: number, o1: number) {
  const f = fBuf;
  const g = gBuf;
  const gy = gyBuf;
  const site = siteBuf;
  const len = s1 - s0;
  for (let k = 0; k < len; k++) f[k] = g[row + s0 + k];
  dt1d(len);
  for (let x = o0; x < o1; x++) {
    const i = row + x;
    if (site[i]) continue;
    const a = cov[i];
    const d2 = dBuf[x - s0];
    if (d2 >= md2) {
      out[i] = maxDist;
      continue;
    }
    const sx = argBuf[x - s0] + s0;
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
