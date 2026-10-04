/** Pure shape geometry (vertex math) used by shapes.ts. Coordinates are in the shape's local box. */
import type { Point } from '../core/types';

/** Normalize points so their bounding box exactly fills [0,w]×[0,h]. */
export function fitToBox(pts: Point[], w: number, h: number): Point[] {
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
  const sw = maxX - minX || 1;
  const sh = maxY - minY || 1;
  return pts.map((p) => ({ x: ((p.x - minX) / sw) * w, y: ((p.y - minY) / sh) * h }));
}

/** Regular polygon (first vertex pointing up), fitted to the box. */
export function polygonPoints(sides: number, w: number, h: number): Point[] {
  const n = Math.max(3, Math.round(sides) || 3);
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  return fitToBox(pts, w, h);
}

/** Star with `sides` points; inner vertices at `innerRatio` of the outer radius, fitted to the box. */
export function starPoints(sides: number, innerRatio: number, w: number, h: number): Point[] {
  const n = Math.max(2, Math.round(sides) || 5);
  const ir = Math.min(1, Math.max(0.01, Number.isFinite(innerRatio) ? innerRatio : 0.5));
  const pts: Point[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? 1 : ir;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return fitToBox(pts, w, h);
}

/**
 * Thick line along the box diagonal (top-left → bottom-right) as a polygon with butt ends.
 * The line's endpoints are inset so the polygon stays inside the box where possible.
 */
export function linePolygon(w: number, h: number, lineWidth: number): Point[] {
  const lw = Math.max(0.5, lineWidth);
  const len = Math.hypot(w, h);
  if (len < 1e-6) {
    return [
      { x: -lw / 2, y: -lw / 2 },
      { x: lw / 2, y: -lw / 2 },
      { x: lw / 2, y: lw / 2 },
      { x: -lw / 2, y: lw / 2 },
    ];
  }
  // Unit normal of the diagonal.
  const nx = -h / len;
  const ny = w / len;
  const hx = (nx * lw) / 2;
  const hy = (ny * lw) / 2;
  return [
    { x: hx, y: hy },
    { x: w + hx, y: h + hy },
    { x: w - hx, y: h - hy },
    { x: -hx, y: -hy },
  ];
}

/**
 * Rounded-corner polygon path commands: returns a list of drawing ops suitable for Path2D
 * (moveTo / arcTo / closePath). Radius is clamped per corner to half the shorter adjacent edge.
 */
export function roundedPolygonOps(pts: Point[], radius: number): ({ op: 'M'; x: number; y: number } | { op: 'A'; x1: number; y1: number; x2: number; y2: number; r: number } | { op: 'Z' })[] {
  const n = pts.length;
  if (n < 3 || radius <= 0) {
    return [...pts.map((p, i) => (i === 0 ? { op: 'M' as const, x: p.x, y: p.y } : { op: 'A' as const, x1: p.x, y1: p.y, x2: p.x, y2: p.y, r: 0 })), { op: 'Z' as const }];
  }
  const ops: ({ op: 'M'; x: number; y: number } | { op: 'A'; x1: number; y1: number; x2: number; y2: number; r: number } | { op: 'Z' })[] = [];
  // Start at the midpoint of the last edge so every corner is rounded.
  const last = pts[n - 1];
  const first = pts[0];
  ops.push({ op: 'M', x: (last.x + first.x) / 2, y: (last.y + first.y) / 2 });
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const lPrev = Math.hypot(p.x - prev.x, p.y - prev.y);
    const lNext = Math.hypot(next.x - p.x, next.y - p.y);
    // arcTo radius → tangent distance = r / tan(θ/2); clamp the tangent distance to half the edges.
    const v1x = (prev.x - p.x) / (lPrev || 1);
    const v1y = (prev.y - p.y) / (lPrev || 1);
    const v2x = (next.x - p.x) / (lNext || 1);
    const v2y = (next.y - p.y) / (lNext || 1);
    const cos = Math.max(-1, Math.min(1, v1x * v2x + v1y * v2y));
    const theta = Math.acos(cos);
    const tanHalf = Math.tan(theta / 2);
    const maxTangent = Math.min(lPrev, lNext) / 2;
    let r = radius;
    if (tanHalf > 1e-6 && r / tanHalf > maxTangent) r = maxTangent * tanHalf;
    ops.push({ op: 'A', x1: p.x, y1: p.y, x2: next.x, y2: next.y, r: Math.max(0, r) });
  }
  ops.push({ op: 'Z' });
  return ops;
}
