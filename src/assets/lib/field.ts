/**
 * Low-resolution scalar noise fields. Expensive per-pixel noise is computed on a reduced grid
 * (≈ a few hundred thousand samples) and then up-scaled with smoothing by the generators, which
 * keeps every asset well under the 400 ms budget at 1920×1080.
 */
import { createNoise2D } from '../../core/noise';
import { newCanvas } from './util';

export interface FieldDims {
  fw: number;
  fh: number;
  /** field px per output px */
  s: number;
}

/** Working resolution for (w, h) with at most `maxPx` samples (never upscales). */
export function fieldDims(w: number, h: number, maxPx = 160_000): FieldDims {
  const s = Math.min(1, Math.sqrt(maxPx / Math.max(1, w * h)));
  return { fw: Math.max(2, Math.round(w * s)), fh: Math.max(2, Math.round(h * s)), s };
}

export type NoiseKind = 'fbm' | 'ridged' | 'billow';

export interface FieldOpts {
  seed: number;
  /** Feature frequency: noise periods per 1000 length units. */
  freq: number;
  octaves?: number;
  gain?: number;
  lacunarity?: number;
  kind?: NoiseKind;
  /** Domain-warp strength (in noise-space units, ~0..3). */
  warp?: number;
  /** Anisotropic stretch (e.g. stretchX = 4 → features elongated horizontally). */
  stretchX?: number;
  stretchY?: number;
  offsetX?: number;
  offsetY?: number;
}

/**
 * Noise sampled on an fw×fh grid. `unitPx` = field pixels per length unit (unit = 1px on a
 * 1000px short side, see unitOf). Output roughly in [-1, 1] (fbm/billow) or [0, 1] (ridged).
 */
export function noiseField(fw: number, fh: number, unitPx: number, o: FieldOpts): Float32Array {
  const out = new Float32Array(fw * fh);
  const n = createNoise2D(o.seed);
  const octaves = o.octaves ?? 5;
  const gain = o.gain ?? 0.5;
  const lac = o.lacunarity ?? 2;
  const kind = o.kind ?? 'fbm';
  const warp = o.warp ?? 0;
  const wn1 = warp ? createNoise2D(o.seed + 101) : null;
  const wn2 = warp ? createNoise2D(o.seed + 202) : null;
  const k = o.freq / 1000 / unitPx;
  const sx = k / (o.stretchX ?? 1);
  const sy = k / (o.stretchY ?? 1);
  const ox = o.offsetX ?? 0;
  const oy = o.offsetY ?? 0;
  let norm = 0;
  {
    let a = 1;
    for (let i = 0; i < octaves; i++) {
      norm += a;
      a *= gain;
    }
  }
  for (let j = 0; j < fh; j++) {
    for (let i = 0; i < fw; i++) {
      let x = i * sx + ox;
      let y = j * sy + oy;
      if (wn1 && wn2) {
        const wx = wn1(x * 0.9, y * 0.9) + 0.5 * wn1(x * 1.9 + 3.1, y * 1.9 + 7.7);
        const wy = wn2(x * 0.9, y * 0.9) + 0.5 * wn2(x * 1.9 + 5.3, y * 1.9 + 1.3);
        x += wx * warp;
        y += wy * warp;
      }
      let sum = 0;
      let amp = 1;
      let f = 1;
      if (kind === 'fbm') {
        for (let oc = 0; oc < octaves; oc++) {
          sum += amp * n(x * f + oc * 17.31, y * f - oc * 9.17);
          amp *= gain;
          f *= lac;
        }
        out[j * fw + i] = sum / norm;
      } else if (kind === 'billow') {
        for (let oc = 0; oc < octaves; oc++) {
          sum += amp * Math.abs(n(x * f + oc * 17.31, y * f - oc * 9.17));
          amp *= gain;
          f *= lac;
        }
        out[j * fw + i] = (sum / norm) * 2 - 1;
      } else {
        for (let oc = 0; oc < octaves; oc++) {
          const r = 1 - Math.abs(n(x * f + oc * 17.31, y * f - oc * 9.17));
          sum += amp * r * r;
          amp *= gain;
          f *= lac;
        }
        out[j * fw + i] = sum / norm;
      }
    }
  }
  return out;
}

