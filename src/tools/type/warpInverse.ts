/** Numeric inverse of the renderer's text warp mapping (pure; used for caret hit testing). */
import { warpPoint, type WarpParams } from '../../render/warpMath';

/**
 * Inverse of `warpPoint` (both relative to the box center; a/c = half sizes) by damped Newton
 * iteration with a numeric Jacobian. Converges for every built-in style within -100..100.
 */
export function inverseWarp(w: WarpParams, X: number, Y: number, a: number, c: number): [number, number] {
  let x = X;
  let y = Y;
  const h = Math.max(1e-3, (Math.abs(a) + Math.abs(c)) * 1e-4);
  const lim = Math.max(1, Math.abs(a) + Math.abs(c));
  for (let i = 0; i < 40; i++) {
    const [fx, fy] = warpPoint(w, x, y, a, c);
    const ex = fx - X;
    const ey = fy - Y;
    if (Math.abs(ex) + Math.abs(ey) < 1e-4 * lim) break;
    const [fx1, fy1] = warpPoint(w, x + h, y, a, c);
    const [fx2, fy2] = warpPoint(w, x, y + h, a, c);
    const j11 = (fx1 - fx) / h;
    const j21 = (fy1 - fy) / h;
    const j12 = (fx2 - fx) / h;
    const j22 = (fy2 - fy) / h;
    const det = j11 * j22 - j12 * j21;
    let dx: number;
    let dy: number;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
      dx = ex;
      dy = ey;
    } else {
      dx = (j22 * ex - j12 * ey) / det;
      dy = (-j21 * ex + j11 * ey) / det;
    }
    const n = Math.hypot(dx, dy);
    if (n > lim * 0.5) {
      dx *= (lim * 0.5) / n;
      dy *= (lim * 0.5) / n;
    }
    x -= dx;
    y -= dy;
  }
  return [x, y];
}
