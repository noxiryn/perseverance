/**
 * Halftone screening core (shared by halftone, comic dots, newsprint, risograph, screen print).
 *
 * Each screen is a rotated, document-anchored grid of cells. The tone of a cell is sampled at the
 * cell center from a pre-blurred "darkness" plane, converted to a spot threshold through a
 * per-shape coverage LUT (so ink area == requested coverage for every shape), and the spot
 * boundary is anti-aliased in pixel space.
 */
import { clamp } from './util';

export type SpotShape = 'dot' | 'line' | 'square' | 'cross' | 'diamond' | 'ellipse';

export const SPOT_SHAPES: { value: SpotShape; label: string }[] = [
  { value: 'dot', label: 'Dot' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'square', label: 'Square' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'line', label: 'Line' },
  { value: 'cross', label: 'Cross' },
];

const SHAPE_ID: Record<SpotShape, number> = { dot: 0, line: 1, square: 2, cross: 3, diamond: 4, ellipse: 5 };
/** Approximate |∇m| per shape (cell units) for pixel-space anti-aliasing. */
const SHAPE_GRAD = [1, 1, 1, 2, 1.414, 1.1];

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

interface SpotLUT {
  id: number;
  lut: Float32Array;
  tMax: number;
  g: number;
}

const LUT_N = 1024;
const lutCache = new Map<number, SpotLUT>();

/** Coverage → threshold table, computed by sorting the metric over a fine sampling of a cell. */
export function spotLUT(shape: SpotShape): SpotLUT {
  const id = SHAPE_ID[shape] ?? 0;
  const cached = lutCache.get(id);
  if (cached) return cached;
  const N = 96;
  const vals = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) vals[j * N + i] = metric(id, (i + 0.5) / N - 0.5, (j + 0.5) / N - 0.5);
  vals.sort();
  const lut = new Float32Array(LUT_N + 1);
  for (let k = 0; k <= LUT_N; k++) {
    const q = (k / LUT_N) * (vals.length - 1);
    const i0 = Math.floor(q);
    const i1 = Math.min(vals.length - 1, i0 + 1);
    lut[k] = vals[i0] + (vals[i1] - vals[i0]) * (q - i0);
  }
  lut[0] = 0;
  const res = { id, lut, tMax: vals[vals.length - 1], g: SHAPE_GRAD[id] };
  lutCache.set(id, res);
  return res;
}

export interface ScreenParams {
  /** Cell size in image px. */
  cell: number;
  /** Screen angle in degrees. */
  angle: number;
  shape: SpotShape;
  /** Document anchor (image px) — see util.anchor. */
  ax: number;
  ay: number;
  /** Contrast factor applied to coverage around 0.5. */
  contrast?: number;
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

/** Blur sigma (image px) for the tone plane feeding a screen of cell size S. */
export function toneSigma(cell: number): number {
  return clamp(cell * 0.33, 0, 60);
}
