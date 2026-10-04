/**
 * Software triangle-mesh image warp (pure, no DOM — unit-tested).
 *
 * A regular grid over the SOURCE image is mapped to arbitrary DESTINATION node positions. Each
 * grid cell is split into two triangles; inside a triangle the destination → source mapping is
 * an exact affine map, so every destination pixel center is inverse-mapped and bilinearly sampled
 * (premultiplied, so transparent texels never darken edges). Neighbouring triangles share their
 * vertices exactly, which makes the result seamless — unlike drawing each cell with a canvas
 * affine transform, where per-cell anti-aliasing leaves hairline cracks.
 *
 * Pixel convention: pixel (i, j) covers [i, i+1) × [j, j+1); its center is (i + .5, j + .5).
 */

export interface WarpGrid {
  /** Number of cells across / down. Node (i, j) sits at source (i·srcW/cols, j·srcH/rows). */
  cols: number;
  rows: number;
  /** Destination node positions (destination px), (cols + 1) × (rows + 1), row-major. */
  dx: Float64Array;
  dy: Float64Array;
}

/** Edge tolerance in barycentric units: shared edges may be sampled twice (same value), never zero times. */
const EPS = 1e-7;

/**
 * Warp `src` (sw × sh RGBA, straight alpha) into `dst` (dw × dh RGBA, straight alpha, assumed
 * cleared). Pixels not covered by the mesh are left untouched.
 */
export function warpImage(src: Uint8ClampedArray, sw: number, sh: number, dst: Uint8ClampedArray, dw: number, dh: number, grid: WarpGrid): void {
  const { cols, rows, dx, dy } = grid;
  const stride = cols + 1;
  const cw = sw / cols;
  const ch = sh / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const n00 = j * stride + i;
      const n10 = n00 + 1;
      const n01 = n00 + stride;
      const n11 = n01 + 1;
      const u0 = i * cw;
      const u1 = (i + 1) * cw;
      const v0 = j * ch;
      const v1 = (j + 1) * ch;
      // Two triangles per cell: (00, 10, 11) and (00, 11, 01).
      fillTriangle(src, sw, sh, dst, dw, dh, dx[n00], dy[n00], u0, v0, dx[n10], dy[n10], u1, v0, dx[n11], dy[n11], u1, v1);
      fillTriangle(src, sw, sh, dst, dw, dh, dx[n00], dy[n00], u0, v0, dx[n11], dy[n11], u1, v1, dx[n01], dy[n01], u0, v1);
    }
  }
}

function fillTriangle(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dst: Uint8ClampedArray,
  dw: number,
  dh: number,
  x0: number,
  y0: number,
  u0: number,
  v0: number,
  x1: number,
  y1: number,
  u1: number,
  v1: number,
  x2: number,
  y2: number,
  u2: number,
  v2: number,
) {
  const ex1 = x1 - x0;
  const ey1 = y1 - y0;
  const ex2 = x2 - x0;
  const ey2 = y2 - y0;
  const det = ex1 * ey2 - ex2 * ey1;
  if (!(Math.abs(det) > 1e-12)) return;
  const inv = 1 / det;
  // Barycentric (b1, b2) of a destination point: b1 = (ey2·(x−x0) − ex2·(y−y0)) / det, …
  const b1x = ey2 * inv;
  const b1y = -ex2 * inv;
  const b2x = -ey1 * inv;
  const b2y = ex1 * inv;
  const du1 = u1 - u0;
  const du2 = u2 - u0;
  const dv1 = v1 - v0;
  const dv2 = v2 - v0;
  const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
  const maxX = Math.min(dw - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
  const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
  const maxY = Math.min(dh - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
  if (maxX < minX || maxY < minY) return;
  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5 - y0;
    const cx0 = minX + 0.5 - x0;
    let b1 = b1x * cx0 + b1y * cy;
    let b2 = b2x * cx0 + b2y * cy;
    let o = (py * dw + minX) * 4;
    for (let px = minX; px <= maxX; px++, b1 += b1x, b2 += b2x, o += 4) {
      if (b1 < -EPS || b2 < -EPS || b1 + b2 > 1 + EPS) continue;
      const u = u0 + b1 * du1 + b2 * du2;
      const v = v0 + b1 * dv1 + b2 * dv2;
      sampleInto(src, sw, sh, u, v, dst, o);
    }
  }
}

/** Bilinear premultiplied sample of `src` at (u, v) (source px, pixel centers at +.5) → dst[o..o+3]. */
function sampleInto(src: Uint8ClampedArray, sw: number, sh: number, u: number, v: number, dst: Uint8ClampedArray, o: number) {
  const fx = u - 0.5;
  const fy = v - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  let a = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let k = 0; k < 4; k++) {
    const sx = ix + (k & 1);
    const sy = iy + (k >> 1);
    if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
    const w = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty);
    if (w <= 0) continue;
    const s = (sy * sw + sx) * 4;
    const sa = src[s + 3];
    if (sa === 0) continue;
    const wa = w * sa;
    a += wa;
    r += wa * src[s];
    g += wa * src[s + 1];
    b += wa * src[s + 2];
  }
  if (a <= 0.5) {
    dst[o + 3] = 0;
    return;
  }
  dst[o] = r / a;
  dst[o + 1] = g / a;
  dst[o + 2] = b / a;
  dst[o + 3] = a;
}

/** Build a grid for a source of sw × sh px with a mapping source px → destination px. */
export function buildGrid(sw: number, sh: number, cols: number, rows: number, map: (sx: number, sy: number) => [number, number]): WarpGrid {
  const n = (cols + 1) * (rows + 1);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const [X, Y] = map((i * sw) / cols, (j * sh) / rows);
      dx[j * (cols + 1) + i] = X;
      dy[j * (cols + 1) + i] = Y;
    }
  }
  return { cols, rows, dx, dy };
}
