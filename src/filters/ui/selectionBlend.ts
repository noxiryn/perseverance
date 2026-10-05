/**
 * Limit a filter result to a (soft) selection: out = lerp(orig, out, sel) computed in
 * premultiplied space so filters that change alpha (blur, rough edges…) blend correctly at
 * feathered selection edges. Pure (unit-tested).
 */
export function blendSelection(orig: Uint8ClampedArray, out: Uint8ClampedArray, sel: Uint8ClampedArray): void {
  const n = sel.length;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const m = sel[i];
    if (m === 255) continue;
    if (m === 0) {
      out[j] = orig[j];
      out[j + 1] = orig[j + 1];
      out[j + 2] = orig[j + 2];
      out[j + 3] = orig[j + 3];
      continue;
    }
    const t = m / 255;
    const ao = orig[j + 3],
      af = out[j + 3];
    const a = ao + (af - ao) * t;
    if (a <= 0.5) {
      out[j] = out[j + 1] = out[j + 2] = out[j + 3] = 0;
      continue;
    }
    const inv = 1 / a;
    for (let c = 0; c < 3; c++) {
      const po = orig[j + c] * ao,
        pf = out[j + c] * af;
      out[j + c] = (po + (pf - po) * t) * inv;
    }
    out[j + 3] = a;
  }
}

/** Bounding box of the pixels that differ between two RGBA buffers (null when identical). */
export function diffBounds(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number): { x: number; y: number; width: number; height: number } | null {
  const a32 = new Uint32Array(a.buffer, a.byteOffset, w * h);
  const b32 = new Uint32Array(b.buffer, b.byteOffset, w * h);
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x0 = -1;
    for (let x = 0; x < w; x++)
      if (a32[row + x] !== b32[row + x]) {
        x0 = x;
        break;
      }
    if (x0 < 0) continue;
    let x1 = x0;
    for (let x = w - 1; x > x0; x--)
      if (a32[row + x] !== b32[row + x]) {
        x1 = x;
        break;
      }
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y < minY) minY = y;
    maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
