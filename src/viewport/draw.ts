/** Screen-space drawing helpers for overlays (handles, labels, boxes). */
import type { Point } from '../core/types';
import { HANDLE } from './state';

/** Square transform handle centered at p. */
export function drawHandle(ctx: CanvasRenderingContext2D, p: Point, size = HANDLE, fill = '#ffffff', stroke = '#1d1d1d') {
  const s = size;
  const x = Math.round(p.x - s / 2) + 0.5;
  const y = Math.round(p.y - s / 2) + 0.5;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.fillRect(x, y, s - 1, s - 1);
  ctx.strokeRect(x, y, s - 1, s - 1);
}

/** Closed polygon through screen points (crisp 1px). */
export function strokePoly(ctx: CanvasRenderingContext2D, pts: Point[], color: string, width = 1, dash?: number[]) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.beginPath();
  const axis = isAxisAlignedPoly(pts);
  const snap = (v: number) => (axis ? Math.round(v) + 0.5 : v);
  ctx.moveTo(snap(pts[0].x), snap(pts[0].y));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(snap(pts[i].x), snap(pts[i].y));
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  ctx.restore();
}

function isAxisAlignedPoly(pts: Point[]): boolean {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) return false;
  }
  return true;
}

/** Small dark pill label (e.g. "W: 120 px  H: 80 px") near a screen point. */
export function drawLabel(ctx: CanvasRenderingContext2D, text: string | string[], at: Point, opts: { align?: 'left' | 'center' } = {}) {
  const lines = Array.isArray(text) ? text : [text];
  ctx.save();
  ctx.font = '500 11px Inter, "Segoe UI", system-ui, sans-serif';
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
  const lh = 15;
  const h = lines.length * lh + 6;
  const cw = ctx.canvas.width / (window.devicePixelRatio || 1);
  const ch = ctx.canvas.height / (window.devicePixelRatio || 1);
  let x = opts.align === 'center' ? at.x - w / 2 : at.x + 16;
  let y = opts.align === 'center' ? at.y : at.y + 18;
  x = Math.max(4, Math.min(x, cw - w - 4));
  y = Math.max(4, Math.min(y, ch - h - 4));
  x = Math.round(x);
  y = Math.round(y);
  ctx.fillStyle = 'rgba(22,22,22,0.92)';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w, h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#e8e8e8';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, x + 7, y + 3 + lh / 2 + i * lh + 0.5));
  ctx.restore();
}

/** Circle handle (pivot / reference point). */
export function drawPivot(ctx: CanvasRenderingContext2D, p: Point) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1d1d1d';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - 8, p.y);
  ctx.lineTo(p.x - 5, p.y);
  ctx.moveTo(p.x + 5, p.y);
  ctx.lineTo(p.x + 8, p.y);
  ctx.moveTo(p.x, p.y - 8);
  ctx.lineTo(p.x, p.y - 5);
  ctx.moveTo(p.x, p.y + 5);
  ctx.lineTo(p.x, p.y + 8);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
  ctx.restore();
}

