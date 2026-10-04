/**
 * Selection outlines for marching ants. Vector selections (rect/ellipse) produce exact paths;
 * mask selections are contoured with marching squares (cached per bitmap id + version + bounds).
 *
 * Screen paths are pixel-snapped (vertex → round(v) + 0.5 CSS px) whenever the doc → screen
 * mapping is axis-aligned, so the 1px ants are crisp at any zoom and any integer DPR.
 */
import type { Rect, Selection } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { ctxRead } from '../core/canvas';
import { traceContours } from './math/contours';
import type { Affine } from './math/affine';

interface Entry {
  key: string;
  contours: Float32Array[];
  /** Same contours as a document-space Path2D (for non axis-aligned mappings). */
  path: Path2D;
  points: number;
}

const cache: Entry[] = [];
const MAX = 4;
/** Above this many contour points the snapped screen path is not rebuilt (use addPath instead). */
const SNAP_LIMIT = 120_000;

function shapePath(shape: NonNullable<Selection['shape']>): Path2D {
  const p = new Path2D();
  const r = shape.rect;
  if (shape.type === 'rect') p.rect(r.x, r.y, r.width, r.height);
  else p.ellipse(r.x + r.width / 2, r.y + r.height / 2, Math.abs(r.width / 2), Math.abs(r.height / 2), 0, 0, Math.PI * 2);
  return p;
}

function boundsKey(bounds?: Rect | null): string {
  return bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : 'all';
}

/** Marching-squares contours of a mask bitmap's alpha ≥ 50% region within `bounds` (cached). */
function maskEntry(bitmapId: string, bounds?: Rect | null): Entry | null {
  const bmp = bitmaps.tryGet(bitmapId);
  if (!bmp) return null;
  const key = `${bitmapId}:${bitmaps.version(bitmapId)}:${boundsKey(bounds)}`;
  const idx = cache.findIndex((e) => e.key === key);
  if (idx >= 0) {
    const hit = cache[idx];
    if (idx > 0) {
      cache.splice(idx, 1);
      cache.unshift(hit);
    }
    return hit;
  }
  // Region of interest (bounds padded by 1px, clamped to the bitmap).
  const x0 = Math.max(0, Math.floor((bounds?.x ?? 0) - 1));
  const y0 = Math.max(0, Math.floor((bounds?.y ?? 0) - 1));
  const x1 = Math.min(bmp.width, Math.ceil((bounds ? bounds.x + bounds.width : bmp.width) + 1));
  const y1 = Math.min(bmp.height, Math.ceil((bounds ? bounds.y + bounds.height : bmp.height) + 1));
  const path = new Path2D();
  let points = 0;
  let contours: Float32Array[] = [];
  if (x1 > x0 && y1 > y0) {
    let data: Uint8ClampedArray;
    try {
      data = ctxRead(bmp).getImageData(x0, y0, x1 - x0, y1 - y0).data;
    } catch {
      return null;
    }
    contours = traceContours({ data, width: x1 - x0, height: y1 - y0, stride: 4, offset: 3, originX: x0, originY: y0 });
    for (const c of contours) {
      path.moveTo(c[0], c[1]);
      for (let i = 2; i < c.length; i += 2) path.lineTo(c[i], c[i + 1]);
      path.closePath();
      points += c.length / 2;
    }
  }
  const entry: Entry = { key, contours, path, points };
  cache.unshift(entry);
  if (cache.length > MAX) cache.length = MAX;
  return entry;
}

/** Path2D (document coordinates) outlining a mask bitmap's alpha ≥ 50% region within `bounds`. */
export function maskOutline(bitmapId: string, bounds?: Rect | null): Path2D | null {
  return maskEntry(bitmapId, bounds)?.path ?? null;
}

/** Outline of a selection in document coordinates. */
export function selectionOutline(sel: Selection | null | undefined): Path2D | null {
  if (!sel) return null;
  if (sel.shape) return shapePath(sel.shape);
  return maskOutline(sel.bitmapId, sel.bounds);
}

/* ------------------------------------------------------------------ */
/* Screen-space paths                                                  */
/* ------------------------------------------------------------------ */

const snap = (v: number) => Math.round(v) + 0.5;

function axisAligned(m: Affine): boolean {
  return Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
}

let screenCache: { key: string; m: Affine; path: Path2D } | null = null;

function sameMatrix(a: Affine, b: Affine): boolean {
  return a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.e === b.e && a.f === b.f;
}

/**
 * Screen-space (CSS px) outline of a selection under the doc → screen matrix `m` (zoom/pan,
 * optionally pre-multiplied by a live transform). Crisp (pixel-snapped) when `m` is axis-aligned.
 */
export function selectionScreenPath(sel: Selection | null | undefined, m: Affine): Path2D | null {
  if (!sel) return null;
  const aligned = axisAligned(m);
  if (sel.shape) {
    const r = sel.shape.rect;
    if (!aligned) {
      const p = new Path2D();
      p.addPath(shapePath(sel.shape), new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]));
      return p;
    }
    const ax = m.a * r.x + m.e;
    const bx = m.a * (r.x + r.width) + m.e;
    const ay = m.d * r.y + m.f;
    const by = m.d * (r.y + r.height) + m.f;
    const p = new Path2D();
    if (sel.shape.type === 'rect') {
      const x0 = snap(Math.min(ax, bx));
      const y0 = snap(Math.min(ay, by));
      const x1 = snap(Math.max(ax, bx));
      const y1 = snap(Math.max(ay, by));
      p.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    } else {
      p.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
    }
    return p;
  }
  const e = maskEntry(sel.bitmapId, sel.bounds);
  if (!e) return null;
  if (!aligned || e.points > SNAP_LIMIT) {
    const p = new Path2D();
    p.addPath(e.path, new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]));
    return p;
  }
  if (screenCache && screenCache.key === e.key && sameMatrix(screenCache.m, m)) return screenCache.path;
  const p = new Path2D();
  const { a, d, e: tx, f: ty } = m;
  for (const c of e.contours) {
    let px = snap(a * c[0] + tx);
    let py = snap(d * c[1] + ty);
    p.moveTo(px, py);
    for (let i = 2; i < c.length; i += 2) {
      const x = snap(a * c[i] + tx);
      const y = snap(d * c[i + 1] + ty);
      if (x === px && y === py) continue; // collapsed at low zoom
      p.lineTo(x, y);
      px = x;
      py = y;
    }
    p.closePath();
  }
  screenCache = { key: e.key, m: { ...m }, path: p };
  return p;
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

/** Marching ants for a selection under the doc → screen matrix `m` (crisp when axis-aligned). */
export function drawSelectionAnts(ctx: CanvasRenderingContext2D, sel: Selection | null | undefined, m: Affine, opts: { animate?: boolean } = {}) {
  const p = selectionScreenPath(sel, m);
  if (p) strokeAnts(ctx, p, opts);
}

/**
 * Stroke a document-space path as marching ants. `toScreen` maps doc → screen CSS px
 * (e.g. zoom/pan, optionally pre-multiplied by a live transform).
 */
export function drawAnts(ctx: CanvasRenderingContext2D, docPath: Path2D, toScreen: Affine, opts: { animate?: boolean } = {}) {
  const p = new Path2D();
  p.addPath(docPath, new DOMMatrix([toScreen.a, toScreen.b, toScreen.c, toScreen.d, toScreen.e, toScreen.f]));
  strokeAnts(ctx, p, opts);
}

/** Stroke a screen-space path as marching ants. */
export function strokeAnts(ctx: CanvasRenderingContext2D, p: Path2D, opts: { animate?: boolean } = {}) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
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
