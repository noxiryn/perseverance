/** Pure drag geometry for the shape tools (no DOM). */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DragInput {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Constrain proportions (Shift). */
  shift: boolean;
  /** Draw from the center (Alt). */
  alt: boolean;
  /** Width / height ratio used by Shift (1 = square/circle; custom shapes use their own). */
  aspect?: number;
}

/** Box spanned by a drag, honoring Shift (proportions) and Alt (from center). */
export function dragBox(i: DragInput): Box {
  let dx = i.x1 - i.x0;
  let dy = i.y1 - i.y0;
  if (i.shift) {
    const a = i.aspect && Number.isFinite(i.aspect) && i.aspect > 0 ? i.aspect : 1;
    const w = Math.max(Math.abs(dx), Math.abs(dy) * a);
    const h = w / a;
    dx = (dx < 0 ? -1 : 1) * w;
    dy = (dy < 0 ? -1 : 1) * h;
  }
  if (i.alt) {
    return { x: i.x0 - Math.abs(dx), y: i.y0 - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
  }
  return { x: Math.min(i.x0, i.x0 + dx), y: Math.min(i.y0, i.y0 + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

export interface LineGeometry extends Box {
  /** The shape draws its line along the box diagonal TL→BR; flip horizontally for TR→BL lines. */
  flipX: boolean;
  /** Final endpoints (after constraints). */
  p0: { x: number; y: number };
  p1: { x: number; y: number };
}

/** Line from a drag: Shift snaps to 45° steps, Alt draws from the center. Boxes are at least 1px thick. */
export function lineGeometry(i: DragInput): LineGeometry {
  let dx = i.x1 - i.x0;
  let dy = i.y1 - i.y0;
  if (i.shift) {
    const len = Math.hypot(dx, dy);
    const step = Math.PI / 4;
    const a = Math.round(Math.atan2(dy, dx) / step) * step;
    dx = Math.cos(a) * len;
    dy = Math.sin(a) * len;
    if (Math.abs(dx) < 1e-9) dx = 0;
    if (Math.abs(dy) < 1e-9) dy = 0;
  }
  const p0 = i.alt ? { x: i.x0 - dx, y: i.y0 - dy } : { x: i.x0, y: i.y0 };
  const p1 = { x: i.x0 + dx, y: i.y0 + dy };
  let x = Math.min(p0.x, p1.x);
  let y = Math.min(p0.y, p1.y);
  let w = Math.abs(p1.x - p0.x);
  let h = Math.abs(p1.y - p0.y);
  if (w < 1) {
    x -= (1 - w) / 2;
    w = 1;
  }
  if (h < 1) {
    y -= (1 - h) / 2;
    h = 1;
  }
  const flipX = (p1.x - p0.x) * (p1.y - p0.y) < 0;
  return { x, y, w, h, flipX, p0, p1 };
}

/** Default box for a click without drag: `size` centered on the point. */
export function clickBox(x: number, y: number, size: number, aspect = 1): Box {
  const w = aspect >= 1 ? size : size * aspect;
  const h = aspect >= 1 ? size / aspect : size;
  return { x: x - w / 2, y: y - h / 2, w, h };
}