/** CSS resize cursor for a handle direction (screen angle in degrees). */
export function resizeCursorForAngle(deg: number): string {
  let a = ((deg % 180) + 180) % 180; // 0..180
  // 0 = horizontal (ew), 45 = nwse (down-right), 90 = ns, 135 = nesw
  if (a < 22.5 || a >= 157.5) return 'ew-resize';
  if (a < 67.5) return 'nwse-resize';
  if (a < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

const rotateCursorCache = new Map<number, string>();

/** Curved double-arrow rotate cursor, rotated to the given screen angle (degrees). */
export function rotateCursor(deg: number): string {
  const step = Math.round(deg / 15) * 15;
  const k = ((step % 360) + 360) % 360;
  const hit = rotateCursorCache.get(k);
  if (hit) return hit;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(${k} 12 12)"><path d="M6 15 A8 8 0 0 1 15 6" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round"/><path d="M6 15 A8 8 0 0 1 15 6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M14 2.5 L18.5 6 L14 9.5 Z" fill="#fff" stroke="#000" stroke-width="1"/><path d="M2.5 14 L6 18.5 L9.5 14 Z" fill="#fff" stroke="#000" stroke-width="1"/></g></svg>`;
  const css = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
  rotateCursorCache.set(k, css);
  return css;
}

function svgCursor(svg: string, hx: number, hy: number, fallback: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
}

export const CURSORS = {
  eyedropper: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2.5 21.5l1.2-3.6 9.1-9.1 2.4 2.4-9.1 9.1z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/><path d="M13.6 6.4l2-2a2.4 2.4 0 013.4 3.4l-2 2 1 1-1.4 1.4-5.4-5.4 1.4-1.4z" fill="#000" stroke="#fff" stroke-width="1"/></svg>`,
    2,
    21,
    'crosshair',
  ),
  wand: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M9 9l13 13" stroke="#000" stroke-width="4" stroke-linecap="round"/><path d="M9 9l13 13" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><g stroke="#fff" stroke-width="1.4" stroke-linecap="round"><path d="M5 1v4M5 9v4M1 5h4M9 5h4M2.2 2.2l1.6 1.6M6.2 6.2l1.6 1.6M7.8 2.2L6.2 3.8M3.8 6.2L2.2 7.8"/></g><g stroke="#000" stroke-width="0.6" stroke-linecap="round" opacity="0.7"><path d="M5 1v4M5 9v4M1 5h4M9 5h4"/></g></svg>`,
    5,
    5,
    'crosshair',
  ),
  lasso: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><ellipse cx="13" cy="9" rx="8.5" ry="5.5" fill="none" stroke="#000" stroke-width="3"/><ellipse cx="13" cy="9" rx="8.5" ry="5.5" fill="none" stroke="#fff" stroke-width="1.2"/><path d="M7 13.5c-1.5 1.5-2.5 3.5-4.5 7.5" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round"/><path d="M7 13.5c-1.5 1.5-2.5 3.5-4.5 7.5" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    2,
    21,
    'crosshair',
  ),
  polyLasso: svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M4 4l15 3-4 11-6-5z" fill="none" stroke="#000" stroke-width="3" stroke-linejoin="round"/><path d="M4 4l15 3-4 11-6-5z" fill="none" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 13l-6.5 8.5" stroke="#000" stroke-width="3" stroke-linecap="round"/><path d="M9 13l-6.5 8.5" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    2,
    21,
    'crosshair',
  ),
  crosshairPlus: (sign: '+' | '-' | '×' | '') => crosshairCursor(sign),
};

const crossCache = new Map<string, string>();
function crosshairCursor(sign: '+' | '-' | '×' | ''): string {
  const hit = crossCache.get(sign);
  if (hit) return hit;
  const css = svgCursor(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g stroke="#000" stroke-width="3" stroke-linecap="square"><path d="M9 1v6M9 11v6M1 9h6M11 9h6"/></g><g stroke="#fff" stroke-width="1"><path d="M9 1.5v5.5M9 11v5.5M1.5 9h5.5M11 9h5.5"/></g>${
        sign === '+'
          ? '<path d="M19 15v6M16 18h6" stroke="#000" stroke-width="3"/><path d="M19 15.5v5M16.5 18h5" stroke="#fff" stroke-width="1.2"/>'
          : sign === '-'
            ? '<path d="M16 18h6" stroke="#000" stroke-width="3"/><path d="M16.5 18h5" stroke="#fff" stroke-width="1.2"/>'
            : sign === '×'
              ? '<path d="M16 15l6 6M22 15l-6 6" stroke="#000" stroke-width="3"/><path d="M16.5 15.5l5 5M21.5 15.5l-5 5" stroke="#fff" stroke-width="1.2"/>'
              : ''
      }</svg>`,
      9,
      9,
      'crosshair',
    );
  crossCache.set(sign, css);
  return css;
}
