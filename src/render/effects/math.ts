/**
 * Pure per-pixel math for effects that need exact geometry (no DOM, unit-tested):
 * crisp strokes from a Euclidean distance transform, faded long shadows, bevel shading.
 * All maps are row-major, `w × h`, 8-bit coverage (0..255) unless noted.
 */
import { edgeDistance } from '../distance';

export type StrokePosition = 'outside' | 'inside' | 'center';

/**
 * Distance field provider for a `w × h` matte: (mode, maxDist) → per-pixel distance to the
 * matte edge, exact below `maxDist`. The compositor passes cached fields; by default they are
 * computed from the matte.
 */
export type DistanceSource = (mode: 'outside' | 'inside', maxDist: number) => Float32Array;

function directSource(a: Uint8Array | Uint8ClampedArray, w: number, h: number): DistanceSource {
  return (mode, maxDist) => edgeDistance(a, w, h, mode, maxDist);
}

const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Stroke coverage for a matte.
 *  - outside: the matte dilated by `size` (interior included; the content is drawn over it)
 *  - inside: a band of `size` px inside the edge (to be clipped by the content alpha)
 *  - center: a band of `size` px centered on the edge (not clipped)
 * Anti-aliased (sub-pixel accurate distances), round joins.
 */
export function strokeCoverage(
  a: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  size: number,
  position: StrokePosition,
  dist: DistanceSource = directSource(a, w, h),
): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n);
  if (!(size > 0) || !n) return out;
  // coverage = clamp(size + .5 − d) — written as tight branches (hot loop over every pixel).
  const lim = size + 0.5;
  if (position === 'outside') {
    const d = dist('outside', size + 2);
    for (let i = 0; i < n; i++) {
      if (a[i] >= 128) {
        out[i] = 255;
        continue;
      }
      const v = lim - d[i];
      if (v <= 0) continue;
      out[i] = v >= 1 ? 255 : (v * 255 + 0.5) | 0;
    }
  } else if (position === 'inside') {
    const d = dist('inside', size + 2);
    for (let i = 0; i < n; i++) {
      const ai = a[i];
      if (ai < 128) {
        if (ai > 0) out[i] = 255;
        continue;
      }
      const v = lim - d[i];
      if (v <= 0) continue;
      out[i] = v >= 1 ? 255 : (v * 255 + 0.5) | 0;
    }
  } else {
    const half = size / 2;
    const hl = half + 0.5;
    const dOut = dist('outside', half + 2);
    const dIn = dist('inside', half + 2);
    for (let i = 0; i < n; i++) {
      const v = hl - (a[i] >= 128 ? dIn[i] : dOut[i]);
      if (v <= 0) continue;
      out[i] = v >= 1 ? 255 : (v * 255 + 0.5) | 0;
    }
  }
  return out;
}

/**
 * Long shadow with a linear fade: V(p) = max(cov(p), V(p − step) − Δ), marching along the
 * shadow direction (dx, dy unit vector) so that the shadow fades to 0 after `length` px.
 */
