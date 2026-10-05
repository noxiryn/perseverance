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
