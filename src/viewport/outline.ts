/**
 * Selection outlines for marching ants. Vector selections (rect/ellipse lying inside the canvas)
 * produce exact paths; mask selections are contoured with marching squares (cached per bitmap
 * id + version + bounds).
 *
 * Screen paths are pixel-snapped (vertex → round(v) + 0.5 CSS px) whenever the doc → screen
 * mapping is axis-aligned, so the 1px ants are crisp at any zoom and any integer DPR.
 *
 * Performance notes (halftone / non-contiguous wand selections can have tens of thousands of
 * outlines):
 *  - contours are closed with an explicit lineTo back to their first vertex — Chromium's
 *    Path2D.closePath() is super-linear in the number of sub-paths;
 *  - screen paths are built directly from the contour arrays (no document-space Path2D +
 *    addPath) and cached by matrix. The integer part of the translation is applied at draw time,
 *    so panning reuses the cached path;
 *  - very large outlines are rasterized once per dash phase into an offscreen canvas, so overlay
 *    redraws caused by pointer moves are a plain blit, and their animation runs at half rate.
 */
import type { Rect, Selection } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { ctxRead } from '../core/canvas';
import { traceContours } from './math/contours';
import type { Affine } from './math/affine';

interface Entry {
  key: string;
  contours: Float32Array[];
  points: number;
}

const cache: Entry[] = [];
const MAX = 4;
/** Above this many contour vertices the ants are rasterized once per dash phase. */
const RASTER_LIMIT = 30_000;
/** Above this many vertices the ants march at half speed. */
const SLOW_LIMIT = 150_000;

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

/**
 * True when a selection's vector shape can stand in for its mask: the shape must lie inside the
 * canvas (the mask is always clipped to it). Shapes reaching past the edge fall back to the mask.
 */
export function shapeInsideCanvas(shape: Selection['shape'], width: number, height: number): boolean {
  if (!shape) return false;
  const r = shape.rect;
  const e = 1e-6;
  return r.x >= -e && r.y >= -e && r.x + r.width <= width + e && r.y + r.height <= height + e && r.width > 0 && r.height > 0;
}

/** The selection's vector shape when it is usable for drawing (see shapeInsideCanvas). */
function usableShape(sel: Selection): Selection['shape'] {
  if (!sel.shape) return null;
  const bmp = bitmaps.tryGet(sel.bitmapId);
  if (!bmp) return sel.shape;
  return shapeInsideCanvas(sel.shape, bmp.width, bmp.height) ? sel.shape : null;
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
    for (const c of contours) points += c.length / 2;
  }
  const entry: Entry = { key, contours, points };
  cache.unshift(entry);
  if (cache.length > MAX) cache.length = MAX;
  return entry;
}

/** Contours (document coordinates, closed flat [x0, y0, x1, y1, …] polylines) of a mask selection. */
export function maskContours(bitmapId: string, bounds?: Rect | null): Float32Array[] | null {
  return maskEntry(bitmapId, bounds)?.contours ?? null;
}

/* ------------------------------------------------------------------ */
/* Screen-space paths                                                  */
/* ------------------------------------------------------------------ */

/** A screen-space path; draw it translated by (tx, ty) CSS px. */
export interface ScreenPath {
  path: Path2D;
  tx: number;
  ty: number;
  /** Number of vertices (0 for vector shapes). */
  points: number;
  /** Stable identity of the cached geometry (for raster caching), '' when not cached. */
  key: string;
}

const snap = (v: number) => Math.round(v) + 0.5;

function axisAligned(m: Affine): boolean {
  return Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
}

/**
 * Snapped path for an axis-aligned mapping. Built with only the fractional part of the
 * translation (fe, ff) — the integer part is applied at draw time, which keeps the snapping
 * identical and lets panning reuse the cached path.
 */
function buildAlignedPath(contours: Float32Array[], a: number, d: number, fe: number, ff: number): Path2D {
  const p = new Path2D();
  for (const c of contours) {
    const sx = snap(a * c[0] + fe);
    const sy = snap(d * c[1] + ff);
    let px = sx;
    let py = sy;
    let segs = 0;
    for (let i = 2; i < c.length; i += 2) {
      const x = snap(a * c[i] + fe);
      const y = snap(d * c[i + 1] + ff);
      if (x === px && y === py) continue; // collapsed at low zoom
      if (segs === 0) p.moveTo(sx, sy);
      p.lineTo(x, y);
      px = x;
      py = y;
      segs++;
    }
    if (segs > 0 && (px !== sx || py !== sy)) p.lineTo(sx, sy); // close (cheaper than closePath)
  }
  return p;
}

/** Unsnapped path for a general linear mapping (translation applied at draw time). */
function buildLinearPath(contours: Float32Array[], m: Affine): Path2D {
  const p = new Path2D();
  const { a, b, c: cc, d } = m;
  for (const c of contours) {
    const sx = a * c[0] + cc * c[1];
    const sy = b * c[0] + d * c[1];
    p.moveTo(sx, sy);
    for (let i = 2; i < c.length; i += 2) p.lineTo(a * c[i] + cc * c[i + 1], b * c[i] + d * c[i + 1]);
    p.lineTo(sx, sy);
  }
  return p;
}

