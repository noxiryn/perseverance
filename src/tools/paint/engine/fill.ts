/**
 * Paint bucket flood fill over RGBA byte buffers (pure). Colors are compared premultiplied, so
 * all fully transparent pixels count as the same color regardless of their RGB.
 */
import type { Rect } from '../../../core/types';

export interface FloodResult {
  /** 255 = filled, 0 = not filled (w*h). */
  mask: Uint8Array;
  bounds: Rect | null;
}

/**
 * Select pixels similar to the seed pixel (max channel difference ≤ tolerance, 0..255).
 * `contiguous` floods 4-connected neighbours; otherwise every matching pixel is selected.
 */
export function floodMask(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  tolerance: number,
  contiguous: boolean,
): FloodResult {
  const mask = new Uint8Array(w * h);
  const sx = Math.floor(seedX),
    sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { mask, bounds: null };
  const s0 = (sy * w + sx) * 4;
  const sa = src[s0 + 3];
  const sr = (src[s0] * sa) / 255,
    sg = (src[s0 + 1] * sa) / 255,
    sb = (src[s0 + 2] * sa) / 255;
  const tol = Math.max(0, tolerance);
  const match = (p: number): boolean => {
    const i = p * 4;
    const a = src[i + 3];
    if (Math.abs(a - sa) > tol) return false;
    const k = a / 255;
    return Math.abs(src[i] * k - sr) <= tol && Math.abs(src[i + 1] * k - sg) <= tol && Math.abs(src[i + 2] * k - sb) <= tol;
  };
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  if (!contiguous) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (match(p)) {
          mask[p] = 255;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
  } else {
    // Scanline flood fill.
    let stack = new Int32Array(1024);
    let sp = 0;
    const push = (x: number, y: number) => {
      if (sp + 2 > stack.length) {
        const n = new Int32Array(stack.length * 2);
        n.set(stack);
        stack = n;
      }
      stack[sp++] = x;
      stack[sp++] = y;
    };
    push(sx, sy);
    while (sp > 0) {
      const y = stack[--sp];
      let x = stack[--sp];
      const row = y * w;
      if (mask[row + x] || !match(row + x)) continue;
      let x0 = x;
      while (x0 > 0 && !mask[row + x0 - 1] && match(row + x0 - 1)) x0--;
      let x1 = x;
      while (x1 < w - 1 && !mask[row + x1 + 1] && match(row + x1 + 1)) x1++;
      for (x = x0; x <= x1; x++) mask[row + x] = 255;
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        let inSpan = false;
        for (x = x0; x <= x1; x++) {
          const ok = !mask[nrow + x] && match(nrow + x);
          if (ok && !inSpan) {
            push(x, ny);
            inSpan = true;
          } else if (!ok) inSpan = false;
        }
      }
    }
  }
  if (maxX < 0) return { mask, bounds: null };
  return { mask, bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}

/**
 * Coverage alpha for the fill: hard mask, or anti-aliased by averaging 3×3 at the edges
 * (expands the bounds by 1px). Returns alpha for the (possibly grown) bounds.
 */
export function maskToAlpha(res: FloodResult, w: number, h: number, antiAlias: boolean): { alpha: Uint8ClampedArray; rect: Rect } | null {
  const b = res.bounds;
  if (!b) return null;
  const rect = antiAlias
    ? (() => {
        const x0 = Math.max(0, b.x - 1),
          y0 = Math.max(0, b.y - 1);
        const x1 = Math.min(w, b.x + b.width + 1),
          y1 = Math.min(h, b.y + b.height + 1);
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      })()
    : b;
  const alpha = new Uint8ClampedArray(rect.width * rect.height);
  const m = res.mask;
  for (let y = 0; y < rect.height; y++) {
    const gy = rect.y + y;
    for (let x = 0; x < rect.width; x++) {
      const gx = rect.x + x;
      const p = gy * w + gx;
      if (!antiAlias) {
        alpha[y * rect.width + x] = m[p];
        continue;
      }
      // Interior pixels stay solid; edges blend.
      let sum = 0;
      let n = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = gy + oy;
        if (yy < 0 || yy >= h) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = gx + ox;
          if (xx < 0 || xx >= w) continue;
          sum += m[yy * w + xx];
          n++;
        }
      }
      const avg = sum / n;
      alpha[y * rect.width + x] = m[p] ? Math.max(avg, 160 + avg * 0.373) : avg * 0.5;
    }
  }
  return { alpha, rect };
}
