/**
 * Paints: solid colors, gradients (linear, radial, angle, reflected, diamond) and patterns
 * generated from the asset library.
 */
import type { Gradient, Paint, ParamValues, Rect } from '../core/types';
import { assets } from '../registry';
import { resolveParams } from '../filters/engine';
import { toCss } from '../core/color';
import { ctx2d } from '../core/canvas';
import { diamondQuadrants, gradientGeometry, normalizedStops, reflectedStops, type StopSpec } from './gradientMath';
import { VOLATILE_ASSETS, objId, px, renderCache } from './cache';
import { acquire, release } from './surface';

function cssColor(c: string): string {
  if (!c) return 'rgba(0,0,0,0)';
  if (c[0] === '#' && (c.length === 7 || c.length === 4)) return c;
  return toCss(c);
}

function addStops(grad: CanvasGradient, stops: StopSpec[]) {
  for (const s of stops) {
    try {
      grad.addColorStop(Math.min(1, Math.max(0, s.offset)), cssColor(s.color));
    } catch {
      /* invalid color → skip */
    }
  }
}

/**
 * Native canvas gradient for a Gradient laid over `box` (in the context's current user space).
 * Returns null for diamond gradients (they need `fillDiamond`).
 */
export function createGradient(ctx: CanvasRenderingContext2D, g: Gradient, box: Rect): CanvasGradient | null {
  const geom = gradientGeometry(g, box);
  const stops = normalizedStops(g);
  switch (geom.kind) {
    case 'linear': {
      const gr = ctx.createLinearGradient(geom.x0, geom.y0, geom.x1, geom.y1);
      addStops(gr, stops);
      return gr;
    }
    case 'reflected': {
      const gr = ctx.createLinearGradient(geom.x0, geom.y0, geom.x1, geom.y1);
      addStops(gr, reflectedStops(stops));
      return gr;
    }
    case 'radial': {
      const gr = ctx.createRadialGradient(geom.cx, geom.cy, 0, geom.cx, geom.cy, geom.r);
      addStops(gr, stops);
      return gr;
    }
    case 'angle': {
      const gr = ctx.createConicGradient(geom.startAngle, geom.cx, geom.cy);
      addStops(gr, stops);
      return gr;
    }
    default:
      return null;
  }
}

/**
 * Fill the current clip / the given path (or the whole `area`) with a diamond gradient made of
 * four exact linear-gradient quadrants.
 */
