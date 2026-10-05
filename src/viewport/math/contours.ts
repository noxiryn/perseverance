/**
 * Marching-squares contour extraction for selection masks (marching ants).
 *
 * Samples are taken at pixel centers; the iso-line at `threshold` is linearly interpolated so
 * binary masks produce contours exactly on pixel boundaries and soft (feathered / anti-aliased)
 * masks produce smooth sub-pixel outlines. Segments are oriented consistently (each edge point
 * has exactly one outgoing segment), so they chain into closed polylines that can be dashed
 * continuously.
 */

export interface MaskSource {
  /** Pixel data; the sample for pixel (x, y) is data[(y * width + x) * stride + offset]. */
  data: ArrayLike<number>;
  width: number;
  height: number;
  /** Bytes per pixel (4 for RGBA ImageData, 1 for a plain alpha array). */
  stride: number;
  /** Channel offset within a pixel (3 = alpha for RGBA). */
  offset: number;
  /** Position of this data's (0,0) in the output coordinate space (e.g. a sub-rect of the doc). */
  originX?: number;
  originY?: number;
}

/**
 * Oriented segment table: for each case, pairs of [fromEdge, toEdge].
 * Edge codes: 0 = top, 1 = right, 2 = bottom, 3 = left. Corner bits: tl=8, tr=4, br=2, bl=1.
 * Saddles (5, 10) are resolved separately using the cell center value.
 */
const T = 0,
  R = 1,
  B = 2,
  L = 3;
const TABLE: number[][] = [
  [], // 0
  [B, L], // 1
  [R, B], // 2
  [R, L], // 3
  [T, R], // 4
  [], // 5 saddle
  [T, B], // 6
  [T, L], // 7
  [L, T], // 8
  [B, T], // 9
  [], // 10 saddle
  [R, T], // 11
  [L, R], // 12
  [B, R], // 13
  [L, B], // 14
  [], // 15
];

/**
 * Trace iso-contours of a mask. Returns closed polylines as flat [x0, y0, x1, y1, …] arrays in
 * output coordinates (pixel-boundary space: a fully selected pixel (x, y) spans [x, x+1]).
 */
