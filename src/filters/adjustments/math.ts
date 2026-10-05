/**
 * Pure pixel math shared by the adjustment filters. Everything works on plain
 * `{ data, width, height }` objects (no canvas needed → unit-testable in jsdom).
 * Conventions: RGBA non-premultiplied, alpha is always preserved, pixels with alpha 0 are skipped.
 */
import { parseColor } from '../../core/color';

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type Lut = Uint8ClampedArray;

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Rec.601 luma (what Photoshop uses for luminosity-based adjustments), 0..255 float. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function identityLut(): Lut {
  const l = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) l[i] = i;
  return l;
}

/** Build a 256-entry LUT from a function mapping 0..1 → 0..1 (rounded, clamped). */
export function buildLut(fn: (v: number) => number): Lut {
  const l = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const v = fn(i / 255);
    l[i] = Number.isFinite(v) ? Math.round(clamp01(v) * 255) : i;
  }
  return l;
}

export function isIdentityLut(l: ArrayLike<number>): boolean {
  for (let i = 0; i < 256; i++) if (l[i] !== i) return false;
  return true;
}

/** `second(first(x))` as one LUT. */
export function composeLut(first: ArrayLike<number>, second: ArrayLike<number>): Lut {
  const l = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) l[i] = second[first[i]];
  return l;
}

/* ---------------- whole-pixel (32-bit) access ---------------- */

/** True on little-endian hosts (every platform Electron ships on): RGBA bytes = r | g<<8 | b<<16 | a<<24. */
export const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Alpha byte of a little-endian pixel word (as a signed 32-bit mask). */
export const ALPHA_MASK = -16777216; // 0xff000000 | 0

/**
 * The pixels as little-endian 32-bit words (one load/store per pixel instead of four), or null
 * when that view isn't possible (big-endian host, unaligned buffer) — callers then fall back to
 * byte access. Int32 (not Uint32) so V8 keeps the values in integer registers.
 */
export function pixelWords(img: Pixels): Int32Array | null {
  const d = img.data;
  if (!LITTLE_ENDIAN || d.byteOffset & 3 || d.length & 3) return null;
  return new Int32Array(d.buffer, d.byteOffset, d.length >> 2);
}

/**
 * The pixels as little-endian words (r | g << 8 | b << 16 | a << 24) for READING: the live buffer
 * when it can be viewed that way, else a decoded copy (unaligned buffer / big-endian host) — so
 * loops that read words and write their results through `img.data` work everywhere. Word reads
 * have no per-channel bounds checks and give a cheap "same pixel as before" test.
 */
export function readWords(img: Pixels): Int32Array {
  const u = pixelWords(img);
  if (u) return u;
  const d = img.data;
  const n = d.length >> 2;
  const out = new Int32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = d[j] | (d[j + 1] << 8) | (d[j + 2] << 16) | (d[j + 3] << 24);
  return out;
}

/**
 * Persistent per-color result memo for the costlier adjustments whose output only depends on the
 * pixel's color (rgb → resulting rgb, both packed r | g << 8 | b << 16). Direct mapped, 2¹⁸
 * slots (slot = imul(rgb, 0x9e3779b1) >>> MEMO_SHIFT, ×2 = index of its key), so a rendered thumbnail's ≈ 90k distinct
 * colors mostly fit. A memo belongs to one filter + parameter set (`sig`) and survives between
 * calls: re-rendering an unchanged adjustment layer (live painting below it, thumbnails, region
 * updates) is almost only lookups; a parameter change starts a fresh memo. The few most recent
 * memos are kept (LRU), so several adjustment layers don't evict each other.
 *
 * Noisy images (photos, grain: nearly every pixel a new color) would only pay for the random
 * memory traffic (measured ~1.5-2× slower), so a call stops using the memo when, checked every
 * MEMO_PROBE (a power of two) misses, it has had fewer hits than misses; what was stored stays valid.
 */
export const MEMO_BITS = 18;
export const MEMO_SHIFT = 32 - MEMO_BITS;
export const MEMO_PROBE = 16384;
const MEMO_MAX = 4;
export interface ColorMemo {
  sig: string;
  /**
   * Slot k: entries[2k] = rgb of the cached color (−1 = empty), entries[2k + 1] = its result —
   * interleaved, so a lookup touches one cache line.
   */
  entries: Int32Array;
}
const memos: ColorMemo[] = [];
export function colorMemo(sig: string): ColorMemo {
  for (let k = 0; k < memos.length; k++) {
    const m = memos[k];
    if (m.sig !== sig) continue;
    if (k > 0) {
      memos.splice(k, 1);
      memos.unshift(m);
    }
    return m;
  }
  let m: ColorMemo;
  if (memos.length >= MEMO_MAX) {
    m = memos.pop()!;
    m.sig = sig;
    m.entries.fill(-1);
  } else m = { sig, entries: new Int32Array(2 << MEMO_BITS).fill(-1) };
  memos.unshift(m);
  return m;
}