const screenCache: { key: string; path: Path2D }[] = [];

function cachedPath(key: string, build: () => Path2D): Path2D {
  const i = screenCache.findIndex((e) => e.key === key);
  if (i >= 0) return screenCache[i].path;
  const path = build();
  screenCache.unshift({ key, path });
  if (screenCache.length > 3) screenCache.length = 3;
  return path;
}

/**
 * Screen-space (CSS px) outline of a selection under the doc → screen matrix `m` (zoom/pan,
 * optionally pre-multiplied by a live transform). Crisp (pixel-snapped) when `m` is axis-aligned.
 */
export function selectionScreenPath(sel: Selection | null | undefined, m: Affine): ScreenPath | null {
  if (!sel) return null;
  const aligned = axisAligned(m);
  const shape = usableShape(sel);
  if (shape) {
    const r = shape.rect;
    const p = new Path2D();
    if (!aligned) {
      p.addPath(shapePath(shape), new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]));
      return { path: p, tx: 0, ty: 0, points: 0, key: '' };
    }
    const ax = m.a * r.x + m.e;
    const bx = m.a * (r.x + r.width) + m.e;
    const ay = m.d * r.y + m.f;
    const by = m.d * (r.y + r.height) + m.f;
    if (shape.type === 'rect') {
      const x0 = snap(Math.min(ax, bx));
      const y0 = snap(Math.min(ay, by));
      const x1 = snap(Math.max(ax, bx));
      const y1 = snap(Math.max(ay, by));
      p.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    } else {
      p.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
    }
    return { path: p, tx: 0, ty: 0, points: 0, key: '' };
  }
  const e = maskEntry(sel.bitmapId, sel.bounds);
  if (!e || !e.contours.length) return null;
  if (aligned) {
    const ie = Math.floor(m.e);
    const iff = Math.floor(m.f);
    const fe = m.e - ie;
    const ff = m.f - iff;
    const key = `${e.key}|A|${m.a}|${m.d}|${fe}|${ff}`;
    const path = cachedPath(key, () => buildAlignedPath(e.contours, m.a, m.d, fe, ff));
    return { path, tx: ie, ty: iff, points: e.points, key };
  }
  const key = `${e.key}|L|${m.a}|${m.b}|${m.c}|${m.d}`;
  const path = cachedPath(key, () => buildLinearPath(e.contours, m));
  return { path, tx: m.e, ty: m.f, points: e.points, key };
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

/** Current dash phase (advances ~8 times per second; `slow` halves the rate). */
export function antsPhase(slow = false): number {
  return Math.floor(performance.now() / (slow ? 250 : 125)) % 8;
}

/** Offscreen rendering of very large ants (one dash phase at a time). */
let raster: { id: string; canvas: HTMLCanvasElement } | null = null;

function drawRasterAnts(ctx: CanvasRenderingContext2D, sp: ScreenPath, animate: boolean) {
  const target = ctx.canvas;
  const base = ctx.getTransform();
  const phase = animate ? antsPhase(sp.points > SLOW_LIMIT) : -1;
  const id = `${sp.key}|${sp.tx}|${sp.ty}|${phase}|${target.width}x${target.height}|${base.a},${base.b},${base.c},${base.d},${base.e},${base.f}`;
  if (!raster || raster.id !== id) {
    const c = raster?.canvas ?? document.createElement('canvas');
    if (c.width !== target.width || c.height !== target.height) {
      c.width = target.width;
      c.height = target.height;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(base);
    g.translate(sp.tx, sp.ty);
    strokeAntsRaw(g, sp.path, phase);
    raster = { id, canvas: c };
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(raster.canvas, 0, 0);
  ctx.restore();
  if (animate) animated = true;
}

/** Marching ants for a selection under the doc → screen matrix `m` (crisp when axis-aligned). */
export function drawSelectionAnts(ctx: CanvasRenderingContext2D, sel: Selection | null | undefined, m: Affine, opts: { animate?: boolean } = {}) {
  const sp = selectionScreenPath(sel, m);
  if (!sp) return;
  const animate = opts.animate !== false;
  if (sp.key && sp.points > RASTER_LIMIT) {
    drawRasterAnts(ctx, sp, animate);
    return;
  }
  ctx.save();
  if (sp.tx || sp.ty) ctx.translate(sp.tx, sp.ty);
  strokeAnts(ctx, sp.path, opts);
  ctx.restore();
}

function strokeAntsRaw(ctx: CanvasRenderingContext2D, p: Path2D, phase: number) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#ffffff';
  ctx.setLineDash([]);
  ctx.stroke(p);
  ctx.strokeStyle = '#000000';
  ctx.setLineDash([4, 4]);
  if (phase >= 0) ctx.lineDashOffset = -phase;
  ctx.stroke(p);
  ctx.restore();
}

/** Stroke a screen-space path as marching ants. */
export function strokeAnts(ctx: CanvasRenderingContext2D, p: Path2D, opts: { animate?: boolean } = {}) {
  const animate = opts.animate !== false;
  strokeAntsRaw(ctx, p, animate ? antsPhase() : -1);
  if (animate) animated = true;
}
