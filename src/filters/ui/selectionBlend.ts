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
