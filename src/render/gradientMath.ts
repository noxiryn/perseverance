/**
 * Pure gradient geometry shared by paints, fill layers and gradient effects.
 *
 * Conventions (documented for other modules):
 *  - `angle` in degrees: 0 = left→right, 90 = top→bottom (y-down document space).
 *  - `scale` 1 = the gradient spans the target box (linear/reflected: the box extent along the
 *    gradient direction; radial: half the box diagonal; diamond: half the box's |w|+|h|).
 *  - `offsetX/offsetY` move the gradient center by a fraction of the box half-size
 *    (±1 = the box edge).
 *  - `reverse` flips the stops.
 */
import type { Gradient, GradientStop, Rect } from '../core/types';

export interface StopSpec {
  offset: number;
  color: string;
}

export type GradientGeometry =
  | { kind: 'linear' | 'reflected'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'radial'; cx: number; cy: number; r: number }
  | { kind: 'angle'; cx: number; cy: number; startAngle: number }
  | { kind: 'diamond'; cx: number; cy: number; r: number; theta: number };

const DEG = Math.PI / 180;

export function gradientCenter(g: Gradient, box: Rect): { cx: number; cy: number } {
  return {
    cx: box.x + box.width / 2 + ((g.offsetX ?? 0) * box.width) / 2,
    cy: box.y + box.height / 2 + ((g.offsetY ?? 0) * box.height) / 2,
  };
}

/** Geometry of a gradient laid over `box`. */
export function gradientGeometry(g: Gradient, box: Rect): GradientGeometry {
  const { cx, cy } = gradientCenter(g, box);
  const scale = Number.isFinite(g.scale) && g.scale > 0 ? g.scale : 1;
  const th = (g.angle || 0) * DEG;
  const dx = Math.cos(th);
  const dy = Math.sin(th);
  switch (g.kind) {
    case 'radial':
      return { kind: 'radial', cx, cy, r: Math.max(0.5, (Math.hypot(box.width, box.height) / 2) * scale) };
    case 'angle':
      return { kind: 'angle', cx, cy, startAngle: th };
    case 'diamond':
      return { kind: 'diamond', cx, cy, r: Math.max(0.5, ((Math.abs(box.width) + Math.abs(box.height)) / 2) * scale * 0.5), theta: th };
    case 'reflected':
    case 'linear':
    default: {
      const len = Math.max(0.5, (Math.abs(box.width * dx) + Math.abs(box.height * dy)) * scale);
      return {
        kind: g.kind === 'reflected' ? 'reflected' : 'linear',
        x0: cx - (dx * len) / 2,
        y0: cy - (dy * len) / 2,
        x1: cx + (dx * len) / 2,
        y1: cy + (dy * len) / 2,
      };
    }
  }
}

/** Sorted, clamped stops with `reverse` applied. Always returns at least one stop. */
export function normalizedStops(g: Pick<Gradient, 'stops' | 'reverse'>): StopSpec[] {
  const src: GradientStop[] = g.stops?.length ? g.stops : [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }];
  const stops = src.map((s) => ({ offset: Math.min(1, Math.max(0, Number(s.offset) || 0)), color: s.color }));
  if (g.reverse) for (const s of stops) s.offset = 1 - s.offset;
  stops.sort((a, b) => a.offset - b.offset);
  return stops;
}

/**
 * Stops for a reflected gradient drawn as one linear gradient over the full (start→end) line:
 * stop 0 sits in the middle and stop 1 at both ends.
 */
export function reflectedStops(stops: StopSpec[]): StopSpec[] {
  const out: StopSpec[] = [];
  for (let i = stops.length - 1; i >= 0; i--) out.push({ offset: 0.5 - stops[i].offset / 2, color: stops[i].color });
  for (const s of stops) out.push({ offset: 0.5 + s.offset / 2, color: s.color });
  return out;
}

/** Gradient parameter t (0..1, unclamped) of a diamond gradient at a point. */
export function diamondT(geom: { cx: number; cy: number; r: number; theta: number }, x: number, y: number): number {
  const c = Math.cos(-geom.theta);
  const s = Math.sin(-geom.theta);
  const px = x - geom.cx;
  const py = y - geom.cy;
  const u = px * c - py * s;
  const v = px * s + py * c;
  return (Math.abs(u) + Math.abs(v)) / geom.r;
}

/**
 * The four linear gradients that make up a diamond gradient (one per quadrant in the gradient's
 * rotated frame). In quadrant (sx, sy) t = (sx·u + sy·v) / r is linear, so each quadrant is an
 * exact native linear gradient. Returned in un-rotated (document) coordinates, with the
 * quadrant polygon (slightly overlapping its neighbours to avoid AA seams).
 */
export function diamondQuadrants(
  geom: { cx: number; cy: number; r: number; theta: number },
  extent: number,
): { x0: number; y0: number; x1: number; y1: number; poly: [number, number][] }[] {
  const c = Math.cos(geom.theta);
  const s = Math.sin(geom.theta);
  const toDoc = (u: number, v: number): [number, number] => [geom.cx + u * c - v * s, geom.cy + u * s + v * c];
  const out: { x0: number; y0: number; x1: number; y1: number; poly: [number, number][] }[] = [];
  const E = extent;
  const o = 1; // overlap in px
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      // t = (sx*u + sy*v)/r → gradient vector along (sx, sy)/2 * r reaches t=1 at (sx r/2, sy r/2)
      const [x0, y0] = toDoc(0, 0);
      const [x1, y1] = toDoc((sx * geom.r) / 2, (sy * geom.r) / 2);
      const poly: [number, number][] = [toDoc(-o * sx, -o * sy), toDoc(E * sx, -o * sy), toDoc(E * sx, E * sy), toDoc(-o * sx, E * sy)];
      out.push({ x0, y0, x1, y1, poly });
    }
  }
  return out;
}
