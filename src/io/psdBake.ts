/**
 * Pixel math for adjustment layers baked into PSD pixel layers (pure: no canvas, unit-tested).
 *
 * Our renderer mixes an adjustment into what is below it and keeps that backdrop's alpha:
 *   result colour = mix(backdrop, filtered, m), result alpha = backdrop alpha   (m = opacity × mask)
 *
 * - Clipped adjustment: Photoshop composites clipped layers onto the clip base and keeps the base's
 *   alpha (the clip stack's coverage is the base's). A baked layer holding the filtered colour at
 *   full alpha wherever the backdrop has any coverage therefore reproduces the mix exactly.
 * - Not clipped (inside an isolated group, or at the root of a transparent document): a pixel layer
 *   drawn on top always adds coverage, so semi-transparent backdrop pixels come out denser — by up to
 *   255·m·α(1−α) levels (α = backdrop alpha), whatever the filter does. Opaque and fully transparent
 *   pixels stay exact.
 */

/** Error (in 0..255 levels) above which a soft-edge pixel counts as visibly off. */
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
 * Returns true when the result is only approximate (unclipped, over enough semi-transparent pixels).
 */
/**
 * A clipped bake is exact only where the clip stack covers its base's whole shape. A base drawn at
 * a lower Fill (with nothing clipped below the adjustment filling it up) leaves the stack at a
 * lower alpha than the shape, which the adjustment keeps — but Photoshop composites the baked pixel
 * layer up to the base's shape, so those pixels come out denser by m·(shape − α) (m = the layer's
 * strength; pixels where the stack is empty get no baked pixels and stay exact). `alpha` = the
 * stack's alpha channel (the backdrop), `shape` = the base's shape alpha. True when enough pixels
 * are visibly off (same thresholds as the unclipped soft-edge check).
 */
export function clippedBakeApprox(alpha: Uint8Array, shape: Uint8Array, opacity: number): boolean {
  const o = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
  if (o <= 0) return false;
  const n = Math.min(alpha.length, shape.length);
  let off = 0;
  for (let i = 0; i < n; i++) if (alpha[i] > 0 && o * (shape[i] - alpha[i]) > SOFT_EDGE_LEVELS && ++off >= SOFT_EDGE_MIN_PIXELS) return true;
  return false;
}

export function finishBakedPixels(data: Uint8ClampedArray, alpha: Uint8Array, clipped: boolean, opacity: number): boolean {
  const n = Math.min(alpha.length, data.length >> 2);
  if (clipped) {
    for (let i = 0, j = 3; i < n; i++, j += 4) data[j] = alpha[i] > 0 ? 255 : 0;
    return false;
  }
  const o = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
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
