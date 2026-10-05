/**
 * Dirty-region math for incremental renders (live painting).
 *
 * When only the pixels of a bitmap change (a brush stroke), a cached layer render / document
 * composite is updated over the changed region instead of being rebuilt. These helpers decide
 * HOW FAR a pixel change can travel through the pipeline:
 *   - through the layer transform (resampling spreads a source pixel over a few output pixels),
 *   - through a layer mask (feather blur, edge clamping),
 *   - through layer effects (shadows, glows, strokes… see effectInfluence),
 * and how to align partial work so position-dependent pixel patterns (ordered dither, GPU blur
 * downsampling grids) line up exactly with a full render.
 */
import type { FilterInstance, ParamValues, Rect } from '../core/types';
import { filters, type EffectDef } from '../registry';
import { effectExtent, effectReach } from './effects';
import { coverRect, expandRect, maxSide, type PxRect } from './surface';

/** Far outside any canvas: used for changes that extend to infinity (clamped mask edges). */
export const FAR = 1 << 24;

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** Bounds (output px, float) of a rect mapped through a matrix. */
export function mappedBounds(m: DOMMatrix, r: Rect): { x: number; y: number; w: number; h: number } {
  const pts = [
    m.transformPoint({ x: r.x, y: r.y }),
    m.transformPoint({ x: r.x + r.width, y: r.y }),
    m.transformPoint({ x: r.x + r.width, y: r.y + r.height }),
    m.transformPoint({ x: r.x, y: r.y + r.height }),
  ];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Whether a matrix maps pixels 1:1 onto whole output pixels (the compositor then copies them). */
export function isPixelExact(m: DOMMatrix): boolean {
  return (
    Math.abs(m.a - 1) < 1e-9 &&
    Math.abs(m.d - 1) < 1e-9 &&
    Math.abs(m.b) < 1e-9 &&
    Math.abs(m.c) < 1e-9 &&
    Math.abs(m.e - Math.round(m.e)) < 1e-3 &&
    Math.abs(m.f - Math.round(m.f)) < 1e-3
  );
}

/**
 * Output pixels that can change when the source pixels in `r` (source px) change and the source
 * is drawn through `m`: the mapped bounds, grown by the resampling filter's footprint unless the
 * mapping is pixel exact. `edges` extends the result to infinity on sides where the change
 * touches the source edge and the source is edge-clamped beyond it (layer masks).
 */
export function mapDirtyRect(m: DOMMatrix, r: Rect, edges?: { w: number; h: number }): PxRect {
  const b = mappedBounds(m, r);
  const k = Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
  const margin = isPixelExact(m) ? 0 : Math.ceil(2 * Math.max(1, k)) + 2;
  const out = expandRect(coverRect(b.x, b.y, b.w, b.h), margin);
  if (edges) {
    let x0 = out.x,
      y0 = out.y,
      x1 = out.x + out.w,
      y1 = out.y + out.h;
    if (r.x <= 0) x0 = -FAR;
    if (r.y <= 0) y0 = -FAR;
    if (r.x + r.width >= edges.w) x1 = FAR;
    if (r.y + r.height >= edges.h) y1 = FAR;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return out;
}

/**
 * Depth a distance field is computed to when `maxDist` is asked (see LayerFields.distance):
 * ~25% deeper (at least 2 px), so dragging a stroke/bevel size up reuses it for a while.
 */
export function fieldBucket(maxDist: number): number {
  return Math.ceil(maxDist + Math.max(2, maxDist * 0.25));
}

/**
 * How far an edge can change a distance field asked for `maxDist` (output px). Besides exact
 * distances up to the field depth, the transform bounds partially covered pixels by their own
 * coverage whenever an edge lies within depth + 2 (see distance.ts), so an edge appearing — or a
 * crop boundary — that far away still changes a soft pixel's value.
 */
export function fieldReach(maxDist: number): number {
  return fieldBucket(maxDist) + 3;
}

/** Effects known to draw from blurs, offsets or plain fills only (no shared distance fields). */
const NO_FIELDS = new Set(['drop-shadow', 'inner-shadow', 'outer-glow', 'inner-glow', 'satin', 'long-shadow', 'color-overlay', 'gradient-overlay', 'pattern-overlay']);

/**
 * Whether an effect reads the layer's shared distance fields (strokes, bevels; unknown effects
 * may). Effects of one layer share fields, and which field depth an effect ends up with depends
 * on the order and extent of the requests — so a layer with several such effects is not
 * re-rendered region by region (a crop could make different sharing choices than a full render).
 */
export function effectUsesFields(id: string): boolean {
  return !NO_FIELDS.has(id);
}

/** Whether every enabled smart filter of a stack is pixel-local (adjustment filters). */
export function filtersLocal(list: FilterInstance[] | undefined): boolean {
  if (!list) return true;
  for (const f of list) {
    if (!f.enabled) continue;
    const def = filters.get(f.filterId);
    if (!def) continue;
    if (!def.adjustment) return false;
  }
  return true;
}

/**
 * How far (output px, any direction) a change of the content can change an effect's output —
 * and, symmetrically, how far around an output pixel the content must be known to compute it.
 * Deliberately generous (a larger region only costs a little more work; too small breaks the
 * pixels): blurs reach ~3σ ≈ 1.2× their size, spread/choke dilation up to ~1.75× size, offsets
 * move the reach by their distance, distance-field effects (strokes, bevels, inner glows) see
 * the content up to their size away.
 */
export function effectInfluence(def: EffectDef, p: ParamValues, s: number): number {
  const size = Math.max(0, num(p.size, 0));
  const dist = Math.max(0, num(p.distance, 0));
  /** Output px. */
  let r: number;
  switch (def.id) {
    case 'drop-shadow':
    case 'inner-shadow':
    case 'satin':
      r = (dist + size * 1.8 + 2) * s;
      break;
    case 'outer-glow':
    case 'inner-glow':
      r = (size * 1.8 + 2) * s;
      break;
    case 'stroke': {
      // Distance fields to `size + 2` (center: half each side), see stroke.ts / strokeCoverage.
      const sz = size * s;
      const maxDist = (p.position === 'center' ? sz / 2 : sz) + 2;
      r = Math.max(sz + 2, fieldReach(maxDist)) + 1;
      break;
    }
    case 'long-shadow':
      r = (Math.max(0, num(p.length, 60)) + 2) * s;
      break;
    case 'bevel': {
      // Distance field (inside to size + 2, emboss ± half) → 3-pass box blur of the height map
      // (edge-clamped) → 1 px gradients (see bevelMaps).
      const sz = Math.max(0.5, size * s);
      const emboss = p.style === 'emboss';
      const soften = Math.max(0, num(p.soften, 0)) * s;
      const smooth = Math.min(4, Math.max(1, Math.round(sz / 6)));
      const blur = Math.max(1, Math.round(smooth + (soften > 0.5 ? soften : 0)));
      r = fieldReach(emboss ? sz / 2 + 2 : sz + 2) + 3 * blur + 3 + (emboss ? sz / 2 : 0);
      break;
    }
    case 'color-overlay':
    case 'gradient-overlay':
    case 'pattern-overlay':
      r = 0;
      break;
    default:
      // Unknown (third-party) effect: every size-like parameter, plus its declared reach.
      r = (size * 2 + dist + Math.max(0, num(p.length, 0)) + Math.max(0, num(p.spread, 0)) + 4) * s;
      r = Math.max(r, fieldReach(size * s + 2));
  }
  const declared = Math.max(effectReach(def, p, s), maxSide(effectExtent(def, p, s)));
  return Math.ceil(Math.max(r, declared)) + 2;
}

/**
 * Alignment grid (output px) for partial work involving blurs of up to `sigma`: GPU blurs
 * downsample by 2^n for large sigmas with grids anchored to the drawn image, and ordered
 * dithers repeat every 4 px — partial work whose origin sits on the same grid as the full
 * render's reproduces it exactly.
 */
export function alignGrid(sigma: number): number {
  if (!(sigma > 4)) return 16;
  const factor = 2 ** Math.ceil(Math.log2(sigma / 4));
  return Math.min(256, Math.max(16, factor * 2));
}

/**
 * `r` grown so its top-left lies on the `grid` anchored at `origin`'s top-left, clipped to
 * `origin` (the full render's rect).
 */
export function alignRect(r: PxRect, origin: PxRect, grid: number): PxRect | null {
  const x0 = Math.max(origin.x, origin.x + Math.floor((r.x - origin.x) / grid) * grid);
  const y0 = Math.max(origin.y, origin.y + Math.floor((r.y - origin.y) / grid) * grid);
  const x1 = Math.min(origin.x + origin.w, r.x + r.w);
  const y1 = Math.min(origin.y + origin.h, r.y + r.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
