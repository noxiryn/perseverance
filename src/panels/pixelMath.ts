/** Small pure pixel helpers (RGBA data, straight alpha — as ImageData stores it). */

/**
 * Undo a `destination-out` knockout. `pieces` were knocked out by the alpha of `cover`
 * (alpha' = alpha × (1 − coverAlpha), colour unchanged), so the original alpha is restored by
 * dividing again. Where the cover is fully opaque nothing survived and the pixel stays empty.
 * Both arrays are RGBA of the same size; `pieces` is changed in place.
 */
export function unknockAlpha(pieces: Uint8ClampedArray | number[], cover: ArrayLike<number>): void {
  for (let i = 3; i < pieces.length; i += 4) {
    const a = pieces[i];
    if (a === 0) continue;
    const keep = 255 - cover[i];
    if (keep <= 0 || keep >= 255) continue;
    pieces[i] = Math.min(255, Math.round((a * 255) / keep));
  }
}
