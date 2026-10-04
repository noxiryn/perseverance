/**
 * Rulers (18px, top + left) with px ticks/labels, the document span shaded, and cursor markers.
 * `rulerTicks` is pure (unit-tested); `drawRulers` paints into the overlay (screen space, CSS px).
 */
import type { Point } from '../core/types';
import { RULER } from './state';

const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];

export interface TickSpec {
  /** Labelled step in document px. */
  major: number;
  /** Number of subdivisions between majors (minor ticks). */
  divisions: number;
}

/** Choose a labelled step ≥ minLabelPx apart on screen and minor subdivisions ≥ minTickPx apart. */
export function rulerTicks(zoom: number, minLabelPx = 56, minTickPx = 5): TickSpec {
  const z = Math.max(1e-6, zoom);
  let major = NICE[NICE.length - 1];
  for (const n of NICE) {
    if (n * z >= minLabelPx) {
      major = n;
      break;
    }
  }
  let divisions = 1;
  for (const d of [10, 5, 4, 2]) {
    const sub = major / d;
    if ((major >= d ? Number.isInteger(sub) : false) && sub * z >= minTickPx) {
      divisions = d;
      break;
    }
  }
  return { major, divisions };
}

/** Minor tick step in document px (used to snap guides with Shift). */
export function minorStep(zoom: number): number {
  const t = rulerTicks(zoom);
  return t.major / t.divisions;
}

export interface RulerDrawArgs {
  width: number;
  height: number;
  /** Screen position of the document origin. */
  origin: Point;
  zoom: number;
  docW: number;
  docH: number;
  /** Pointer in viewport CSS px (null when outside). */
  pointer: Point | null;
  /** Optional highlighted doc-space span (e.g. the selection / active layer bounds). */
  highlight?: { x: number; y: number; width: number; height: number } | null;
}

const BG = '#181818';
const BG_DOC = '#1f1f1f';
const BORDER = '#2c2c2c';
const TICK = '#5a5a5a';
const TICK_MAJOR = '#7a7a7a';
const LABEL = '#8f8f8f';
const MARK = '#e6e6e6';
const HILITE = 'rgba(139,124,246,0.28)';