/** A LUT as plain bytes, rounded/clamped exactly like a byte store of each entry. */
export function toByteLut(l: ArrayLike<number>): Uint8Array {
  const q = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) q[v] = l[v];
  return new Uint8Array(q.buffer);
}

/** Apply per-channel LUTs in place (alpha preserved, transparent pixels skipped). */
export function applyLuts(img: Pixels, r: ArrayLike<number>, g: ArrayLike<number> = r, b: ArrayLike<number> = r): void {
  const u = pixelWords(img);
  if (u) {
    // One word load, three byte-table loads, one word store per pixel.
    const R = toByteLut(r),
      G = g === r ? R : toByteLut(g),
      B = b === r ? R : b === g ? G : toByteLut(b);
    for (let i = 0, n = u.length; i < n; i++) {
      const p = u[i];
      const a = p >>> 24;
      if (a === 0) continue;
      u[i] = (a << 24) | (B[(p >> 16) & 255] << 16) | (G[(p >> 8) & 255] << 8) | R[p & 255];
    }
    return;
  }
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = r[d[i]];
    d[i + 1] = g[d[i + 1]];
    d[i + 2] = b[d[i + 2]];
  }
}

/* ---------------- tone curves used by several adjustments ---------------- */

/** Endpoint-preserving S-curve around 0.5. k > 1 adds contrast, k = 1 is identity. */
export function sCurve(v: number, k: number): number {
  if (k === 1) return v;
  return v < 0.5 ? 0.5 * Math.pow(2 * v, k) : 1 - 0.5 * Math.pow(2 * (1 - v), k);
}

/** Photoshop-style Levels mapping for one value (0..255 in, 0..255 float out). */
export function levelsValue(x: number, inBlack: number, inWhite: number, gamma: number, outBlack: number, outWhite: number): number {
  const span = Math.max(1, inWhite - inBlack);
  let v = (x - inBlack) / span;
  v = v <= 0 ? 0 : v >= 1 ? 1 : v;
  if (gamma !== 1) v = Math.pow(v, 1 / gamma);
  return outBlack + v * (outWhite - outBlack);
}

export function levelsLut(inBlack: number, inWhite: number, gamma: number, outBlack: number, outWhite: number): Lut {
  const l = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) l[i] = Math.round(levelsValue(i, inBlack, inWhite, gamma, outBlack, outWhite));
  return l;
}

/** sRGB transfer functions (0..1). */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/* ---------------- HSL helpers (scratch-array based: no per-pixel allocations) ---------------- */

/** r,g,b 0..255 → out[0]=h (0..360), out[1]=s (0..1), out[2]=l (0..1). */
export function rgbToHslInto(r: number, g: number, b: number, out: Float64Array): void {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  out[0] = h;
  out[1] = s;
  out[2] = l;
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** h 0..360, s,l 0..1 → out[0..2] = r,g,b 0..255 (float). */
export function hslToRgbInto(h: number, s: number, l: number, out: Float64Array): void {
  if (s <= 0) {
    const v = l * 255;
    out[0] = v;
    out[1] = v;
    out[2] = v;
    return;
  }
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hue2rgb(p, q, hh + 1 / 3) * 255;
  out[1] = hue2rgb(p, q, hh) * 255;
  out[2] = hue2rgb(p, q, hh - 1 / 3) * 255;
}

/* ---------------- W3C non-separable blend helpers (0..1 floats) ---------------- */

export function lum3(r: number, g: number, b: number): number {
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

/** SetLum + ClipColor from the W3C compositing spec. Writes into out. */
export function setLumInto(r: number, g: number, b: number, l: number, out: Float64Array): void {
  const d = l - lum3(r, g, b);
  r += d;
  g += d;
  b += d;
  const L = lum3(r, g, b);
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  if (n < 0) {
    const k = L / (L - n || 1);
    r = L + (r - L) * k;
    g = L + (g - L) * k;
    b = L + (b - L) * k;
  }
  if (x > 1) {
    const k = (1 - L) / (x - L || 1);
    r = L + (r - L) * k;
    g = L + (g - L) * k;
    b = L + (b - L) * k;
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
}

/** SetSat from the W3C compositing spec. Writes into out. */
export function setSatInto(r: number, g: number, b: number, s: number, out: Float64Array): void {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const range = max - min;
  const f = (c: number) => (range > 0 ? ((c - min) * s) / range : 0);
  out[0] = f(r);
  out[1] = f(g);
  out[2] = f(b);
}

/* ---------------- colors & gradients ---------------- */

export function rgbOf(color: string): [number, number, number] {
  const c = parseColor(color || '#000000');
  return [c.r, c.g, c.b];
}

/**
 * High-resolution float gradient LUT: `size` entries of [r,g,b (0..255), a (0..1)].
 * Stops may carry alpha ('#rrggbbaa'). Used by Gradient Map (with dithering) and looks.
 */
export function gradientLutFloat(stops: { offset: number; color: string }[], reverse = false, size = 1024): Float32Array {
  const lut = new Float32Array(size * 4);
  const sorted = [...stops]
    .filter((s) => s && typeof s.color === 'string')
    .map((s) => ({ o: clamp01(Number(s.offset) || 0), c: parseColor(s.color) }))
    .sort((a, b) => a.o - b.o);
  if (!sorted.length) return lut;
  for (let i = 0; i < size; i++) {
    let t = i / (size - 1);
    if (reverse) t = 1 - t;
    let k = 0;
    while (k < sorted.length - 1 && sorted[k + 1].o < t) k++;
    const s0 = sorted[k];
    const s1 = sorted[Math.min(k + 1, sorted.length - 1)];
    let f = 0;
    if (t <= s0.o) f = 0;
    else if (s1.o > s0.o) f = clamp01((t - s0.o) / (s1.o - s0.o));
    else f = 1;
    const c0 = s0.c;
    const c1 = t <= s0.o ? s0.c : s1.c;
    const j = i * 4;
    lut[j] = c0.r + (c1.r - c0.r) * f;
    lut[j + 1] = c0.g + (c1.g - c0.g) * f;
    lut[j + 2] = c0.b + (c1.b - c0.b) * f;
    lut[j + 3] = c0.a + (c1.a - c0.a) * f;
  }
  return lut;
}

/** 4×4 Bayer matrix normalized to -0.5..0.5 (ordered dither). */
export const BAYER4 = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5));

/* ---------------- 3D LUT (used by Color Lookup) ---------------- */

/**
 * Build an N³ RGB cube by sampling `fn` (inputs/outputs 0..1). Layout: ((b * N + g) * N + r) * 3.
 */
export function build3DLut(size: number, fn: (r: number, g: number, b: number, out: Float64Array) => void): Float32Array {
  const lut = new Float32Array(size * size * size * 3);
  const out = new Float64Array(3);
  let j = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        fn(r / (size - 1), g / (size - 1), b / (size - 1), out);
        lut[j++] = clamp01(out[0]) * 255;
        lut[j++] = clamp01(out[1]) * 255;
        lut[j++] = clamp01(out[2]) * 255;
      }
  return lut;
}

