/**
 * Clipping masks — the pixel math of a clip stack composite (pure: no canvas, unit-tested; the
 * canvas side is compositeClipStack / clipBaseFor in ./engine.ts).
 *
 * Photoshop semantics: a clipping group's coverage is its base layer's — clipped layers never add
 * coverage. Each clipped layer is blended "atop" what is below it in the stack:
 *     Co = αs·B(Cb, Cs) + (1 − αs)·Cb,    αo = αb
 * (B = the clipped layer's blend mode; its opacity, fill and mask scale αs). Canvas 2D has no
 * "atop with a blend mode" operation, so the stack is composited on a NORMALIZED base — the base's
 * colour made opaque — with plain source-over blending, and the base's alpha is applied at the end
 * with destination-in. Clipped adjustments run on the normalized colours and keep alpha.
 *
 * Base pieces (see LayerRender): `shape` = the base's content (smart filters + mask) at full
 * alpha, `core` = what the base itself draws (content at fill opacity + above-stage effects).
 *   - Coverage A = max(α_shape, α_core): normally α_shape (α_core only exceeds it where an
 *     above-stage effect reaches beyond the content — a centered stroke, an emboss — or adds
 *     coverage over soft edges).
 *   - Normalized base = core / A: the core's straight colour with alpha α_core / A — opaque inside
 *     the content at 100% fill; the fill opacity where the base is drawn at a lower fill (clipped
 *     layers still show at 0% fill, like Photoshop).
 *   - Share = α_shape / A: how much of the coverage clipped layers may paint (1 except where the
 *     core reaches beyond the shape; there, clipped content keeps the absolute amount the shape
 *     allows and never paints over effect pixels outside the content).
 */
import type { BlendMode } from '../core/types';

/** Whether any pixel's alpha in `core` exceeds the one in `shape` (RGBA, same length). */
export function coreExceedsShape(core: Uint8ClampedArray, shape: Uint8ClampedArray): boolean {
  const n = Math.min(core.length, shape.length);
  for (let i = 3; i < n; i += 4) if (core[i] > shape[i]) return true;
  return false;
}

/**
 * Normalize clip-base pixels in place. `core` is the base core's RGBA with straight alpha (e.g.
 * ImageData.data from getImageData); it becomes the normalized base: same colour, alpha
 * round(255·α_core / A) with A = max(α_core, α_shape) (fully transparent pixels become 0,0,0,0).
 * `shape` is the shape's RGBA, or null when the core IS the shape (then alpha is 255 wherever
 * covered). With `cover` / `share` (RGBA, same length), also writes the coverage A and the share
 * round(255·α_shape / A) as alpha (white colour) — only needed when coreExceedsShape.
 */
export function normalizeClipBase(core: Uint8ClampedArray, shape: Uint8ClampedArray | null, cover?: Uint8ClampedArray, share?: Uint8ClampedArray): void {
  const n = shape ? Math.min(core.length, shape.length) : core.length;
  for (let i = 3; i < n; i += 4) {
    const ak = core[i];
    const as = shape ? shape[i] : ak;
    const A = ak > as ? ak : as;
    if (cover) {
      cover[i - 3] = cover[i - 2] = cover[i - 1] = 255;
      cover[i] = A;
    }
    if (share) {
      share[i - 3] = share[i - 2] = share[i - 1] = 255;
      share[i] = A === 0 ? 0 : as >= A ? 255 : Math.round((255 * as) / A);
    }
    if (ak === 0) {
      core[i - 3] = core[i - 2] = core[i - 1] = 0;
      core[i] = 0;
    } else core[i] = ak >= A ? 255 : Math.round((255 * ak) / A);
  }
}

/* ---------------- adjustment layers with a blend mode ---------------- */

type Sep = (b: number, s: number) => number;
const softD = (b: number) => (b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b));
const hardLight: Sep = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));

/** Separable blend functions B(Cb, Cs) on 0..1 colours (W3C Compositing and Blending). */
const SEPARABLE: Partial<Record<BlendMode, Sep>> = {
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'linear-dodge': (b, s) => Math.min(1, b + s),
  'hard-light': hardLight,
  'soft-light': (b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (softD(b) - b)),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};