export function fillDiamond(ctx: CanvasRenderingContext2D, g: Gradient, box: Rect, area: Rect, path?: Path2D, fillRule: CanvasFillRule = 'nonzero') {
  const geom = gradientGeometry(g, box);
  if (geom.kind !== 'diamond') return;
  const stops = normalizedStops(g);
  const extent =
    Math.hypot(area.width, area.height) + Math.hypot(area.x - geom.cx, area.y - geom.cy) + Math.hypot(area.x + area.width - geom.cx, area.y + area.height - geom.cy);
  ctx.save();
  if (path) ctx.clip(path, fillRule);
  else {
    const r = new Path2D();
    r.rect(area.x, area.y, area.width, area.height);
    ctx.clip(r);
  }
  for (const q of diamondQuadrants(geom, extent)) {
    const gr = ctx.createLinearGradient(q.x0, q.y0, q.x1, q.y1);
    addStops(gr, stops);
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.moveTo(q.poly[0][0], q.poly[0][1]);
    for (let i = 1; i < q.poly.length; i++) ctx.lineTo(q.poly[i][0], q.poly[i][1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/* ---------------- patterns ---------------- */

function stableKey(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${k}:${stableKey(o[k])}`)
    .join(',')}}`;
}

const warned = new Set<string>();

/** Generate (cached) an asset at an exact size. Returns null for unknown assets. */
export function assetImage(assetId: string, params: ParamValues | undefined, width: number, height: number): HTMLCanvasElement | null {
  const def = assets.get(assetId);
  if (!def) {
    if (!warned.has(assetId)) {
      warned.add(assetId);
      console.warn(`[render] unknown pattern asset "${assetId}"`);
    }
    return null;
  }
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const p = resolveParams(def, params);
  // Keyed by definition identity: re-registering an asset (new def object) regenerates it.
  const key = `asset|${assetId}|${objId(def)}|${W}x${H}|${stableKey(p)}`;
  const hit = renderCache.get<HTMLCanvasElement>(key);
  if (hit) return hit;
  try {
    const c = def.generate(p, { width: W, height: H });
    // User images may still be decoding (blank result): those entries are dropped by every
    // full invalidation, while procedural assets (pure functions of their params) survive.
    renderCache.set(key, c, px(c), def.category === 'My Assets' ? VOLATILE_ASSETS : undefined);
    return c;
  } catch (err) {
    console.error(`[render] asset "${assetId}" failed to generate`, err);
    return null;
  }
}

/** Base tile size for document-sized assets used as repeating patterns. */
export const PATTERN_TILE = 512;

/** Tile canvas for a pattern paint (cached by asset, params and scale). */
export function patternTile(assetId: string, params: ParamValues | undefined, scale: number): HTMLCanvasElement | null {
  const def = assets.get(assetId);
  if (!def) return assetImage(assetId, params, 1, 1);
  const s = Math.max(0.05, Math.min(8, Number.isFinite(scale) && scale > 0 ? scale : 1));
  const base = def.sizing === 'document' ? { width: PATTERN_TILE, height: PATTERN_TILE } : def.sizing;
  return assetImage(assetId, params, Math.min(4096, base.width * s), Math.min(4096, base.height * s));
}

/**
 * Canvas fill/stroke style for a paint over `box` in the context's current user space.
 * Returns null when the paint cannot be expressed as a native style (diamond gradients) — use
 * `fillWithPaint` / `paintThroughMask` then.
 */
export function paintStyle(ctx: CanvasRenderingContext2D, paint: Paint, box: Rect): string | CanvasGradient | CanvasPattern | null {
  switch (paint.type) {
    case 'solid':
      return cssColor(paint.color);
    case 'gradient':
      return createGradient(ctx, paint.gradient, box);
    case 'pattern': {
      const tile = patternTile(paint.assetId, paint.params, paint.scale);
      if (!tile) return 'rgba(0,0,0,0)';
      const pat = ctx.createPattern(tile, 'repeat');
      if (pat) pat.setTransform(new DOMMatrix().translateSelf(box.x, box.y));
      return pat ?? 'rgba(0,0,0,0)';
    }
    default:
      return '#000000';
  }
}

/** Fill a rect (or a path) with a Paint in the context's current transform. */
export function fillWithPaint(ctx: CanvasRenderingContext2D, paint: Paint, box: Rect, path?: Path2D, fillRule: CanvasFillRule = 'nonzero') {
  const style = paintStyle(ctx, paint, box);
  if (style === null) {
    if (paint.type === 'gradient') fillDiamond(ctx, paint.gradient, box, box, path, fillRule);
    return;
  }
  ctx.save();
  ctx.fillStyle = style;
  if (path) ctx.fill(path, fillRule);
  else ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.restore();
}

/**
 * Draw something (text, strokes…) with a paint. `draw(ctx)` must render the shape using the
 * context's fillStyle/strokeStyle (set by this helper). Diamond gradients are applied through a
 * device-space mask.
 */
export function paintThroughMask(
  ctx: CanvasRenderingContext2D,
  paint: Paint,
  box: Rect,
  draw: (c: CanvasRenderingContext2D) => void,
  mode: 'fill' | 'stroke' = 'fill',
) {
  const style = paintStyle(ctx, paint, box);
  if (style !== null) {
    ctx.save();
    if (mode === 'fill') ctx.fillStyle = style;
    else ctx.strokeStyle = style;
    draw(ctx);
    ctx.restore();
    return;
  }
  if (paint.type !== 'gradient') return;
  const canvas = ctx.canvas as HTMLCanvasElement;
  const m = ctx.getTransform();
  const tmp = acquire(canvas.width, canvas.height);
  const t = ctx2d(tmp);
  t.setTransform(m);
  // copy relevant state
  t.lineWidth = ctx.lineWidth;
  t.lineJoin = ctx.lineJoin;
  t.lineCap = ctx.lineCap;
  t.miterLimit = ctx.miterLimit;
  t.setLineDash(ctx.getLineDash());
  t.lineDashOffset = ctx.lineDashOffset;
  t.font = ctx.font;
  t.textBaseline = ctx.textBaseline;
  t.textAlign = ctx.textAlign;
  t.letterSpacing = ctx.letterSpacing;
  t.fillStyle = '#fff';
  t.strokeStyle = '#fff';
  draw(t);
  // Diamond fill (4 quadrant fills) into its own canvas, then mask it with the drawn shape.
  const dia = acquire(canvas.width, canvas.height);
  const d = ctx2d(dia);
  d.setTransform(m);
  fillDiamond(d, paint.gradient, box, inverseArea(m, canvas.width, canvas.height));
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.globalCompositeOperation = 'source-in';
  t.drawImage(dia, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
  release(tmp, dia);
}

/** User-space rect covering the whole canvas under transform m. */
function inverseArea(m: DOMMatrix, w: number, h: number): Rect {
  const inv = m.inverse();
  const pts = [
    inv.transformPoint({ x: 0, y: 0 }),
    inv.transformPoint({ x: w, y: 0 }),
    inv.transformPoint({ x: 0, y: h }),
    inv.transformPoint({ x: w, y: h }),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
