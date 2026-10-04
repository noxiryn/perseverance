import type { Point, Rect, Transform } from './types';

export const DEG = Math.PI / 180;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function identityTransform(x = 0, y = 0): Transform {
  return { x, y, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0 };
}

/**
 * Matrix mapping local content coords [0,w]x[0,h] → document coords.
 * M = T(x + w/2, y + h/2) · R(rot) · Skew(skewX) · S(sx, sy) · T(-w/2, -h/2)
 */
export function transformMatrix(t: Transform, w: number, h: number): DOMMatrix {
  const m = new DOMMatrix();
  m.translateSelf(t.x + w / 2, t.y + h / 2);
  if (t.rotation) m.rotateSelf(t.rotation);
  if (t.skewX) m.skewXSelf(t.skewX);
  m.scaleSelf(t.scaleX, t.scaleY);
  m.translateSelf(-w / 2, -h / 2);
  return m;
}

export function applyMatrix(m: DOMMatrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Corners (TL, TR, BR, BL) of the local box in document space. */
export function transformedCorners(t: Transform, w: number, h: number): Point[] {
  const m = transformMatrix(t, w, h);
  return [
    applyMatrix(m, { x: 0, y: 0 }),
    applyMatrix(m, { x: w, y: 0 }),
    applyMatrix(m, { x: w, y: h }),
    applyMatrix(m, { x: 0, y: h }),
  ];
}

export function boundsOfPoints(pts: Point[]): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function transformedBounds(t: Transform, w: number, h: number): Rect {
  return boundsOfPoints(transformedCorners(t, w, h));
}

export function rectUnion(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function rectIntersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  if (r <= x || btm <= y) return null;
  return { x, y, width: r - x, height: btm - y };
}

/** Integer rect expanded to cover `r`, clipped to [0,w]x[0,h]. */
export function pixelRect(r: Rect, w: number, h: number, pad = 0): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x - pad));
  const y0 = Math.max(0, Math.floor(r.y - pad));
  const x1 = Math.min(w, Math.ceil(r.x + r.width + pad));
  const y1 = Math.min(h, Math.ceil(r.y + r.height + pad));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y,
      xj = poly[j].x,
      yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
