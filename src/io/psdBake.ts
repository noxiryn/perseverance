/**
 * Pixel math for adjustment layers baked into PSD pixel layers (pure: no canvas, unit-tested).
 *
 * Our renderer mixes an adjustment into what is below it and keeps that backdrop's alpha:
 *   result colour = mix(backdrop, filtered, m), result alpha = backdrop alpha   (m = opacity × mask)
 *
 * - Clipped adjustment: Photoshop (and our renderer, see src/render/clip.ts) composites clipped
 *   layers onto the clip stack and keeps the stack's coverage — the base's shape. A baked layer
 *   holding the filtered colour at full alpha wherever the backdrop has any coverage therefore
 *   reproduces the mix exactly, as long as the stack covers its whole shape where the bake paints
 *   (backdrop alpha = shape alpha). It can't when it doesn't: a base below 100% fill (the stack is
 *   thinner than the shape, a clipped pixel layer would fill it up) or a base whose layer style
 *   adds coverage beyond its shape (centre stroke, inner effects over soft edges: clipped pixel
 *   layers don't paint there, adjustments do). The error there is up to m·|backdrop α − shape α|.
 * - Not clipped (inside an isolated group, or at the root of a transparent document): a pixel layer
 *   drawn on top always adds coverage, so semi-transparent backdrop pixels come out denser — by up to
 *   255·m·α(1−α) levels (α = backdrop alpha), whatever the filter does. Opaque and fully transparent
 *   pixels stay exact.
 */

/** Error (in 0..255 levels) above which a pixel counts as visibly off. */
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
 * `clipShape`: for a clipped adjustment, the alpha channel of its clip base's shape (the stack's
 * coverage); null when not clipped. Clipped bakes get alpha 255 wherever the backdrop has any
 * coverage (0 elsewhere); unclipped ones keep the backdrop's alpha.
 * Returns true when the result is only approximate (enough pixels off by more than SOFT_EDGE_LEVELS).
 */
export function finishBakedPixels(data: Uint8ClampedArray, alpha: Uint8Array, opacity: number, clipShape: Uint8Array | null): boolean {
  const n = Math.min(alpha.length, data.length >> 2);
  const o = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
  if (clipShape) {
    // m·|backdrop α − shape α| > LEVELS  ⇔  |…| > LEVELS / o
    const limit = o > 0 ? SOFT_EDGE_LEVELS / o : Infinity;
    let off = 0;
    for (let i = 0, j = 3; i < n; i++, j += 4) {
      const a = alpha[i];
      data[j] = a > 0 ? 255 : 0;
      if (a > 0 && Math.abs(a - (clipShape[i] ?? 0)) > limit) off++;
    }
    return off >= SOFT_EDGE_MIN_PIXELS;
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
