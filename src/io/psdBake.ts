/**
 * Pixel math for adjustment layers baked into PSD pixel layers (pure: no canvas, unit-tested).
 *
 * Our renderer mixes an adjustment into what is below it and keeps that backdrop's alpha:
 *   result colour = mix(backdrop, filtered, m), result alpha = backdrop alpha   (m = opacity × mask)
 *
 * - Clipped adjustment: Photoshop (and our renderer, see src/render/clip.ts) recolours a clip stack
 *   by lerping towards each clipped layer's colour by that layer's alpha, and keeps the base's
 *   coverage. A baked layer holding the filtered colour at full alpha wherever the backdrop has any
 *   coverage therefore reproduces the mix exactly — over a base at 100% fill. Below 100% fill the
 *   stack is only partly opaque inside the base (where the base alone shows, at its fill), and a
 *   pixel layer clipped to it always fills it up to the base's coverage: up to 255·m·(1 − fill)
 *   levels denser.
 * - Not clipped (inside an isolated group, or at the root of a transparent document): a pixel layer
 *   drawn on top always adds coverage, so semi-transparent backdrop pixels come out denser — by up to
 *   255·m·α(1−α) levels (α = backdrop alpha), whatever the filter does. Opaque and fully transparent
 *   pixels stay exact.
 */

/** Error (in 0..255 levels) above which a semi-transparent pixel counts as visibly off. */
export const SOFT_EDGE_LEVELS = 8;
/** How many such pixels make a baked layer "approximate" (a few stray pixels don't). */
export const SOFT_EDGE_MIN_PIXELS = 16;

/** Alpha channel of RGBA pixel data. */
export function alphaChannel(data: Uint8ClampedArray): Uint8Array {
  const a = new Uint8Array(data.length >> 2);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = data[j];
  return a;
}

/**
 * Finish a baked adjustment layer in place. `data` is the filter's output over the backdrop (RGBA,
 * not premultiplied), `alpha` the backdrop's alpha channel, `opacity` the layer's total strength.
 * `clipFill` is the clip base's fill opacity for a clipped adjustment (its backdrop is the clip
 * stack), null when the adjustment is not clipped.
 *  - Clipped: alpha becomes 255 wherever the backdrop has any coverage, 0 elsewhere (the colour is
 *    left as filtered).
 *  - Not clipped: the backdrop's alpha is kept.
 * Returns true when the result is only approximate (enough pixels visibly off, see above).
 */
export function finishBakedPixels(data: Uint8ClampedArray, alpha: Uint8Array, clipFill: number | null, opacity: number): boolean {
  const n = Math.min(alpha.length, data.length >> 2);
  const o = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
  if (clipFill !== null) {
    let covered = 0;
    for (let i = 0, j = 3; i < n; i++, j += 4) {
      if (alpha[i] > 0) {
        data[j] = 255;
        covered++;
      } else data[j] = 0;
    }
    const fill = clipFill < 0 ? 0 : clipFill > 1 ? 1 : clipFill;
    return 255 * o * (1 - fill) > SOFT_EDGE_LEVELS && covered >= SOFT_EDGE_MIN_PIXELS;
  }
  if (o <= 0) return false;
  // 255·o·a(1−a) > LEVELS  ⇔  α(255−α) > LEVELS·255/o   (α in 0..255)
  const limit = (SOFT_EDGE_LEVELS * 255) / o;
  let off = 0;
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if (a > 0 && a < 255 && a * (255 - a) > limit && ++off >= SOFT_EDGE_MIN_PIXELS) return true;
  }
  return false;
}