export function longShadowFade(a: Uint8Array | Uint8ClampedArray, w: number, h: number, dx: number, dy: number, length: number): Uint8Array {
  const n = w * h;
  const V = new Float32Array(n);
  const L = Math.max(1, length);
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx >= 0 ? 1 : -1;
    const slope = dy / Math.max(1e-9, Math.abs(dx));
    const delta = 1 / Math.max(1e-9, Math.abs(dx)) / L;
    for (let xi = 0; xi < w; xi++) {
      const x = sx > 0 ? xi : w - 1 - xi;
      const pxx = x - sx;
      const hasPrev = pxx >= 0 && pxx < w;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        let v = a[i] / 255;
        if (hasPrev) {
          const py = y - slope;
          const y0 = Math.floor(py);
          const f = py - y0;
          const v0 = y0 >= 0 && y0 < h ? V[y0 * w + pxx] : 0;
          const v1 = y0 + 1 >= 0 && y0 + 1 < h ? V[(y0 + 1) * w + pxx] : 0;
          const pv = v0 + (v1 - v0) * f - delta;
          if (pv > v) v = pv;
        }
        V[i] = v;
      }
    }
  } else {
    const sy = dy >= 0 ? 1 : -1;
    const slope = dx / Math.max(1e-9, Math.abs(dy));
    const delta = 1 / Math.max(1e-9, Math.abs(dy)) / L;
    for (let yi = 0; yi < h; yi++) {
      const y = sy > 0 ? yi : h - 1 - yi;
      const pyy = y - sy;
      const hasPrev = pyy >= 0 && pyy < h;
      const row = y * w;
      const prow = pyy * w;
      for (let x = 0; x < w; x++) {
        let v = a[row + x] / 255;
        if (hasPrev) {
          const pxf = x - slope;
          const x0 = Math.floor(pxf);
          const f = pxf - x0;
          const v0 = x0 >= 0 && x0 < w ? V[prow + x0] : 0;
          const v1 = x0 + 1 >= 0 && x0 + 1 < w ? V[prow + x0 + 1] : 0;
          const pv = v0 + (v1 - v0) * f - delta;
          if (pv > v) v = pv;
        }
        V[row + x] = v;
      }
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(c01(V[i]) * 255);
  return out;
}

export interface BevelOptions {
  /** Bevel width in px. */
  size: number;
  /** Depth multiplier (1 = 100%). */
  depth: number;
  /** Light angle (deg, Photoshop convention: 120 = top-left). */
  angle: number;
  /** Light altitude (deg, 0..90). */
  altitude: number;
  style: 'inner' | 'emboss';
  /** Height map blur (px). */
  soften: number;
}

/** Height profile ("smooth" bevel): 0 at the edge → `size` at full depth, rounded. */
export function bevelProfile(t: number): number {
  const u = c01(t);
  return 1 - (1 - u) * (1 - u);
}

/** Lambert shading split into highlight / shadow intensities (0..1) for a surface normal. */
export function shadeSplit(nx: number, ny: number, lx: number, ly: number, lz: number): [number, number] {
  const len = Math.sqrt(nx * nx + ny * ny + 1);
  const s = (nx * lx + ny * ly + lz) / len;
  const flat = lz;
  if (s > flat) return [flat < 1 ? (s - flat) / (1 - flat) : 0, 0];
  return [0, flat > 0 ? Math.min(1, (flat - s) / flat) : 0];
}

/**
 * Separable 3-pass box blur (≈ gaussian) of a float field with clamped edges, in place. Same
 * result as core `blurChannel`, but the vertical pass walks rows (cache friendly) instead of
 * columns, which is several times faster on large fields.
 */
export function blurField(buf: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  if (!w || !h) return buf;
  const tmp = new Float32Array(buf.length);
  const acc = new Float64Array(w);
  const inv = 1 / (r + r + 1);
  for (let pass = 0; pass < 3; pass++) {
    // rows: buf → tmp
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let val = r * buf[row];
      for (let j = 0; j < r; j++) val += buf[row + (j < w ? j : w - 1)];
      for (let x = 0; x < w; x++) {
        const xa = x + r;
        val += buf[row + (xa < w ? xa : w - 1)];
        tmp[row + x] = val * inv;
        const xs = x - r;
        val -= buf[row + (xs > 0 ? xs : 0)];
      }
    }
    // columns, row by row: tmp → buf
    for (let x = 0; x < w; x++) acc[x] = r * tmp[x];
    for (let j = 0; j < r; j++) {
      const row = (j < h ? j : h - 1) * w;
      for (let x = 0; x < w; x++) acc[x] += tmp[row + x];
    }
    for (let y = 0; y < h; y++) {
      const ya = y + r;
      const add = (ya < h ? ya : h - 1) * w;
      const ys = y - r;
      const sub = (ys > 0 ? ys : 0) * w;
      const out = y * w;
      for (let x = 0; x < w; x++) {
        const v = acc[x] + tmp[add + x];
        buf[out + x] = v * inv;
        acc[x] = v - tmp[sub + x];
      }
    }
  }
  return buf;
}

