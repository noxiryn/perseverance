/**
 * Surfaces (canvases positioned in output pixel space) and a scratch-canvas pool.
 *
 * Output pixel space = document pixels × render scale. Every intermediate the compositor makes
 * is cropped to the region that matters (a layer's padded bounds) instead of the full document,
 * which keeps effects and filters fast.
 */
import { createCanvas, ctx2d } from '../core/canvas';

/** Integer rect in output px. */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A drawable piece of a layer render (effects composite with their own operation). */
export interface Piece {
  canvas: HTMLCanvasElement;
  /** Position of the canvas' top-left in output px. */
  x: number;
  y: number;
  op: GlobalCompositeOperation;
}

export function pxRect(x: number, y: number, w: number, h: number): PxRect {
  return { x, y, w, h };
}

/** Smallest integer rect covering a float rect. */
export function coverRect(x: number, y: number, w: number, h: number): PxRect {
  const x0 = Math.floor(x + 1e-6);
  const y0 = Math.floor(y + 1e-6);
  const x1 = Math.ceil(x + w - 1e-6);
  const y1 = Math.ceil(y + h - 1e-6);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export function expandRect(r: PxRect, d: number): PxRect {
  const k = Math.ceil(Math.max(0, d));
  return { x: r.x - k, y: r.y - k, w: r.w + 2 * k, h: r.h + 2 * k };
}

export function intersectRect(a: PxRect, b: PxRect): PxRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bt <= y) return null;
  return { x, y, w: r - x, h: bt - y };
}

export function unionRect(a: PxRect | null, b: PxRect | null): PxRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function isEmptyRect(r: PxRect | null | undefined): boolean {
  return !r || r.w <= 0 || r.h <= 0;
}

/** Hard limit for any intermediate canvas side (Chromium supports up to 32767, keep memory sane). */
export const MAX_SIDE = 16384;

export function clampRectSize(r: PxRect): PxRect {
  return { x: r.x, y: r.y, w: Math.min(MAX_SIDE, Math.max(1, r.w)), h: Math.min(MAX_SIDE, Math.max(1, r.h)) };
}

/* ---------------- scratch canvas pool ---------------- */

interface PoolBucket {
  free: HTMLCanvasElement[];
}

const pools = new Map<string, PoolBucket>();
let pooledPixels = 0;
const POOL_BUDGET = 24 * 1024 * 1024;
const readable = new WeakSet<HTMLCanvasElement>();

function resetCtx(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.clearRect(0, 0, w, h);
}

/**
 * Get a cleared scratch canvas of exactly w×h (state reset). Release it with `release()` when
 * done; never store a scratch canvas in a cache.
 */
export function acquire(w: number, h: number, opts: { read?: boolean } = {}): HTMLCanvasElement {
  const W = Math.max(1, Math.min(MAX_SIDE, Math.round(w)));
  const H = Math.max(1, Math.min(MAX_SIDE, Math.round(h)));
  const key = `${W}x${H}${opts.read ? 'r' : ''}`;
  const b = pools.get(key);
  const c = b?.free.pop();
  if (c) {
    pooledPixels -= W * H;
    resetCtx(ctx2d(c, opts.read ? { willReadFrequently: true } : undefined), W, H);
    return c;
  }
  const nc = createCanvas(W, H);
  if (opts.read) {
    ctx2d(nc, { willReadFrequently: true });
    readable.add(nc);
  } else ctx2d(nc);
  return nc;
}

/** Return a scratch canvas to the pool. */
export function release(...cs: (HTMLCanvasElement | null | undefined)[]) {
  for (const c of cs) {
    if (!c) continue;
    const px = c.width * c.height;
    if (pooledPixels + px > POOL_BUDGET) continue;
    const key = `${c.width}x${c.height}${readable.has(c) ? 'r' : ''}`;
    let b = pools.get(key);
    if (!b) {
      b = { free: [] };
      pools.set(key, b);
    }
    if (b.free.includes(c)) continue;
    b.free.push(c);
    pooledPixels += px;
  }
}

export function clearPool() {
  pools.clear();
  pooledPixels = 0;
}

/** A fresh (non-pooled) canvas for results that will be cached / handed out. */
export function fresh(w: number, h: number): HTMLCanvasElement {
  return createCanvas(Math.min(MAX_SIDE, Math.max(1, w)), Math.min(MAX_SIDE, Math.max(1, h)));
}

/** Draw a piece into a context whose canvas origin sits at (ox, oy) in output px. */
export function drawPiece(ctx: CanvasRenderingContext2D, p: Piece, ox: number, oy: number, alpha = 1, op?: GlobalCompositeOperation) {
  if (alpha <= 0) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.globalCompositeOperation = op ?? p.op;
  ctx.drawImage(p.canvas, p.x - ox, p.y - oy);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** Copy of a canvas region (fresh canvas). */
export function cropCanvas(src: CanvasImageSource, sx: number, sy: number, w: number, h: number): HTMLCanvasElement {
  const c = fresh(w, h);
  ctx2d(c).drawImage(src, -sx, -sy);
  return c;
}
