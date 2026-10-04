/**
 * Pure geometry helpers for the Properties panel (transform fields) and the Layer ▸ Align /
 * Distribute commands.
 */
import type { Rect, Transform } from '../core/types';

/* ------------------------------------------------------------------ */
/* Align & distribute                                                  */
/* ------------------------------------------------------------------ */

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Translation that aligns `b` to `target` along one axis. */
export function alignDelta(b: Rect, target: Rect, mode: AlignMode): { dx: number; dy: number } {
  switch (mode) {
    case 'left':
      return { dx: target.x - b.x, dy: 0 };
    case 'hcenter':
      return { dx: target.x + target.width / 2 - (b.x + b.width / 2), dy: 0 };
    case 'right':
      return { dx: target.x + target.width - (b.x + b.width), dy: 0 };
    case 'top':
      return { dx: 0, dy: target.y - b.y };
    case 'vcenter':
      return { dx: 0, dy: target.y + target.height / 2 - (b.y + b.height / 2) };
    case 'bottom':
      return { dx: 0, dy: target.y + target.height - (b.y + b.height) };
  }
}

export type DistributeMode = 'centers' | 'spacing';

/**
 * Deltas that distribute rects evenly along an axis. The outermost rects stay in place.
 * 'centers' spaces the centers evenly; 'spacing' makes the gaps between rects equal.
 * Returned deltas are in the same order as the input.
 */
export function distributeDeltas(rects: Rect[], axis: 'h' | 'v', mode: DistributeMode): { dx: number; dy: number }[] {
  const out = rects.map(() => ({ dx: 0, dy: 0 }));
  if (rects.length < 3) return out;
  const pos = (r: Rect) => (axis === 'h' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'h' ? r.width : r.height);
  const order = rects.map((r, i) => ({ r, i })).sort((a, b) => pos(a.r) + size(a.r) / 2 - (pos(b.r) + size(b.r) / 2));
  const first = order[0].r;
  const last = order[order.length - 1].r;
  const set = (i: number, d: number) => {
    if (axis === 'h') out[i].dx = d;
    else out[i].dy = d;
  };
  if (mode === 'centers') {
    const c0 = pos(first) + size(first) / 2;
    const c1 = pos(last) + size(last) / 2;
    const step = (c1 - c0) / (order.length - 1);
    order.forEach(({ r, i }, k) => set(i, c0 + step * k - (pos(r) + size(r) / 2)));
  } else {
    const span = pos(last) + size(last) - pos(first);
    const total = order.reduce((s, o) => s + size(o.r), 0);
    const gap = (span - total) / (order.length - 1);
    let cursor = pos(first);
    order.forEach(({ r, i }) => {
      set(i, cursor - pos(r));
      cursor += size(r) + gap;
    });
  }
  return out;
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/* ------------------------------------------------------------------ */
/* Transform fields                                                    */
/* ------------------------------------------------------------------ */

/**
 * The layer box as shown in the Properties panel: the scaled (unrotated) box. X/Y are its
 * top-left corner, W/H its size; rotation pivots on the center (like the transform itself).
 */
export interface VisualBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function visualBox(t: Transform, w: number, h: number): VisualBox {
  const width = w * Math.abs(t.scaleX);
  const height = h * Math.abs(t.scaleY);
  const cx = t.x + w / 2;
  const cy = t.y + h / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** Move the visual box so its top-left lands at (x, y). */
export function withVisualPosition(t: Transform, w: number, h: number, pos: { x?: number; y?: number }): Transform {
  const b = visualBox(t, w, h);
  const nx = pos.x ?? b.x;
  const ny = pos.y ?? b.y;
  return { ...t, x: t.x + (nx - b.x), y: t.y + (ny - b.y) };
}

/**
 * Resize the visual box keeping its top-left corner fixed. With `keepAspect`, changing one side
 * scales the other proportionally. Flips (negative scale) are preserved.
 */
export function withVisualSize(
  t: Transform,
  w: number,
  h: number,
  size: { width?: number; height?: number },
  keepAspect: boolean,
): Transform {
  const b = visualBox(t, w, h);
  const minPx = 1;
  let sx = Math.abs(t.scaleX) || 1e-6;
  let sy = Math.abs(t.scaleY) || 1e-6;
  if (size.width !== undefined) {
    const nsx = Math.max(minPx, size.width) / Math.max(1e-6, w);
    if (keepAspect) sy *= nsx / sx;
    sx = nsx;
  }
  if (size.height !== undefined) {
    const nsy = Math.max(minPx, size.height) / Math.max(1e-6, h);
    if (keepAspect && size.width === undefined) sx *= nsy / sy;
    sy = nsy;
  }
  const next: Transform = { ...t, scaleX: Math.sign(t.scaleX || 1) * sx, scaleY: Math.sign(t.scaleY || 1) * sy };
  // Keep the top-left corner of the visual box where it was.
  const nb = visualBox(next, w, h);
  return { ...next, x: next.x + (b.x - nb.x), y: next.y + (b.y - nb.y) };
}

export function flippedTransform(t: Transform, axis: 'h' | 'v'): Transform {
  return axis === 'h' ? { ...t, scaleX: -t.scaleX } : { ...t, scaleY: -t.scaleY };
}

/** Identity scale/rotation/skew around the same center. */
export function resetTransform(t: Transform): Transform {
  return { ...t, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0 };
}

/** Normalize an angle to (-180, 180]. */
export function normalizeAngle(a: number): number {
  let r = a % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r;
}