/**
 * Bevel highlight / shadow maps (0..255 including coverage). For 'inner' the maps must be clipped
 * to the content alpha by the caller; 'emboss' extends half the size outside the shape.
 */
export function bevelMaps(
  a: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  o: BevelOptions,
  dist: DistanceSource = directSource(a, w, h),
): { hi: Uint8Array; sh: Uint8Array } {
  const n = w * h;
  const hi = new Uint8Array(n);
  const sh = new Uint8Array(n);
  const size = Math.max(0.5, o.size);
  if (!n) return { hi, sh };
  const H = new Float32Array(n);
  const emboss = o.style === 'emboss';
  let cov: Float32Array | null = null;
  if (emboss) {
    cov = new Float32Array(n);
    const half = size / 2;
    const dIn = dist('inside', half + 2);
    const dOut = dist('outside', half + 2);
    for (let i = 0; i < n; i++) {
      const inside = a[i] >= 128;
      const sd = inside ? dIn[i] : -dOut[i];
      H[i] = size * bevelProfile((sd + half) / size);
      cov[i] = inside ? 1 : c01(half + 0.5 - dOut[i]);
    }
  } else {
    const dIn = dist('inside', size + 2);
    const inv = 1 / size;
    for (let i = 0; i < n; i++) {
      if (a[i] < 128) continue;
      // inlined bevelProfile: 1 − (1 − u)²
      let u = dIn[i] * inv;
      if (u > 1) u = 1;
      const m = 1 - u;
      H[i] = size * (1 - m * m);
    }
  }
  // A distance field has pixel-level noise along curved/diagonal edges; differentiating it
  // shows up as ridges across the bevel slope. A light intrinsic blur (≈ Photoshop "Smooth")
  // removes them; `soften` adds on top.
  const smooth = Math.min(4, Math.max(1, Math.round(size / 6)));
  blurField(H, w, h, smooth + (o.soften > 0.5 ? o.soften : 0));
  const DEG = Math.PI / 180;
  const alt = Math.max(0, Math.min(90, o.altitude)) * DEG;
  const lx = Math.cos(o.angle * DEG) * Math.cos(alt);
  const ly = -Math.sin(o.angle * DEG) * Math.cos(alt);
  const lz = Math.sin(alt);
  const D = Math.max(0, o.depth);
  // Shading (inlined shadeSplit — no per-pixel allocation): the surface normal is (−∇H·D, 1).
  const flat = lz;
  const hiK = flat < 1 ? 255 / (1 - flat) : 0;
  const shK = flat > 0 ? 255 / flat : 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = y > 0 ? row - w : row;
    const dn = y < h - 1 ? row + w : row;
    const fy = y > 0 && y < h - 1 ? 0.5 : 1;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const c = cov ? cov[i] : 1;
      if (c <= 0) continue;
      const l = x > 0 ? i - 1 : i;
      const r = x < w - 1 ? i + 1 : i;
      const fx = x > 0 && x < w - 1 ? 0.5 : 1;
      const gx = (H[r] - H[l]) * fx;
      const gy = (H[dn + x] - H[up + x]) * fy;
      if (gx === 0 && gy === 0) continue;
      const nx = -gx * D;
      const ny = -gy * D;
      const sdot = (nx * lx + ny * ly + lz) / Math.sqrt(nx * nx + ny * ny + 1);
      if (sdot > flat) {
        let v = (sdot - flat) * hiK;
        if (v > 255) v = 255;
        hi[i] = (v * c + 0.5) | 0;
      } else {
        let v = (flat - sdot) * shK;
        if (v > 255) v = 255;
        sh[i] = (v * c + 0.5) | 0;
      }
    }
  }
  return { hi, sh };
}