export function drawRulers(ctx: CanvasRenderingContext2D, a: RulerDrawArgs) {
  const { width: W, height: H, origin: o, zoom: z } = a;
  const { major, divisions } = rulerTicks(z);
  const minor = major / divisions;
  ctx.save();
  ctx.font = '500 9px Inter, "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;

  /* ---- top ruler ---- */
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, RULER);
  const dx0 = Math.max(RULER, o.x);
  const dx1 = Math.min(W, o.x + a.docW * z);
  if (dx1 > dx0) {
    ctx.fillStyle = BG_DOC;
    ctx.fillRect(dx0, 0, dx1 - dx0, RULER);
  }
  if (a.highlight) {
    const h0 = Math.max(RULER, o.x + a.highlight.x * z);
    const h1 = Math.min(W, o.x + (a.highlight.x + a.highlight.width) * z);
    if (h1 > h0) {
      ctx.fillStyle = HILITE;
      ctx.fillRect(h0, RULER - 3, h1 - h0, 3);
    }
  }
  {
    const first = Math.floor((RULER - o.x) / z / minor) * minor;
    const last = (W - o.x) / z;
    ctx.beginPath();
    let count = 0;
    for (let v = first; v <= last && count < 4000; v += minor, count++) {
      const k = Math.round(v / minor);
      const x = Math.round(o.x + k * minor * z) + 0.5;
      if (x < RULER) continue;
      const isMajor = k % divisions === 0;
      const isHalf = !isMajor && divisions % 2 === 0 && k % (divisions / 2) === 0;
      const len = isMajor ? RULER : isHalf ? 7 : 4;
      ctx.moveTo(x, RULER - len);
      ctx.lineTo(x, RULER);
    }
    ctx.strokeStyle = TICK;
    ctx.stroke();
    ctx.fillStyle = LABEL;
    const firstMajor = Math.floor((RULER - o.x) / z / major) * major;
    for (let v = firstMajor, c = 0; v <= last && c < 1000; v += major, c++) {
      const k = Math.round(v / major) * major;
      const x = Math.round(o.x + k * z);
      if (x < RULER - 1) continue;
      ctx.fillText(String(k), x + 3, 2);
    }
  }

  /* ---- left ruler ---- */
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, RULER, H);
  const dy0 = Math.max(RULER, o.y);
  const dy1 = Math.min(H, o.y + a.docH * z);
  if (dy1 > dy0) {
    ctx.fillStyle = BG_DOC;
    ctx.fillRect(0, dy0, RULER, dy1 - dy0);
  }
  if (a.highlight) {
    const h0 = Math.max(RULER, o.y + a.highlight.y * z);
    const h1 = Math.min(H, o.y + (a.highlight.y + a.highlight.height) * z);
    if (h1 > h0) {
      ctx.fillStyle = HILITE;
      ctx.fillRect(RULER - 3, h0, 3, h1 - h0);
    }
  }
  {
    const first = Math.floor((RULER - o.y) / z / minor) * minor;
    const last = (H - o.y) / z;
    ctx.beginPath();
    let count = 0;
    for (let v = first; v <= last && count < 4000; v += minor, count++) {
      const k = Math.round(v / minor);
      const y = Math.round(o.y + k * minor * z) + 0.5;
      if (y < RULER) continue;
      const isMajor = k % divisions === 0;
      const isHalf = !isMajor && divisions % 2 === 0 && k % (divisions / 2) === 0;
      const len = isMajor ? RULER : isHalf ? 7 : 4;
      ctx.moveTo(RULER - len, y);
      ctx.lineTo(RULER, y);
    }
    ctx.strokeStyle = TICK;
    ctx.stroke();
    ctx.fillStyle = LABEL;
    const firstMajor = Math.floor((RULER - o.y) / z / major) * major;
    for (let v = firstMajor, c = 0; v <= last && c < 1000; v += major, c++) {
      const k = Math.round(v / major) * major;
      const y = Math.round(o.y + k * z);
      if (y < RULER - 1) continue;
      ctx.save();
      ctx.translate(2, y + 3);
      ctx.rotate(Math.PI / 2);
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(k), 0, 0);
      ctx.restore();
    }
  }

  /* ---- borders + corner ---- */
  ctx.strokeStyle = BORDER;
  ctx.beginPath();
  ctx.moveTo(RULER, RULER - 0.5);
  ctx.lineTo(W, RULER - 0.5);
  ctx.moveTo(RULER - 0.5, RULER);
  ctx.lineTo(RULER - 0.5, H);
  ctx.stroke();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, RULER, RULER);
  ctx.strokeStyle = BORDER;
  ctx.strokeRect(0.5, 0.5, RULER - 1, RULER - 1);
  ctx.strokeStyle = TICK_MAJOR;
  ctx.beginPath();
  ctx.moveTo(5, RULER / 2 + 0.5);
  ctx.lineTo(RULER - 5, RULER / 2 + 0.5);
  ctx.moveTo(RULER / 2 + 0.5, 5);
  ctx.lineTo(RULER / 2 + 0.5, RULER - 5);
  ctx.stroke();

  /* ---- cursor markers ---- */
  if (a.pointer) {
    ctx.strokeStyle = MARK;
    ctx.beginPath();
    const px = Math.round(a.pointer.x) + 0.5;
    const py = Math.round(a.pointer.y) + 0.5;
    if (px > RULER) {
      ctx.moveTo(px, 0);
      ctx.lineTo(px, RULER);
    }
    if (py > RULER) {
      ctx.moveTo(0, py);
      ctx.lineTo(RULER, py);
    }
    ctx.setLineDash([2, 1]);
    ctx.stroke();
  }
  ctx.restore();
}

/** Which ruler a screen point is over (null when rulers are hidden or the point is on the canvas). */
export function rulerAt(p: Point, visible: boolean): 'top' | 'left' | 'corner' | null {
  if (!visible) return null;
  const top = p.y < RULER;
  const left = p.x < RULER;
  if (top && left) return 'corner';
  if (top) return 'top';
  if (left) return 'left';
  return null;
}
