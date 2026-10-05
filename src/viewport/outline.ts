/**
 * Selection outlines for marching ants. Vector selections (rect/ellipse lying inside the canvas)
 * produce exact paths; mask selections are contoured with marching squares (cached per bitmap
 * id + version + bounds).
 *
 * Screen paths are pixel-snapped (vertex → round(v) + 0.5 CSS px) whenever the doc → screen
 * mapping is axis-aligned, so the 1px ants are crisp at any zoom and any integer DPR.
 *
 * Performance (halftone / non-contiguous wand or Color Range selections can have tens of
 * thousands of outlines and hundreds of thousands of vertices):
 *  - contours are closed with an explicit lineTo back to their first vertex — Chromium's
 *    Path2D.closePath() is super-linear in the number of sub-paths;
 *  - screen paths are built straight from the contour arrays (no document-space Path2D +
 *    addPath) and cached by matrix; the integer part of the translation is applied at draw time,
 *    so panning reuses the cached path;
 *  - very large outlines are rasterized into a document-anchored offscreen image (the whole
 *    document when it fits a pixel budget, else the visible area plus a margin, with off-screen
 *    contours culled). Two dash phases are cached and alternate, so animation, pointer-move
 *    redraws and panning are plain blits; only zooming re-renders.
 */
import type { Rect, Selection } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { ctxRead } from '../core/canvas';
import { traceContours } from './math/contours';
import { shapeInsideCanvas } from './math/marquee';
import type { Affine } from './math/affine';

export { shapeInsideCanvas };

interface Entry {
  key: string;
  contours: Float32Array[];
  points: number;
  /** Mask (= document) size. */
  width: number;
  height: number;
  /** Per-contour bounding boxes [minX, minY, maxX, maxY] in doc px (built lazily, for culling). */
  boxes: Float32Array | null;
}

const cache: Entry[] = [];
const MAX = 4;
/** Above this many contour vertices (and with an axis-aligned view) the ants are rasterized. */
const LARGE = 60_000;
/** Max device pixels of one cached ants image. */
const BUDGET = 4_200_000;

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
  const entry: Entry = { key, contours, points, width: bmp.width, height: bmp.height, boxes: null };
  cache.unshift(entry);
  if (cache.length > MAX) cache.length = MAX;
  return entry;
}