/** Normalize a field in place to [0, 1]. */
export function normalizeField(f: Float32Array): Float32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const d = hi - lo || 1;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / d;
  return f;
}

/**
 * Turn a field into an RGBA canvas of the field size. `paint` writes the pixel for sample i
 * into `px` at offset o (4 bytes).
 */
export function paintField(
  fw: number,
  fh: number,
  paint: (i: number, x: number, y: number, px: Uint8ClampedArray, o: number) => void,
): HTMLCanvasElement {
  const [c, ctx] = newCanvas(fw, fh);
  const img = ctx.createImageData(fw, fh);
  const px = img.data;
  let i = 0;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++, i++) paint(i, x, y, px, i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------ */
/* Fast per-pixel grain                                                */
/* ------------------------------------------------------------------ */

const grainCache = new Map<string, HTMLCanvasElement>();

/**
 * Tileable per-pixel gray noise (mean 128) — cached. Drawn as a pattern for paper grain, film
 * grain, concrete pores… `soft` > 0 smooths it (clumpier grain).
 */
export function grainTile(seed: number, size = 256, soft = 0): HTMLCanvasElement {
  const key = `${seed}|${size}|${soft}`;
  const hit = grainCache.get(key);
  if (hit) return hit;
  const [c, ctx] = newCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  let s = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < d.length; i += 4) {
    // xorshift32, sum of two → triangular distribution (looks more like film grain than uniform)
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const a = (s >>> 0) & 255;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const b = (s >>> 0) & 255;
    const v = (a + b) >> 1;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  let out = c;
  if (soft > 0) {
    // Blur with wrap-around by drawing a 3×3 tiled copy.
    const [big, bctx] = newCanvas(size * 3, size * 3);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) bctx.drawImage(c, x * size, y * size);
    const [o2, octx] = newCanvas(size, size);
    octx.filter = `blur(${soft}px)`;
    octx.drawImage(big, -size, -size);
    octx.filter = 'none';
    // Restore contrast lost by blurring.
    const id = octx.getImageData(0, 0, size, size);
    const dd = id.data;
    const gainK = 1 + soft * 1.6;
    for (let i = 0; i < dd.length; i += 4) {
      const v = 128 + (dd[i] - 128) * gainK;
      dd[i] = dd[i + 1] = dd[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    octx.putImageData(id, 0, 0);
    out = o2;
  }
  grainCache.set(key, out);
  return out;
}

/**
 * Cover (w, h) with a grain tile pattern using the current composite/alpha of ctx.
 * `scale` enlarges the grain; a random offset avoids identical alignment between layers.
 */
export function fillGrain(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, scale = 1, soft = 0) {
  // A handful of tiles per softness serve every seed (the seed picks one of them plus a random
  // offset and quarter turn): building a fresh tile per seed made every new seed pay for a
  // 256² noise + blur pass and let the tile cache grow without bound.
  const hsh = grainHash(seed);
  const tile = grainTile(GRAIN_VARIANT_SEEDS[hsh & 3], 256, soft);
  const pat = ctx.createPattern(tile, 'repeat');
  if (!pat) return;
  pat.setTransform(
    new DOMMatrix()
      .translate((hsh >>> 4) & 255, (hsh >>> 12) & 255)
      .rotate(((hsh >>> 2) & 3) * 90)
      .scale(scale),
  );
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
}

const GRAIN_VARIANT_SEEDS = [11, 23, 37, 53];

/** 32-bit integer hash of a seed (any number). Pure. */
export function grainHash(seed: number): number {
  let x = Math.imul((Math.round(seed) | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}
