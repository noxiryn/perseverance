/**
 * Small shared helpers for the procedural asset generators: seeded randomness, param access,
 * colors and canvas creation. Everything here is deterministic for a given seed.
 */
import type { ParamValues, Point } from '../../core/types';
import { createCanvas, ctx2d } from '../../core/canvas';
import { rng } from '../../core/noise';
import { parseColor } from '../../core/color';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Pt {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ */
/* Randomness                                                          */
/* ------------------------------------------------------------------ */

export interface Rand {
  (): number;
  /** Float in [a, b). */
  range(a: number, b: number): number;
  /** Integer in [a, b] (inclusive). */
  int(a: number, b: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
  /** Approximately normal, mean 0, sd 1. */
  gauss(): number;
  /** Random sign (-1 | 1). */
  sign(): number;
  /** A derived independent generator. */
  fork(salt: number): Rand;
}

export function makeRand(seed: number): Rand {
  const next = rng(Math.floor(seed) * 2654435761 + 1013904223);
  const r = (() => next()) as Rand;
  r.range = (a, b) => a + (b - a) * next();
  r.int = (a, b) => Math.floor(a + (b - a + 1) * next());
  r.pick = (arr) => arr[Math.floor(next() * arr.length) % arr.length];
  r.chance = (p) => next() < p;
  r.gauss = () => {
    // Irwin–Hall approximation (fast, bounded).
    return (next() + next() + next() + next() + next() + next() - 3) * 1.4142;
  };
  r.sign = () => (next() < 0.5 ? -1 : 1);
  r.fork = (salt) => makeRand(Math.floor(seed) * 31 + salt * 7919 + 17);
  return r;
}

/* ------------------------------------------------------------------ */
/* Param access (values are always resolved against defaults, but stay defensive) */
/* ------------------------------------------------------------------ */

export function num(p: ParamValues, key: string, fallback = 0): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function str(p: ParamValues, key: string, fallback = ''): string {
  const v = p[key];
  return typeof v === 'string' ? v : fallback;
}

export function bool(p: ParamValues, key: string, fallback = false): boolean {
  const v = p[key];
  return typeof v === 'boolean' ? v : fallback;
}

export function pointParam(p: ParamValues, key: string, fallback: Point): Point {
  const v = p[key] as Point | undefined;
  return v && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number' ? v : fallback;
}

/* ------------------------------------------------------------------ */
/* Colors                                                              */
/* ------------------------------------------------------------------ */

export function rgbOf(color: string): RGB {
  const c = parseColor(color || '#000000');
  return { r: c.r, g: c.g, b: c.b };
}

export function rgba(color: string | RGB, a: number): string {
  const c = typeof color === 'string' ? rgbOf(color) : color;
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Math.max(0, Math.min(1, a)).toFixed(4)})`;
}

export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

export function shade(c: RGB, f: number): RGB {
  return f >= 0 ? mixRGB(c, { r: 255, g: 255, b: 255 }, f) : mixRGB(c, { r: 0, g: 0, b: 0 }, -f);
}

export function cssRGB(c: RGB): string {
  return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
}

/* ------------------------------------------------------------------ */
/* Math                                                                */
/* ------------------------------------------------------------------ */

export const TAU = Math.PI * 2;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/* ------------------------------------------------------------------ */
/* Canvas                                                              */
/* ------------------------------------------------------------------ */

export function newCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = createCanvas(w, h);
  return [c, ctx2d(c)];
}

/** Canvas + a context tuned for pixel reads. */
export function newReadCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = createCanvas(w, h);
  return [c, ctx2d(c, { willReadFrequently: true })];
}

/** Length unit: 1 unit = 1px on a 1000px short side, so assets look identical at any size. */
export function unitOf(w: number, h: number): number {
  return Math.max(0.05, Math.min(w, h) / 1000);
}

/** Draw `src` scaled to fill (w, h) of the target context with high-quality smoothing. */
export function drawUpscaled(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, x = 0, y = 0) {
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x, y, w, h);
  ctx.restore();
}

/** Fill a polygon path. */
export function tracePoly(ctx: CanvasRenderingContext2D | Path2D, pts: Pt[], close = true) {
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
}

/** Smooth closed/open curve through points (quadratic midpoints). */
export function traceSmooth(ctx: CanvasRenderingContext2D | Path2D, pts: Pt[], close = true) {
  const n = pts.length;
  if (n < 3) return tracePoly(ctx, pts, close);
  if (close) {
    const m0 = mid(pts[n - 1], pts[0]);
    ctx.moveTo(m0.x, m0.y);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const m = mid(p, pts[(i + 1) % n]);
      ctx.quadraticCurveTo(p.x, p.y, m.x, m.y);
    }
    ctx.closePath();
  } else {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n - 1; i++) {
      const m = mid(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
    }
    ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
  }
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Wait for any pending CSS font loads (used before rendering text-based assets asynchronously). */
export function fontsSettled(): Promise<void> {
  return typeof document !== 'undefined' && document.fonts ? document.fonts.ready.then(() => undefined) : Promise.resolve();
}
