/**
 * Blend-mode math on 8-bit straight colours (pure: no canvas, unit-tested), for "atop" blending
 * done on the CPU: adjustment layers with a blend mode (see applyAdjustment in ./engine.ts).
 *
 * Canvas 2D blending is not reproducible to the level: Chrome evaluates a blend through different
 * raster pipelines (GPU or CPU, and different CPU paths depending on the surfaces), which round
 * exact ties (e.g. 222.5) differently — an incremental composite over a crop and a full render of
 * the same pixels could come out a level or two apart. These functions follow the W3C Compositing
 * and Blending Level 1 formulas (the ones canvas implements) with one fixed rounding (half up), so
 * the same inputs always give the same bytes.
 */
import type { BlendMode } from '../core/types';

type Sep = (b: number, s: number) => number;

const softD = (b: number) => (b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b));
const hardLight: Sep = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));

/** Separable blend functions B(Cb, Cs) on 0..1 channel values. */
const SEPARABLE: Partial<Record<BlendMode, Sep>> = {
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'hard-light': hardLight,
  'soft-light': (b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (softD(b) - b)),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  // Canvas 'lighter' over opaque pixels: the sum, clamped.
  'linear-dodge': (b, s) => Math.min(1, b + s),
};

/** 0..1 → byte, rounding half up. */
const toByte = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.floor(v * 255 + 0.5));

const luts = new Map<BlendMode, Uint8Array>();

/** 256×256 table of a separable mode: lut[(cb << 8) | cs] = B(cb, cs) as a byte. */
export function separableLut(mode: BlendMode): Uint8Array | null {
  const f = SEPARABLE[mode];
  if (!f) return null;
  let lut = luts.get(mode);
  if (!lut) {
    lut = new Uint8Array(65536);
    for (let b = 0; b < 256; b++) for (let s = 0; s < 256; s++) lut[(b << 8) | s] = toByte(f(b / 255, s / 255));
    luts.set(mode, lut);
  }
  return lut;
}

/** Whether blendAtop handles `mode` (every blend mode but 'normal'). */
export function isBlendable(mode: BlendMode | undefined): mode is BlendMode {
  return !!mode && mode !== 'normal' && (mode in SEPARABLE || mode === 'hue' || mode === 'saturation' || mode === 'color' || mode === 'luminosity');
}

/* ---------------- non-separable modes ---------------- */

/** Half-up rounding bias for the non-separable modes (see blendNonSeparable). */
const TIE = 0.5 + 1e-7;

/**
 * Result memo of a non-separable mode, kept between calls (one per mode): direct mapped, 2^16
 * slots of [backdrop rgb, source rgb, result rgb] (backdrop −1 = empty). An adjustment's source is
 * a function of the backdrop colour for most filters, so the pairs repeat wherever colours do
 * (gradients, flat art, re-rendering an unchanged area). Noisy images (nearly every pixel a new
 * colour) would only pay for the memory traffic: a call stops using it when, checked every
 * MEMO_PROBE misses, it has had fewer hits than misses (what was stored stays valid).
 */
const MEMO_BITS = 16;
const MEMO_PROBE = 8192;
const memos = new Map<BlendMode, Int32Array>();
function memoFor(mode: BlendMode): Int32Array {
  let m = memos.get(mode);
  if (!m) memos.set(mode, (m = new Int32Array(3 << MEMO_BITS).fill(-1)));
  return m;
}

/**
 * Non-separable modes (hue, saturation, color, luminosity) in place over `n` bytes, computed in
 * 0..255 space (the W3C formulas are scale-invariant): SetLum / ClipColor / SetSat inlined.
 * Results are rounded half up with a tiny bias, so an exact tie (the luminance weights make them
 * common: 222.5) rounds up even when float noise lands it a hair below.
 */
