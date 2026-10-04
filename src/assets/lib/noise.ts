/**
 * Fast seeded 2D simplex noise for the asset generators (flat typed-array gradient tables, no
 * per-call allocation) plus fbm / ridged helpers. Output of `simplex` is roughly in [-1, 1].
 * Pure and deterministic for a given seed (unit tested).
 */
import { rng } from '../../core/noise';

export type Noise2 = (x: number, y: number) => number;

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** Seeded simplex noise. */
export function simplex(seed: number): Noise2 {
  const rand = rng((Math.floor(seed) * 2654435761 + 0x5bd1e995) >>> 0);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint16Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  // 12 gradient directions evenly spread on the circle
  const gx = new Float32Array(512);
  const gy = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    const a = ((perm[i] % 12) / 12) * Math.PI * 2 + 0.13;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  return (xin: number, yin: number) => {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1 = 0;
    let j1 = 1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = perm[ii + perm[jj]];
      t0 *= t0;
      n += t0 * t0 * (gx[g] * x0 + gy[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = perm[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n += t1 * t1 * (gx[g] * x1 + gy[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = perm[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n += t2 * t2 * (gx[g] * x2 + gy[g] * y2);
    }
    return 70 * n;
  };
}

/** Fractal sum of `octaves` noise layers, normalized to roughly [-1, 1]. */
export function fbm2(n: Noise2, x: number, y: number, octaves: number, gain = 0.5, lac = 2.03): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * n(x * f + o * 19.19, y * f - o * 7.37);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}

/** Ridged multifractal-ish sum in [0, 1]: sharp crests where the noise crosses zero. */
export function ridged2(n: Noise2, x: number, y: number, octaves: number, gain = 0.5, lac = 2.03): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const r = 1 - Math.abs(n(x * f + o * 19.19, y * f - o * 7.37));
    sum += amp * r * r;
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}

/**
 * Separable box blur of a scalar field in place (`passes` box passes ≈ gaussian).
 * Radius in field pixels. Edges clamp.
 */
export function blurField(f: Float32Array, w: number, h: number, radius: number, passes = 2): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r < 1) return f;
  const tmp = new Float32Array(Math.max(w, h));
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += f[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[x] = acc * inv;
        acc += f[row + Math.min(w - 1, x + r + 1)] - f[row + Math.max(0, x - r)];
      }
      for (let x = 0; x < w; x++) f[row + x] = tmp[x];
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += f[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        tmp[y] = acc * inv;
        acc += f[Math.min(h - 1, y + r + 1) * w + x] - f[Math.max(0, y - r) * w + x];
      }
      for (let y = 0; y < h; y++) f[y * w + x] = tmp[y];
    }
  }
  return f;
}

const grainFields = new Map<string, Float32Array>();

/**
 * Tileable clumpy white noise (size×size, values ≈ 0..1, mean 0.5) for per-pixel speckle and
 * dissolve effects. `blur` (px) controls clump size. Cached per (seed, size, blur).
 */
export function grainField(seed: number, size = 256, blur = 1): Float32Array {
  const key = `${seed}|${size}|${blur}`;
  const hit = grainFields.get(key);
  if (hit) return hit;
  const n = size * size;
  const f = new Float32Array(n);
  let s = (Math.floor(seed) * 2654435761 + 12345) >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    f[i] = (s >>> 0) / 4294967296;
  }
  if (blur > 0) {
    // wrap-around box blur (keeps the tile seamless)
    const r = Math.max(1, Math.round(blur));
    const tmp = new Float32Array(size);
    const inv = 1 / (2 * r + 1);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < size; y++) {
        const row = y * size;
        for (let x = 0; x < size; x++) {
          let acc = 0;
          for (let k = -r; k <= r; k++) acc += f[row + ((x + k + size) % size)];
          tmp[x] = acc * inv;
        }
        f.set(tmp, row);
      }
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          let acc = 0;
          for (let k = -r; k <= r; k++) acc += f[((y + k + size) % size) * size + x];
          tmp[y] = acc * inv;
        }
        for (let y = 0; y < size; y++) f[y * size + x] = tmp[y];
      }
    }
    // restore contrast: normalize to mean 0.5, sd ≈ 0.2
    let mean = 0;
    for (let i = 0; i < n; i++) mean += f[i];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (f[i] - mean) ** 2;
    const sd = Math.sqrt(v / n) || 1;
    for (let i = 0; i < n; i++) {
      const t = 0.5 + ((f[i] - mean) / sd) * 0.2;
      f[i] = t < 0 ? 0 : t > 1 ? 1 : t;
    }
  }
  grainFields.set(key, f);
  return f;
}
