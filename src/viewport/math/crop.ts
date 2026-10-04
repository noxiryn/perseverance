/** Pure crop-box math (resize with handles, ratio constraints, drawing a new box). */
import type { Point, Rect } from '../../core/types';

export type BoxHandle = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l';

export const BOX_HANDLES: BoxHandle[] = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];

/** Handle position as fractions of the box. */
export const HANDLE_FRAC: Record<BoxHandle, [number, number]> = {
  tl: [0, 0],
  t: [0.5, 0],
  tr: [1, 0],
  r: [1, 0.5],
  br: [1, 1],
  b: [0.5, 1],
  bl: [0, 1],
  l: [0, 0.5],
};

function dirs(h: BoxHandle): [number, number] {
  const hx = h.includes('l') ? -1 : h.includes('r') ? 1 : 0;
  const hy = h.includes('t') ? -1 : h.includes('b') ? 1 : 0;
  return [hx, hy];
}

const MIN = 1;

/**
 * Resize `box0` by dragging `handle` to `p`. `ratio` = width/height to keep (null = free),
 * `fromCenter` resizes symmetrically around the box center (Alt).
 */
export function resizeBox(box0: Rect, handle: BoxHandle, p: Point, o: { ratio: number | null; fromCenter: boolean }): Rect {
  const [hx, hy] = dirs(handle);
  const L0 = box0.x;
  const T0 = box0.y;
  const R0 = box0.x + box0.width;
  const B0 = box0.y + box0.height;
  const cx = (L0 + R0) / 2;
  const cy = (T0 + B0) / 2;
  const fc = o.fromCenter;
  const ax = fc ? cx : hx < 0 ? R0 : L0;
  const ay = fc ? cy : hy < 0 ? B0 : T0;
  let dx = hx ? p.x - ax : 0;
  let dy = hy ? p.y - ay : 0;
  const ratio = o.ratio && o.ratio > 0 && Number.isFinite(o.ratio) ? o.ratio : null;
  let x0: number, x1: number, y0: number, y1: number;
  if (ratio && hx && hy) {
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx / ratio >= ady) dy = (Math.sign(dy) || hy) * (adx / ratio);
    else dx = (Math.sign(dx) || hx) * ady * ratio;
  }
  if (hx) {
    if (fc) {
      x0 = cx - Math.abs(dx);
      x1 = cx + Math.abs(dx);
    } else {
      x0 = Math.min(ax, ax + dx);
      x1 = Math.max(ax, ax + dx);
    }
  } else if (ratio && hy) {
    const w = Math.abs(dy) * (fc ? 2 : 1) * ratio;
    x0 = cx - w / 2;
    x1 = cx + w / 2;
  } else {
    x0 = L0;
    x1 = R0;
  }
  if (hy) {
    if (fc) {
      y0 = cy - Math.abs(dy);
      y1 = cy + Math.abs(dy);
    } else {
      y0 = Math.min(ay, ay + dy);
      y1 = Math.max(ay, ay + dy);
    }
  } else if (ratio && hx) {
    const h = (Math.abs(dx) * (fc ? 2 : 1)) / ratio;
    y0 = cy - h / 2;
    y1 = cy + h / 2;
  } else {
    y0 = T0;
    y1 = B0;
  }
  return { x: x0, y: y0, width: Math.max(MIN, x1 - x0), height: Math.max(MIN, y1 - y0) };
}

/** Box from a drag a→b (new crop box), optionally constrained to a ratio and/or from center. */
export function boxFromDrag(a: Point, b: Point, o: { ratio: number | null; fromCenter: boolean }): Rect {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const ratio = o.ratio && o.ratio > 0 && Number.isFinite(o.ratio) ? o.ratio : null;
  if (ratio) {
    if (Math.abs(dx) / ratio >= Math.abs(dy)) dy = (Math.sign(dy) || 1) * (Math.abs(dx) / ratio);
    else dx = (Math.sign(dx) || 1) * Math.abs(dy) * ratio;
  }
  if (o.fromCenter) return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

/** Largest box of `ratio` that fits inside `within`, centered on it. */
export function fitRatio(within: Rect, ratio: number): Rect {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return { ...within };
  let w = within.width;
  let h = w / ratio;
  if (h > within.height) {
    h = within.height;
    w = h * ratio;
  }
  return { x: within.x + (within.width - w) / 2, y: within.y + (within.height - h) / 2, width: w, height: h };
}

/** Integer crop rect (rounded) with at least 1×1 px. */
export function roundCropRect(r: Rect): Rect {
  const x0 = Math.round(r.x);
  const y0 = Math.round(r.y);
  const x1 = Math.round(r.x + r.width);
  const y1 = Math.round(r.y + r.height);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}