function blendNonSeparable(dst: Uint8ClampedArray, src: Uint8ClampedArray, mode: BlendMode, n: number) {
  const isHue = mode === 'hue';
  const isSat = mode === 'saturation';
  const isColor = mode === 'color';
  const memo = memoFor(mode);
  let memoOn = true,
    hits = 0,
    misses = 0,
    slot = 0;
  // Runs of the same backdrop / source colours (flat areas) reuse the previous result.
  let pb = -1,
    ps = -1,
    r0 = 0,
    g0 = 0,
    b0 = 0;
  for (let i = 0; i < n; i += 4) {
    if (dst[i + 3] === 0) {
      dst[i] = dst[i + 1] = dst[i + 2] = 0;
      continue;
    }
    const br = dst[i],
      bg = dst[i + 1],
      bb = dst[i + 2];
    const sr = src[i],
      sg = src[i + 1],
      sb = src[i + 2];
    const kb = (br << 16) | (bg << 8) | bb;
    const ks = (sr << 16) | (sg << 8) | sb;
    if (kb !== pb || ks !== ps) {
      pb = kb;
      ps = ks;
      if (memoOn) {
        slot = ((Math.imul(kb, -1640531535) ^ Math.imul(ks, -2048144777)) >>> (32 - MEMO_BITS)) * 3;
        if (memo[slot] === kb && memo[slot + 1] === ks) {
          const o = memo[slot + 2];
          r0 = o >>> 16;
          g0 = (o >> 8) & 255;
          b0 = o & 255;
          hits++;
          dst[i] = r0;
          dst[i + 1] = g0;
          dst[i + 2] = b0;
          continue;
        }
        if (++misses % MEMO_PROBE === 0 && hits < misses) memoOn = false;
      }
      let r: number, g: number, b: number, l: number;
      if (isColor) {
        // SetLum(Cs, Lum(Cb))
        r = sr;
        g = sg;
        b = sb;
        l = 0.3 * br + 0.59 * bg + 0.11 * bb;
      } else if (!isHue && !isSat) {
        // luminosity: SetLum(Cb, Lum(Cs))
        r = br;
        g = bg;
        b = bb;
        l = 0.3 * sr + 0.59 * sg + 0.11 * sb;
      } else {
        // hue: SetLum(SetSat(Cs, Sat(Cb)), Lum(Cb)); saturation: SetLum(SetSat(Cb, Sat(Cs)), Lum(Cb))
        const xr = isHue ? sr : br,
          xg = isHue ? sg : bg,
          xb = isHue ? sb : bb;
        const yr = isHue ? br : sr,
          yg = isHue ? bg : sg,
          yb = isHue ? bb : sb;
        const sat = (yr > yg ? (yr > yb ? yr : yb) : yg > yb ? yg : yb) - (yr < yg ? (yr < yb ? yr : yb) : yg < yb ? yg : yb);
        const mx = xr > xg ? (xr > xb ? xr : xb) : xg > xb ? xg : xb;
        const mn = xr < xg ? (xr < xb ? xr : xb) : xg < xb ? xg : xb;
        if (mx > mn) {
          // max channel → s, min → 0, mid → (mid − min)·s / (max − min)
          const k = sat / (mx - mn);
          r = (xr - mn) * k;
          g = (xg - mn) * k;
          b = (xb - mn) * k;
        } else r = g = b = 0;
        l = 0.3 * br + 0.59 * bg + 0.11 * bb;
      }
      // SetLum
      const d = l - (0.3 * r + 0.59 * g + 0.11 * b);
      r += d;
      g += d;
      b += d;
      // ClipColor (min and max taken before either correction, as in the spec)
      const L = 0.3 * r + 0.59 * g + 0.11 * b;
      const lo = r < g ? (r < b ? r : b) : g < b ? g : b;
      const hi = r > g ? (r > b ? r : b) : g > b ? g : b;
      if (lo < 0) {
        const k = L / (L - lo);
        r = L + (r - L) * k;
        g = L + (g - L) * k;
        b = L + (b - L) * k;
      }
      if (hi > 255) {
        const k = (255 - L) / (hi - L);
        r = L + (r - L) * k;
        g = L + (g - L) * k;
        b = L + (b - L) * k;
      }
      r0 = r <= 0 ? 0 : r >= 255 ? 255 : Math.floor(r + TIE);
      g0 = g <= 0 ? 0 : g >= 255 ? 255 : Math.floor(g + TIE);
      b0 = b <= 0 ? 0 : b >= 255 ? 255 : Math.floor(b + TIE);
      if (memoOn) {
        memo[slot] = kb;
        memo[slot + 1] = ks;
        memo[slot + 2] = (r0 << 16) | (g0 << 8) | b0;
      }
    }
    dst[i] = r0;
    dst[i + 1] = g0;
    dst[i + 2] = b0;
  }
}

/**
 * "Atop" blend in place: `dst` (RGBA, straight colour) is the backdrop and receives the result;
 * `src` (RGBA, straight colour, same length) is the blend layer at full opacity. Wherever the
 * backdrop has coverage, its colour becomes B(Cb, Cs) and its alpha is kept (the source's alpha is
 * ignored); fully transparent backdrop pixels become 0,0,0,0. 'normal' (or an unknown mode) copies
 * the source colour.
 */
export function blendAtop(dst: Uint8ClampedArray, src: Uint8ClampedArray, mode: BlendMode): void {
  const n = Math.min(dst.length, src.length) & ~3;
  const lut = separableLut(mode);
  if (lut) {
    for (let i = 0; i < n; i += 4) {
      if (dst[i + 3] === 0) {
        dst[i] = dst[i + 1] = dst[i + 2] = 0;
        continue;
      }
      dst[i] = lut[(dst[i] << 8) | src[i]];
      dst[i + 1] = lut[(dst[i + 1] << 8) | src[i + 1]];
      dst[i + 2] = lut[(dst[i + 2] << 8) | src[i + 2]];
    }
    return;
  }
  if (!isBlendable(mode)) {
    for (let i = 0; i < n; i += 4) {
      if (dst[i + 3] === 0) {
        dst[i] = dst[i + 1] = dst[i + 2] = 0;
        continue;
      }
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
    }
    return;
  }
  blendNonSeparable(dst, src, mode, n);
}