function boxesOf(e: Entry): Float32Array {
  if (e.boxes) return e.boxes;
  const b = new Float32Array(e.contours.length * 4);
  for (let k = 0; k < e.contours.length; k++) {
    const c = e.contours[k];
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < c.length; i += 2) {
      const x = c[i];
      const y = c[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    b[k * 4] = x0;
    b[k * 4 + 1] = y0;
    b[k * 4 + 2] = x1;
    b[k * 4 + 3] = y1;
  }
  e.boxes = b;
  return b;
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
}

/** Axis-aligned box in "local" screen coordinates (screen minus the integer translation). */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const snap = (v: number) => Math.round(v) + 0.5;
/** Quantized fractional translation (keeps cache keys stable against float noise). */
const frac = (v: number) => Math.round((v - Math.floor(v)) * 64) / 64;

function axisAligned(m: Affine): boolean {
  return Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
}

/**
 * Snapped path for an axis-aligned mapping x → a·x + fe, y → d·y + ff (the integer part of the
 * translation is applied at draw time, which keeps the snapping identical while panning).
 * With `cull`, contours whose box misses it are skipped.
 */
function buildAlignedPath(e: Entry, a: number, d: number, fe: number, ff: number, cull?: Box): Path2D {
  const p = new Path2D();
  const boxes = cull ? boxesOf(e) : null;
  const { contours } = e;
  for (let k = 0; k < contours.length; k++) {
    if (boxes) {
      const ax = a * boxes[k * 4] + fe;
      const bx = a * boxes[k * 4 + 2] + fe;
      const ay = d * boxes[k * 4 + 1] + ff;
      const by = d * boxes[k * 4 + 3] + ff;
      if (Math.max(ax, bx) < cull!.x0 - 2 || Math.min(ax, bx) > cull!.x1 + 2 || Math.max(ay, by) < cull!.y0 - 2 || Math.min(ay, by) > cull!.y1 + 2) continue;
    }
    const c = contours[k];
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

function vectorScreenPath(shape: NonNullable<Selection['shape']>, m: Affine): ScreenPath {
  const r = shape.rect;
  const p = new Path2D();
  if (!axisAligned(m)) {
    p.addPath(shapePath(shape), new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]));
    return { path: p, tx: 0, ty: 0, points: 0 };
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
  return { path: p, tx: 0, ty: 0, points: 0 };
}

function maskScreenPath(e: Entry, m: Affine): ScreenPath {
  if (axisAligned(m)) {
    const fe = frac(m.e);
    const ff = frac(m.f);
    const key = `${e.key}|A|${m.a}|${m.d}|${fe}|${ff}`;
    const path = cachedPath(key, () => buildAlignedPath(e, m.a, m.d, fe, ff));
    return { path, tx: m.e - fe, ty: m.f - ff, points: e.points };
  }
  const key = `${e.key}|L|${m.a}|${m.b}|${m.c}|${m.d}`;
  const path = cachedPath(key, () => buildLinearPath(e.contours, m));
  return { path, tx: m.e, ty: m.f, points: e.points };
}

/**
 * Screen-space (CSS px) outline of a selection under the doc → screen matrix `m` (zoom/pan,
 * optionally pre-multiplied by a live transform). Crisp (pixel-snapped) when `m` is axis-aligned.
 */
export function selectionScreenPath(sel: Selection | null | undefined, m: Affine): ScreenPath | null {
  if (!sel) return null;
  const shape = usableShape(sel);
  if (shape) return vectorScreenPath(shape, m);
  const e = maskEntry(sel.bitmapId, sel.bounds);
  if (!e || !e.contours.length) return null;
  return maskScreenPath(e, m);
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

/* ---------------- rasterized ants for very large outlines ---------------- */

interface AntsRaster {
  id: string;
  geom: string;
  region: Box;
  path: Path2D | null;
  /** Images for dash offsets 0 and 4 (black/white swapped). */
  images: (HTMLCanvasElement | null)[];
  /** Canvases of the previous raster, reused when re-rendering. */
  recycle: (HTMLCanvasElement | null)[];
}

let antsRaster: AntsRaster | null = null;

const area = (r: Box, dpr: number) => (r.x1 - r.x0) * (r.y1 - r.y0) * dpr * dpr;
const intersect = (a: Box, b: Box): Box | null => {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
};
const contains = (a: Box, b: Box) => a.x0 <= b.x0 && a.y0 <= b.y0 && a.x1 >= b.x1 && a.y1 >= b.y1;

function renderAntsImage(path: Path2D, region: Box, dpr: number, offset: number, reuse: HTMLCanvasElement | null): HTMLCanvasElement {
  const w = Math.max(1, Math.ceil((region.x1 - region.x0) * dpr));
  const h = Math.max(1, Math.ceil((region.y1 - region.y0) * dpr));
  const c = reuse ?? document.createElement('canvas');
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext('2d');
  if (!g) return c;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  g.setTransform(dpr, 0, 0, dpr, -region.x0 * dpr, -region.y0 * dpr);
  strokeAntsRaw(g, path, offset);
  return c;
}

/** Draw the ants of a very large mask outline from a cached, document-anchored raster. */
function drawLargeAnts(ctx: CanvasRenderingContext2D, e: Entry, m: Affine, animate: boolean) {
  const base = ctx.getTransform();
  const dpr = Math.hypot(base.a, base.b) || 1;
  const cssW = ctx.canvas.width / dpr;
  const cssH = ctx.canvas.height / dpr;
  const fe = frac(m.e);
  const ff = frac(m.f);
  const ie = m.e - fe;
  const iff = m.f - ff;
  // Document extent and viewport in local coordinates (screen minus the integer translation).
  const xa = fe;
  const xb = m.a * e.width + fe;
  const ya = ff;
  const yb = m.d * e.height + ff;
  const full: Box = { x0: Math.floor(Math.min(xa, xb)) - 2, y0: Math.floor(Math.min(ya, yb)) - 2, x1: Math.ceil(Math.max(xa, xb)) + 2, y1: Math.ceil(Math.max(ya, yb)) + 2 };
  const view: Box = { x0: -ie, y0: -iff, x1: Math.ceil(cssW) - ie, y1: Math.ceil(cssH) - iff };
  const vis = intersect(full, view);
  if (!vis) return;
  const geom = `${e.key}|${m.a}|${m.d}|${fe}|${ff}|${dpr}`;
  const prev = antsRaster;
  let region: Box;
  let culled = true;
  if (area(full, dpr) <= BUDGET) {
    region = full;
    culled = false;
  } else if (prev && prev.geom === geom && contains(prev.region, vis)) region = prev.region;
  else {
    const M = 320;
    const grown = intersect(full, { x0: vis.x0 - M, y0: vis.y0 - M, x1: vis.x1 + M, y1: vis.y1 + M }) ?? vis;
    region = area(grown, dpr) <= BUDGET * 1.5 ? grown : vis;
  }
  const id = `${geom}|${region.x0},${region.y0},${region.x1},${region.y1}`;
  let r = prev;
  if (!r || r.id !== id) {
    r = { id, geom, region, path: null, images: [null, null], recycle: prev ? [prev.images[0] ?? prev.recycle[0], prev.images[1] ?? prev.recycle[1]] : [null, null] };
    antsRaster = r;
  }
  const phase = animate ? Math.floor(performance.now() / 250) % 2 : 0;
  let img = r.images[phase];
  if (!img) {
    r.path ??= buildAlignedPath(e, m.a, m.d, fe, ff, culled ? region : undefined);
    img = renderAntsImage(r.path, region, dpr, phase * 4, r.recycle[phase]);
    r.recycle[phase] = null;
    r.images[phase] = img;
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(img, Math.round((region.x0 + ie) * dpr + base.e), Math.round((region.y0 + iff) * dpr + base.f));
  ctx.restore();
  if (animate) animated = true;
}

/** Marching ants for a selection under the doc → screen matrix `m` (crisp when axis-aligned). */
export function drawSelectionAnts(ctx: CanvasRenderingContext2D, sel: Selection | null | undefined, m: Affine, opts: { animate?: boolean } = {}) {
  if (!sel) return;
  const animate = opts.animate !== false;
  const shape = usableShape(sel);
  let sp: ScreenPath;
  if (shape) sp = vectorScreenPath(shape, m);
  else {
    const e = maskEntry(sel.bitmapId, sel.bounds);
    if (!e || !e.contours.length) return;
    if (e.points > LARGE && axisAligned(m)) {
      drawLargeAnts(ctx, e, m, animate);
      return;
    }
    sp = maskScreenPath(e, m);
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
