/**
 * Plain-object 2D affine math (no DOMMatrix so it is unit-testable in jsdom).
 *
 * Matrix layout matches canvas/DOMMatrix: [a c e; b d f; 0 0 1], i.e. x' = a·x + c·y + e,
 * y' = b·x + d·y + f.
 */
import type { Point, Transform } from '../../core/types';

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Readonly<Affine> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

const RAD = Math.PI / 180;

export function identity(): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/** m1 · m2 (apply m2 first, then m1). */
export function mul(m1: Affine, m2: Affine): Affine {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/** Multiply a chain left→right: chain(A, B, C) = A·B·C. */
export function chain(...ms: Affine[]): Affine {
  return ms.reduce((acc, m) => mul(acc, m), identity());
}

export function invert(m: Affine): Affine {
  let det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) det = det < 0 ? -1e-12 : 1e-12;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

export function apply(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export function translate(x: number, y: number): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scale(sx: number, sy = sx): Affine {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** Rotation by degrees (positive = clockwise on screen, y down — same as canvas rotate()). */
export function rotate(deg: number): Affine {
  const r = deg * RAD;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  return { a: cs, b: sn, c: -sn, d: cs, e: 0, f: 0 };
}

/** Horizontal skew by degrees (same as DOMMatrix.skewXSelf). */
export function skewX(deg: number): Affine {
  return { a: 1, b: 0, c: Math.tan(deg * RAD), d: 1, e: 0, f: 0 };
}

/** Matrix about a pivot point: T(p) · m · T(-p). */
export function about(p: Point, m: Affine): Affine {
  return chain(translate(p.x, p.y), m, translate(-p.x, -p.y));
}

/**
 * Matrix mapping a layer's local box [0,w]×[0,h] to document space (see core/types Transform):
 * M = T(x + w/2, y + h/2) · R(rot) · SkX(skew) · S(sx, sy) · T(-w/2, -h/2)
 */
export function fromTransform(t: Transform, w: number, h: number): Affine {
  return chain(
    translate(t.x + w / 2, t.y + h / 2),
    rotate(t.rotation || 0),
    skewX(t.skewX || 0),
    scale(t.scaleX, t.scaleY),
    translate(-w / 2, -h / 2),
  );
}

function clean(v: number, eps = 1e-9): number {
  return Math.abs(v) < eps ? 0 : v;
}

/** Normalize an angle in degrees to (-180, 180]. */
export function normAngle(deg: number): number {
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return a;
}

/**
 * Decompose an affine matrix into a layer Transform for a local box of w×h.
 * Every 2D affine can be written as R(θ)·SkX(k)·S(sx, sy); the sign of sx is chosen to match
 * `prefer` (so a horizontally flipped layer stays scaleX < 0 instead of becoming rotation 180°).
 */
export function decompose(m: Affine, w: number, h: number, prefer?: Pick<Transform, 'scaleX'>): Transform {
  const flipX = prefer ? prefer.scaleX < 0 : false;
  let sx = Math.hypot(m.a, m.b);
  if (flipX) sx = -sx;
  const theta = sx >= 0 ? Math.atan2(m.b, m.a) : Math.atan2(-m.b, -m.a);
  const cs = Math.cos(theta);
  const sn = Math.sin(theta);
  // Second column rotated back by -θ = (sy·tan k, sy)
  const sy = -m.c * sn + m.d * cs;
  const shear = m.c * cs + m.d * sn; // = sy·tan(k)
  let skew = 0;
  if (Math.abs(sy) > 1e-12) skew = Math.atan(shear / sy) / RAD;
  const rotation = normAngle(theta / RAD);
  // Translation: e = x + w/2 − L·(w/2, h/2)
  const L = { a: m.a, b: m.b, c: m.c, d: m.d, e: 0, f: 0 };
  const half = apply(L, { x: w / 2, y: h / 2 });
  const cx = m.e + half.x;
  const cy = m.f + half.y;
  return {
    x: clean(cx - w / 2),
    y: clean(cy - h / 2),
    scaleX: clean(sx, 1e-12),
    scaleY: clean(sy, 1e-12),
    rotation: clean(rotation, 1e-7),
    skewX: clean(skew, 1e-7),
  };
}

/** True when the matrix has no rotation/skew (pure scale + translate). */
export function isAxisAligned(m: Affine, eps = 1e-6): boolean {
  return Math.abs(m.b) < eps && Math.abs(m.c) < eps;
}

export function isIdentity(m: Affine, eps = 1e-9): boolean {
  return (
    Math.abs(m.a - 1) < eps &&
    Math.abs(m.b) < eps &&
    Math.abs(m.c) < eps &&
    Math.abs(m.d - 1) < eps &&
    Math.abs(m.e) < eps &&
    Math.abs(m.f) < eps
  );
}

export function equalsApprox(m1: Affine, m2: Affine, eps = 1e-6): boolean {
  return (
    Math.abs(m1.a - m2.a) < eps &&
    Math.abs(m1.b - m2.b) < eps &&
    Math.abs(m1.c - m2.c) < eps &&
    Math.abs(m1.d - m2.d) < eps &&
    Math.abs(m1.e - m2.e) < eps &&
    Math.abs(m1.f - m2.f) < eps
  );
}

/** Rotation (deg) of the first column of a matrix (the box's local x axis on screen). */
export function axisAngle(m: Affine): number {
  return Math.atan2(m.b, m.a) / RAD;
}