/** Per separable mode: round(255·B(b/255, s/255)) at [b << 8 | s]. */
const luts = new Map<BlendMode, Uint8ClampedArray>();
function lutOf(mode: BlendMode, f: Sep): Uint8ClampedArray {
  let t = luts.get(mode);
  if (!t) {
    t = new Uint8ClampedArray(65536);
    for (let b = 0; b < 256; b++) for (let s = 0; s < 256; s++) t[(b << 8) | s] = Math.round(255 * f(b / 255, s / 255));
    luts.set(mode, t);
  }
  return t;
}

// Non-separable modes (hue, saturation, color, luminosity): SetLum / SetSat / ClipColor of the
// spec on a scratch colour.
const C3 = new Float64Array(3);
const lum3 = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
const sat3 = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);
/** C3 = SetSat((r, g, b), s). */
function setSat(r: number, g: number, b: number, s: number) {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b);
  if (mx <= mn) {
    C3[0] = C3[1] = C3[2] = 0;
    return;
  }
  const k = s / (mx - mn);
  C3[0] = (r - mn) * k;
  C3[1] = (g - mn) * k;
  C3[2] = (b - mn) * k;
}
/** C3 = SetLum(C3, l) (with ClipColor). */
function setLum(l: number) {
  const d = l - lum3(C3[0], C3[1], C3[2]);
  const r = C3[0] + d,
    g = C3[1] + d,
    b = C3[2] + d;
  const L = lum3(r, g, b);
  const n = Math.min(r, g, b),
    x = Math.max(r, g, b);
  let kn = 1,
    kx = 1;
  if (n < 0) kn = L / (L - n);
  if (x > 1) kx = (1 - L) / (x - L);
  const k = Math.min(kn, kx);
  C3[0] = L + (r - L) * k;
  C3[1] = L + (g - L) * k;
  C3[2] = L + (b - L) * k;
}

/**
 * An adjustment layer's blend: `out` = B(backdrop, filtered) "atop" the backdrop — the blend of the
 * straight colours of `back` (the backdrop, RGBA as read back) and `src` (the filter output; its
 * alpha is ignored), with the backdrop's alpha (an adjustment never changes coverage, also over
 * semi-transparent pixels). Pixels the backdrop doesn't cover become 0,0,0,0. `out` may be `src`.
 * Computed here rather than with canvas blend operations: those round differently on GPU and CPU
 * canvases (which one a scratch canvas is depends on its size and history), and blending
 * semi-transparent pixels on a canvas changes their alpha.
 */
export function blendAtop(back: Uint8ClampedArray, src: Uint8ClampedArray, mode: BlendMode, out: Uint8ClampedArray): void {
  const n = Math.min(back.length, src.length, out.length);
  const f = SEPARABLE[mode];
  const lut = f ? lutOf(mode, f) : null;
  const ns = mode === 'hue' || mode === 'saturation' || mode === 'color' || mode === 'luminosity';
  for (let i = 0; i < n; i += 4) {
    const a = back[i + 3];
    if (a === 0) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
      continue;
    }
    const br = back[i],
      bg = back[i + 1],
      bb = back[i + 2];
    const sr = src[i],
      sg = src[i + 1],
      sb = src[i + 2];
    if (lut) {
      out[i] = lut[(br << 8) | sr];
      out[i + 1] = lut[(bg << 8) | sg];
      out[i + 2] = lut[(bb << 8) | sb];
    } else if (ns) {
      const r0 = br / 255,
        g0 = bg / 255,
        b0 = bb / 255;
      const r1 = sr / 255,
        g1 = sg / 255,
        b1 = sb / 255;
      if (mode === 'hue') {
        setSat(r1, g1, b1, sat3(r0, g0, b0));
        setLum(lum3(r0, g0, b0));
      } else if (mode === 'saturation') {
        setSat(r0, g0, b0, sat3(r1, g1, b1));
        setLum(lum3(r0, g0, b0));
      } else {
        const color = mode === 'color';
        C3[0] = color ? r1 : r0;
        C3[1] = color ? g1 : g0;
        C3[2] = color ? b1 : b0;
        setLum(color ? lum3(r0, g0, b0) : lum3(r1, g1, b1));
      }
      out[i] = Math.round(255 * C3[0]);
      out[i + 1] = Math.round(255 * C3[1]);
      out[i + 2] = Math.round(255 * C3[2]);
    } else {
      out[i] = sr;
      out[i + 1] = sg;
      out[i + 2] = sb;
    }
    out[i + 3] = a;
  }
}
