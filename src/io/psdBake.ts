/**
 * Pixel math for adjustment layers baked into PSD pixel layers (pure: no canvas, unit-tested).
 *
 * Our renderer mixes an adjustment into what is below it and keeps that backdrop's alpha:
 *   result colour = mix(backdrop, filtered, m), result alpha = backdrop alpha   (m = opacity × mask)
 *
 * - Clipped adjustment: Photoshop composites clipped layers onto the clip base and keeps the base's
 *   alpha (the clip stack's coverage is the base's). The bake filters the clip stack the way the
 *   compositor builds it — the base's colour made opaque (its content and above-stage effects,
 *   without behind-stage effects such as a drop shadow or an outside stroke) plus the clipped
 *   layers below the adjustment, before the base's coverage is applied (renderClipBackdrop). A baked
 *   layer holding the filtered colour at full alpha wherever that stack has coverage reproduces the
 *   mix exactly, soft base edges included, wherever the stack is opaque (see finishClippedBake).
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
 * Finish an unclipped baked adjustment layer in place. `data` is the filter's output over the
 * backdrop (RGBA, not premultiplied; it keeps the backdrop's alpha), `alpha` the backdrop's alpha
 * channel, `opacity` the layer's total strength. Returns true when the result is only approximate
 * (over enough semi-transparent pixels, see the file comment).
 */
export function finishBakedPixels(data: Uint8ClampedArray, alpha: Uint8Array, opacity: number): boolean {
  const n = Math.min(alpha.length, data.length >> 2);
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

/**
 * Finish a clipped baked adjustment layer in place and say whether it is only approximate.
 *  - `data`: the filter's output F over the clip stack (RGBA, straight alpha). Becomes the baked
 *    layer: F at alpha 255 wherever the stack and its coverage are non-zero, transparent elsewhere
 *    (outside the coverage the clip hides it anyway; where the stack is empty the adjustment has
 *    nothing to change).
 *  - `stack`: the stack it filtered, G (RGBA, straight alpha; see renderClipBackdrop).
 *  - `cover`: the stack's coverage A per pixel (0..255); `share`: the share s of it clipped pixel
 *    layers may paint (0..255, null: all of it); `opacity`: the layer's strength m.
 *
 * The adjustment mixes F into G and keeps G's alpha αG; the coverage applies afterwards. The baked
 * layer composited over the same stack (source-over at strength m·s, then the coverage) differs
 * from that by, premultiplied and in levels (αG, s in 0..1; F, G in 0..255):
 *     colour  A/255 · m · |(s − αG)·F + αG·(1 − s)·G|,     alpha  A · m · s · (1 − αG)
 * — zero where the stack is opaque and clipped layers may paint all of the coverage (αG = s = 1):
 * everywhere for a base at full Fill whose above-stage effects stay within its content, however
 * soft its edges and whatever its behind-stage effects (drop shadow, outer glow, outside stroke —
 * they are drawn below the stack in both). Not so where the base is drawn at a lower Fill (αG < 1:
 * Photoshop composites the baked layer up to the base's shape, denser) or an above-stage effect
 * reaches beyond the base's content (s < 1, e.g. a centered stroke: a clipped pixel layer can't
 * paint there, the adjustment does). True when enough pixels are visibly off (same thresholds as
 * the unclipped soft-edge check).
 */
export function finishClippedBake(
  data: Uint8ClampedArray,
  stack: Uint8ClampedArray,
  cover: Uint8Array,
  share: Uint8Array | null,
  opacity: number,
): boolean {
  const n = Math.min(data.length >> 2, stack.length >> 2, cover.length, share ? share.length : Infinity);
  const m = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
  let off = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const A = cover[i];
    const ag = stack[j + 3];
    if (A === 0 || ag === 0) {
      data[j + 3] = 0;
      continue;
    }
    data[j + 3] = 255;
    if (off >= SOFT_EDGE_MIN_PIXELS || m <= 0) continue;
    const s = share ? share[i] / 255 : 1;
    if (ag === 255 && s === 1) continue;
    const a = ag / 255;
    const k = (A / 255) * m;
    let err = A * m * s * (1 - a);
    for (let c = 0; c < 3; c++) {
      const e = k * Math.abs((s - a) * data[j + c] + a * (1 - s) * stack[j + c]);
      if (e > err) err = e;
    }
    if (err > SOFT_EDGE_LEVELS) off++;
  }
  return off >= SOFT_EDGE_MIN_PIXELS;
}
