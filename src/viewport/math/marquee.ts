/** Pure marquee geometry + modifier semantics (unit-tested). */
import type { Point, Rect, Selection } from '../../core/types';

export type MarqueeStyle = 'normal' | 'ratio' | 'size';

/**
 * Marquee rectangle from the anchor `a` and current point `b`.
 * Shift = square (normal style), Alt = from center; 'ratio' keeps width:height, 'size' is a
 * fixed W×H box placed at `b` (centered on it with Alt).
 */
export function marqueeRect(
  a: Point,
  b: Point,
  o: { shift: boolean; alt: boolean; style: MarqueeStyle; width: number; height: number },
): Rect {
  if (o.style === 'size') {
    const w = Math.max(1, o.width);
    const h = Math.max(1, o.height);
    return o.alt ? { x: b.x - w / 2, y: b.y - h / 2, width: w, height: h } : { x: b.x, y: b.y, width: w, height: h };
  }
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (o.style === 'ratio' && o.width > 0 && o.height > 0) {
    const ratio = o.width / o.height;
    if (Math.abs(dx) / ratio >= Math.abs(dy)) dy = (Math.sign(dy) || 1) * (Math.abs(dx) / ratio);
    else dx = (Math.sign(dx) || 1) * Math.abs(dy) * ratio;
  } else if (o.shift) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (Math.sign(dx) || 1) * s;
    dy = (Math.sign(dy) || 1) * s;
  }
  if (o.alt) return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

export interface ModifierLatch {
  /** Constrain (square) is active. */
  shift: boolean;
  /** From-center is active. */
  alt: boolean;
  /** Shift was held at mouse-down to pick the selection mode; ignored until released once. */
  shiftLatch: boolean;
  altLatch: boolean;
}

/**
 * Photoshop semantics: with an existing selection, Shift/Alt held at mouse-down choose
 * add/subtract; they start constraining only after being released and pressed again.
 */
export function latchModifiers(m: ModifierLatch, shiftKey: boolean, altKey: boolean): void {
  if (m.shiftLatch && !shiftKey) m.shiftLatch = false;
  if (m.altLatch && !altKey) m.altLatch = false;
  m.shift = shiftKey && !m.shiftLatch;
  m.alt = altKey && !m.altLatch;
}

/**
 * True when a selection's vector shape can stand in for its mask: the shape must lie inside the
 * canvas (masks are always clipped to it). Shapes reaching past an edge fall back to the mask.
 */
export function shapeInsideCanvas(shape: Selection['shape'], width: number, height: number): boolean {
  if (!shape) return false;
  const r = shape.rect;
  const e = 1e-6;
  return r.width > 0 && r.height > 0 && r.x >= -e && r.y >= -e && r.x + r.width <= width + e && r.y + r.height <= height + e;
}
