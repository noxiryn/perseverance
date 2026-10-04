/**
 * Minimal pure 2D affine math matching core/geometry.ts `transformMatrix` (which uses DOMMatrix,
 * unavailable in jsdom). Used for caret/selection mapping and anchor-preserving text edits.
 */
import type { Point, Transform } from '../../core/types';

/** [a, b, c, d, e, f] — maps (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export type Mat = [number, number, number, number, number, number];

const RAD = Math.PI / 180;

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Mat, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** Linear part A = R(rot) · SkewX(skew) · S(sx, sy) of a layer transform. */
export function linearPart(t: Transform): Mat {
  const r = (t.rotation || 0) * RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const k = Math.tan((t.skewX || 0) * RAD);
  const R: Mat = [cos, sin, -sin, cos, 0, 0];
  const K: Mat = [1, 0, k, 1, 0, 0];
  const S: Mat = [t.scaleX ?? 1, 0, 0, t.scaleY ?? 1, 0, 0];
  return mul(mul(R, K), S);
}

/** Local box [0,w]×[0,h] → document matrix (same as core/geometry transformMatrix). */
export function layerMatrix(t: Transform, w: number, h: number): Mat {
  const A = linearPart(t);
  const T1: Mat = [1, 0, 0, 1, t.x + w / 2, t.y + h / 2];
  const T2: Mat = [1, 0, 0, 1, -w / 2, -h / 2];
  return mul(mul(T1, A), T2);
}

/**
 * New transform position (x, y) so that local point `newLocal` of a box of size newW×newH lands
 * where `oldLocal` of the old box (oldW×oldH) was. Rotation/scale/skew are preserved.
 */
export function keepAnchor(t: Transform, oldW: number, oldH: number, oldLocal: Point, newW: number, newH: number, newLocal: Point): { x: number; y: number } {
  const D = apply(layerMatrix(t, oldW, oldH), oldLocal);
  const A = linearPart(t);
  const v = apply(A, { x: newLocal.x - newW / 2, y: newLocal.y - newH / 2 });
  return { x: D.x - newW / 2 - v.x, y: D.y - newH / 2 - v.y };
}