export function traceContours(src: MaskSource, threshold = 127.5, simplify = true): Float32Array[] {
  const { data, width: W, height: H, stride, offset } = src;
  const ox = src.originX ?? 0;
  const oy = src.originY ?? 0;
  if (W <= 0 || H <= 0) return [];
  // Sample grid with a 1-sample border of zeros so every contour closes.
  const GW = W + 2;
  const GH = H + 2;
  const vals = new Uint8Array(GW * GH);
  for (let y = 0; y < H; y++) {
    let si = (y * W) * stride + offset;
    let gi = (y + 1) * GW + 1;
    for (let x = 0; x < W; x++, si += stride, gi++) vals[gi] = data[si];
  }
  const thr = threshold;
  const nEdges = GW * GH * 2;
  const next = new Int32Array(nEdges).fill(-1);
  // Edges that start a segment, in scan order (typed + grown on demand: halftone masks have ~1M).
  let starts = new Int32Array(4096);
  let nStarts = 0;

  const H_ = (i: number, j: number) => (j * GW + i) * 2; // horizontal edge (i,j)-(i+1,j)
  const V_ = (i: number, j: number) => (j * GW + i) * 2 + 1; // vertical edge (i,j)-(i,j+1)

  const edgeId = (code: number, i: number, j: number) =>
    code === T ? H_(i, j) : code === B ? H_(i, j + 1) : code === L ? V_(i, j) : V_(i + 1, j);

  const link = (from: number, to: number) => {
    if (next[from] === -1) {
      if (nStarts === starts.length) {
        const grown = new Int32Array(starts.length * 2);
        grown.set(starts);
        starts = grown;
      }
      starts[nStarts++] = from;
    }
    next[from] = to;
  };

  for (let j = 0; j < GH - 1; j++) {
    const row = j * GW;
    for (let i = 0; i < GW - 1; i++) {
      const tl = vals[row + i];
      const tr = vals[row + i + 1];
      const bl = vals[row + GW + i];
      const br = vals[row + GW + i + 1];
      const c = (tl >= thr ? 8 : 0) | (tr >= thr ? 4 : 0) | (br >= thr ? 2 : 0) | (bl >= thr ? 1 : 0);
      if (c === 0 || c === 15) continue;
      if (c === 5 || c === 10) {
        const center = (tl + tr + bl + br) / 4 >= thr;
        if (c === 5) {
          if (center) {
            link(edgeId(T, i, j), edgeId(L, i, j));
            link(edgeId(B, i, j), edgeId(R, i, j));
          } else {
            link(edgeId(T, i, j), edgeId(R, i, j));
            link(edgeId(B, i, j), edgeId(L, i, j));
          }
        } else if (center) {
          link(edgeId(R, i, j), edgeId(T, i, j));
          link(edgeId(L, i, j), edgeId(B, i, j));
        } else {
          link(edgeId(L, i, j), edgeId(T, i, j));
          link(edgeId(R, i, j), edgeId(B, i, j));
        }
        continue;
      }
      const seg = TABLE[c];
      link(edgeId(seg[0], i, j), edgeId(seg[1], i, j));
    }
  }

  const visited = new Uint8Array(nEdges);
  const out: Float32Array[] = [];
  // Reusable point buffer for the polyline being traced.
  let pts = new Float64Array(1024);
  let n = 0;

  const pointOf = (e: number) => {
    const vertical = e & 1;
    const k = e >> 1;
    const i = k % GW;
    const j = (k / GW) | 0;
    const a = vals[k];
    const b = vertical ? vals[k + GW] : vals[k + 1];
    let t = a === b ? 0.5 : (thr - a) / (b - a);
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    // sample (i, j) sits at pixel center (i - 1 + 0.5, j - 1 + 0.5)
    const sx = i - 0.5 + ox;
    const sy = j - 0.5 + oy;
    if (n + 2 > pts.length) {
      const grown = new Float64Array(pts.length * 2);
      grown.set(pts);
      pts = grown;
    }
    if (vertical) {
      pts[n++] = sx;
      pts[n++] = sy + t;
    } else {
      pts[n++] = sx + t;
      pts[n++] = sy;
    }
  };

  for (let si = 0; si < nStarts; si++) {
    const s = starts[si];
    if (visited[s]) continue;
    n = 0;
    let cur = s;
    let guard = 0;
    while (cur >= 0 && !visited[cur] && guard++ < nEdges) {
      visited[cur] = 1;
      pointOf(cur);
      cur = next[cur];
    }
    if (n >= 6) out.push(simplify ? simplifyClosed(pts, 1e-3, n) : Float32Array.from(pts.subarray(0, n)));
  }
  return out;
}

/**
 * Remove collinear points from a closed polyline (keeps shape exactly for axis-aligned runs).
 * `len` = number of values of `pts` to use (default: all).
 */
export function simplifyClosed(pts: ArrayLike<number>, eps = 1e-3, len = pts.length): Float32Array {
  const n = len >> 1;
  const copy = () => {
    const c = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++) c[i] = pts[i];
    return c;
  };
  if (n <= 3) return copy();
  const out = new Float32Array(n * 2);
  let m = 0;
  for (let k = 0; k < n; k++) {
    const p = k === 0 ? n - 1 : k - 1;
    const q = k === n - 1 ? 0 : k + 1;
    const kx = pts[k * 2];
    const ky = pts[k * 2 + 1];
    const ax = kx - pts[p * 2];
    const ay = ky - pts[p * 2 + 1];
    const bx = pts[q * 2] - kx;
    const by = pts[q * 2 + 1] - ky;
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    const lens = Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by));
    if (Math.abs(cross) > eps * (lens > 1 ? lens : 1) || dot < 0) {
      out[m++] = kx;
      out[m++] = ky;
    }
  }
  if (m < 6) return copy();
  return m === out.length ? out : out.slice(0, m);
}

/** Signed area of a closed polyline (positive = clockwise in y-down screen space). */
export function polygonArea(pts: ArrayLike<number>): number {
  const n = pts.length / 2;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  return a / 2;
}
