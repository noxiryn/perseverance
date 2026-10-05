/**
 * Re-express a gradient laid over one box so it renders identically when laid over another box
 * (pure). Used when text becomes a shape: the text paints its gradient over the layout box, the
 * shape over its own (tight) box, and the colours must not move.
 *
 * Conventions follow render/gradientMath.ts: the center is the box center moved by
 * offsetX/offsetY × half the box size; `scale` 1 spans the box (linear/reflected: box extent along
 * the gradient direction, radial: half the diagonal, diamond: a quarter of |w|+|h|).
 */
import type { Gradient, Rect } from '../../core/types';

const DEG = Math.PI / 180;

function extentFor(g: Gradient, w: number, h: number): number {
  switch (g.kind) {
    case 'radial':
      return Math.hypot(w, h) / 2;
    case 'diamond':
      return (Math.abs(w) + Math.abs(h)) / 4;
    case 'angle':
      return 1; // conic gradients have no extent
    default: {
      const th = (g.angle || 0) * DEG;
      return Math.abs(w * Math.cos(th)) + Math.abs(h * Math.sin(th));
    }
  }
}

export function remapGradient(g: Gradient, from: Rect, to: Rect): Gradient {
  const scale = Number.isFinite(g.scale) && g.scale > 0 ? g.scale : 1;
  const cx = from.x + from.width / 2 + ((g.offsetX ?? 0) * from.width) / 2;
  const cy = from.y + from.height / 2 + ((g.offsetY ?? 0) * from.height) / 2;
  const hw = to.width / 2;
  const hh = to.height / 2;
  const out: Gradient = structuredClone(g);
  out.offsetX = hw > 1e-9 ? (cx - (to.x + hw)) / hw : 0;
  out.offsetY = hh > 1e-9 ? (cy - (to.y + hh)) / hh : 0;
  if (g.kind !== 'angle') {
    const eFrom = extentFor(g, from.width, from.height) * scale;
    const eTo = extentFor(g, to.width, to.height);
    out.scale = eTo > 1e-9 ? eFrom / eTo : scale;
  }
  return out;
}
