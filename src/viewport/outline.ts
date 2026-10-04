/**
 * Selection outlines for marching ants. Vector selections (rect/ellipse) produce exact paths;
 * mask selections are contoured with marching squares (cached per bitmap id + version).
 */
import type { Rect, Selection } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { ctxRead } from '../core/canvas';
import { traceContours } from './math/contours';
import type { Affine } from './math/affine';

interface Entry {
  key: string;
  path: Path2D;
  points: number;
}

const cache: Entry[] = [];
const MAX = 4;

function shapePath(shape: NonNullable<Selection['shape']>): Path2D {
  const p = new Path2D();
  const r = shape.rect;
  if (shape.type === 'rect') p.rect(r.x, r.y, r.width, r.height);
  else p.ellipse(r.x + r.width / 2, r.y + r.height / 2, Math.abs(r.width / 2), Math.abs(r.height / 2), 0, 0, Math.PI * 2);
  return p;
}

/** Path2D (document coordinates) outlining a mask bitmap's alpha ≥ 50% region within `bounds`. */
export function maskOutline(bitmapId: string, bounds?: Rect | null): Path2D | null {
  const bmp = bitmaps.tryGet(bitmapId);
  if (!bmp) return null;
  const key = `${bitmapId}:${bitmaps.version(bitmapId)}:${bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : 'all'}`;
  const hit = cache.find((e) => e.key === key);
  if (hit) return hit.path;
  // Region of interest (bounds padded by 1px, clamped to the bitmap).
  const x0 = Math.max(0, Math.floor((bounds?.x ?? 0) - 1));
  const y0 = Math.max(0, Math.floor((bounds?.y ?? 0) - 1));
  const x1 = Math.min(bmp.width, Math.ceil((bounds ? bounds.x + bounds.width : bmp.width) + 1));
  const y1 = Math.min(bmp.height, Math.ceil((bounds ? bounds.y + bounds.height : bmp.height) + 1));
  const path = new Path2D();
  let points = 0;
  if (x1 > x0 && y1 > y0) {
    let data: Uint8ClampedArray;
    try {
      data = ctxRead(bmp).getImageData(x0, y0, x1 - x0, y1 - y0).data;
    } catch {
      return null;
    }
    const contours = traceContours({ data, width: x1 - x0, height: y1 - y0, stride: 4, offset: 3, originX: x0, originY: y0 });
    for (const c of contours) {
      path.moveTo(c[0], c[1]);
      for (let i = 2; i < c.length; i += 2) path.lineTo(c[i], c[i + 1]);
      path.closePath();
      points += c.length / 2;
    }
  }
  cache.unshift({ key, path, points });
  if (cache.length > MAX) cache.length = MAX;
  return path;
}

/** Outline of a selection in document coordinates. */
export function selectionOutline(sel: Selection | null | undefined): Path2D | null {
  if (!sel) return null;
  if (sel.shape) return shapePath(sel.shape);
  return maskOutline(sel.bitmapId, sel.bounds);
}

/* ------------------------------------------------------------------ */
/* Marching ants drawing                                               */
/* ------------------------------------------------------------------ */

let animated = false;

/** Called by the viewport at the start of each overlay frame. */
export function resetAntsAnimationFlag() {
  animated = false;
}

/** Whether anything drew animated ants this frame (the viewport then schedules the next tick). */
export function antsAnimatedThisFrame(): boolean {
  return animated;
}

/** Current dash phase (advances ~8 times per second). */
export function antsPhase(): number {
  return Math.floor(performance.now() / 125) % 8;
}

/**
 * Stroke a document-space path as marching ants. `toScreen` maps doc → screen CSS px
 * (e.g. zoom/pan, optionally pre-multiplied by a live transform).
 */
export function drawAnts(ctx: CanvasRenderingContext2D, docPath: Path2D, toScreen: Affine, opts: { animate?: boolean } = {}) {
  const p = new Path2D();
  // +0.5 so 1px lines on pixel boundaries are crisp.
  p.addPath(docPath, new DOMMatrix([toScreen.a, toScreen.b, toScreen.c, toScreen.d, toScreen.e + 0.5, toScreen.f + 0.5]));
  strokeAnts(ctx, p, opts);
}

/** Stroke a screen-space path as marching ants. */
export function strokeAnts(ctx: CanvasRenderingContext2D, p: Path2D, opts: { animate?: boolean } = {}) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = '#ffffff';
  ctx.setLineDash([]);
  ctx.stroke(p);
  ctx.strokeStyle = '#000000';
  ctx.setLineDash([4, 4]);
  if (opts.animate !== false) {
    ctx.lineDashOffset = -antsPhase();
    animated = true;
  }
  ctx.stroke(p);
  ctx.restore();
}