/** Apply a 3D LUT with tetrahedral interpolation, mixing with the original by `intensity` (0..1). */
export function apply3DLut(img: Pixels, lut: Float32Array, size: number, intensity = 1): void {
  if (intensity <= 0) return;
  const t = Math.min(1, intensity);
  // Per-value index / fraction tables avoid divisions in the inner loop.
  const idx = new Int32Array(256);
  const frac = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const f = (v / 255) * (size - 1);
    const i = Math.min(size - 2, Math.floor(f));
    idx[v] = i;
    frac[v] = f - i;
  }
  const sy = size * 3;
  const sz = size * size * 3;
  const d = img.data;
  for (let p = 0, n = d.length; p < n; p += 4) {
    if (d[p + 3] === 0) continue;
    const r = d[p],
      g = d[p + 1],
      b = d[p + 2];
    const fr = frac[r],
      fg = frac[g],
      fb = frac[b];
    const o000 = idx[b] * sz + idx[g] * sy + idx[r] * 3;
    const o111 = o000 + sz + sy + 3;
    // Tetrahedral interpolation: pick the tetrahedron containing the point (6 cases),
    // walk 000 → A → B → 111 with weights w1 ≥ w2 ≥ w3.
    let oA: number, oB: number, w1: number, w2: number, w3: number;
    if (fr > fg) {
      if (fg > fb) {
        oA = o000 + 3;
        oB = o000 + 3 + sy;
        w1 = fr;
        w2 = fg;
        w3 = fb;
      } else if (fr > fb) {
        oA = o000 + 3;
        oB = o000 + 3 + sz;
        w1 = fr;
        w2 = fb;
        w3 = fg;
      } else {
        oA = o000 + sz;
        oB = o000 + sz + 3;
        w1 = fb;
        w2 = fr;
        w3 = fg;
      }
    } else if (fb > fg) {
      oA = o000 + sz;
      oB = o000 + sz + sy;
      w1 = fb;
      w2 = fg;
      w3 = fr;
    } else if (fb > fr) {
      oA = o000 + sy;
      oB = o000 + sy + sz;
      w1 = fg;
      w2 = fb;
      w3 = fr;
    } else {
      oA = o000 + sy;
      oB = o000 + sy + 3;
      w1 = fg;
      w2 = fr;
      w3 = fb;
    }
    const k0 = 1 - w1,
      k1 = w1 - w2,
      k2 = w2 - w3;
    for (let c = 0; c < 3; c++) {
      const v = lut[o000 + c] * k0 + lut[oA + c] * k1 + lut[oB + c] * k2 + lut[o111 + c] * w3;
      // Uint8ClampedArray assignment rounds to nearest and clamps.
      d[p + c] = t >= 1 ? v : d[p + c] + (v - d[p + c]) * t;
    }
  }
}
