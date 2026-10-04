/**
 * Snapping helpers shared by the move / transform / marquee / crop tools (and available to any
 * module): snap to canvas edges + center, guides, and other layers' bounds/centers when
 * View ▸ Snap is on. The threshold is 6 screen px. Results include "smart guide" lines (doc
 * space) that the viewport draws in magenta via setSmartGuides().
 *
 * Typical use in a drag:
 *   const targets = collectSnapTargets(doc, { exclude: new Set(movingIds) }); // once at drag start
 *   const s = snapRect(movedRect, { targets });  // every move → s.dx/s.dy, guides auto-set
 *   ...on release: clearSmartGuides();
 */
import type { Document, ID, Point, Rect } from '../core/types';
import { isEffectivelyVisible } from '../core/document';
import { getLayerBounds } from '../render/compositor';
import { viewport } from '../editor/viewport';
import { useUI } from '../state/ui';

/** Snap distance in screen pixels. */
export const SNAP_PX = 6;

export type SnapKind = 'canvas' | 'guide' | 'layer';

export interface SnapCandidate {
  /** Coordinate on the snapping axis (doc px). */
  v: number;
  /** Extent of the target along the other axis (for drawing guide lines). ±Infinity = unbounded. */
  lo: number;
  hi: number;
  kind: SnapKind;
}

export interface SnapTargets {
  /** Vertical lines (x positions). */
  x: SnapCandidate[];
  /** Horizontal lines (y positions). */
  y: SnapCandidate[];
}

export interface SnapLine {
  /** 'x' = vertical line at x = pos; 'y' = horizontal line at y = pos. */
  axis: 'x' | 'y';
  pos: number;
  from: number;
  to: number;
  kind: SnapKind;
}

export interface AxisSnap {
  delta: number;
  /** Candidates (and which moving coordinate) that line up after applying delta. */
  matches: { cand: SnapCandidate; moving: number }[];
}

/* ------------------------------------------------------------------ */
/* Pure core                                                           */
/* ------------------------------------------------------------------ */

/**
 * Find the smallest offset (|delta| ≤ threshold) that aligns any of the `moving` coordinates with a
 * candidate. Returns null when nothing is within the threshold.
 */
export function snapAxis(moving: number[], cands: SnapCandidate[], threshold: number): AxisSnap | null {
  let best = Infinity;
  let delta = 0;
  for (const m of moving) {
    for (const c of cands) {
      const d = c.v - m;
      const ad = Math.abs(d);
      if (ad <= threshold && ad < best) {
        best = ad;
        delta = d;
      }
    }
  }
  if (!isFinite(best)) return null;
  const matches: AxisSnap['matches'] = [];
  for (const m of moving) {
    const mv = m + delta;
    for (const c of cands) if (Math.abs(c.v - mv) < 1e-6 + 1e-9 * Math.abs(mv)) matches.push({ cand: c, moving: mv });
  }
  return { delta, matches };
}

function linesFor(axis: 'x' | 'y', s: AxisSnap | null, lo: number, hi: number): SnapLine[] {
  if (!s) return [];
  const out: SnapLine[] = [];
  const seen = new Set<string>();
  for (const { cand } of s.matches) {
    const key = `${cand.v.toFixed(3)}`;
    const from = Math.min(lo, cand.lo);
    const to = Math.max(hi, cand.hi);
    const prev = out.find((l) => `${l.pos.toFixed(3)}` === key);
    if (prev) {
      prev.from = Math.min(prev.from, from);
      prev.to = Math.max(prev.to, to);
      if (cand.kind === 'guide') prev.kind = 'guide';
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ axis, pos: cand.v, from, to, kind: cand.kind });
  }
  return out;
}

/** Snap a rect's edges + center against targets. Pure. */
export function computeRectSnap(
  rect: Rect,
  targets: SnapTargets,
  threshold: number,
  axes: { x?: boolean; y?: boolean } = { x: true, y: true },
): { dx: number; dy: number; lines: SnapLine[] } {
  const sx = axes.x !== false ? snapAxis([rect.x, rect.x + rect.width / 2, rect.x + rect.width], targets.x, threshold) : null;
  const sy = axes.y !== false ? snapAxis([rect.y, rect.y + rect.height / 2, rect.y + rect.height], targets.y, threshold) : null;
  const dx = sx?.delta ?? 0;
  const dy = sy?.delta ?? 0;
  const r = { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
  return {
    dx,
    dy,
    lines: [...linesFor('x', sx, r.y, r.y + r.height), ...linesFor('y', sy, r.x, r.x + r.width)],
  };
}

/** Snap a single point against targets. Pure. */
export function computePointSnap(
  p: Point,
  targets: SnapTargets,
  threshold: number,
  axes: { x?: boolean; y?: boolean } = { x: true, y: true },
): { x: number; y: number; lines: SnapLine[] } {
  const sx = axes.x !== false ? snapAxis([p.x], targets.x, threshold) : null;
  const sy = axes.y !== false ? snapAxis([p.y], targets.y, threshold) : null;
  const x = p.x + (sx?.delta ?? 0);
  const y = p.y + (sy?.delta ?? 0);
  return { x, y, lines: [...linesFor('x', sx, y, y), ...linesFor('y', sy, x, x)] };
}

/** Snap a scalar on one axis. Pure. */
export function computeValueSnap(v: number, cands: SnapCandidate[], threshold: number): number {
  const s = snapAxis([v], cands, threshold);
  return s ? v + s.delta : v;
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

export interface CollectOptions {
  /** Layer ids that are being moved (and therefore are not targets). Descendants are excluded too. */
  exclude?: Set<ID>;
  canvas?: boolean;
  guides?: boolean;
  layers?: boolean;
}

/** Gather snap targets for a document. Call once per gesture (it measures layers). */
export function collectSnapTargets(doc: Document, opts: CollectOptions = {}): SnapTargets {
  const x: SnapCandidate[] = [];
  const y: SnapCandidate[] = [];
  const W = doc.width;
  const H = doc.height;
  if (opts.canvas !== false) {
    for (const v of [0, W / 2, W]) x.push({ v, lo: 0, hi: H, kind: 'canvas' });
    for (const v of [0, H / 2, H]) y.push({ v, lo: 0, hi: W, kind: 'canvas' });
  }
  const view = useUI.getState().view;
  if (opts.guides !== false && view.guides) {
    for (const g of doc.guides) {
      if (g.orientation === 'vertical') x.push({ v: g.position, lo: -Infinity, hi: Infinity, kind: 'guide' });
      else y.push({ v: g.position, lo: -Infinity, hi: Infinity, kind: 'guide' });
    }
  }
  if (opts.layers !== false) {
    const ex = opts.exclude ?? new Set<ID>();
    const parent = new Map<ID, ID>();
    for (const l of Object.values(doc.layers)) if (l.type === 'group') for (const c of l.childIds) parent.set(c, l.id);
    const excluded = (id: ID): boolean => {
      for (let cur: ID | undefined = id; cur; cur = parent.get(cur)) if (ex.has(cur)) return true;
      return false;
    };
    for (const l of Object.values(doc.layers)) {
      if (l.type !== 'raster' && l.type !== 'text' && l.type !== 'shape') continue;
      if (excluded(l.id) || !isEffectivelyVisible(doc, l.id)) continue;
      let b: Rect | null = null;
      try {
        b = getLayerBounds(doc, l.id);
      } catch {
        b = null;
      }
      if (!b || b.width <= 0 || b.height <= 0) continue;
      // Skip layers that are basically the whole canvas (they duplicate canvas targets).
      if (Math.abs(b.x) < 0.5 && Math.abs(b.y) < 0.5 && Math.abs(b.width - W) < 0.5 && Math.abs(b.height - H) < 0.5) continue;
      for (const v of [b.x, b.x + b.width / 2, b.x + b.width]) x.push({ v, lo: b.y, hi: b.y + b.height, kind: 'layer' });
      for (const v of [b.y, b.y + b.height / 2, b.y + b.height]) y.push({ v, lo: b.x, hi: b.x + b.width, kind: 'layer' });
    }
  }
  return { x, y };
}

/* ------------------------------------------------------------------ */
/* Store-aware wrappers                                                */
/* ------------------------------------------------------------------ */

/** Whether snapping is on (View ▸ Snap). Pass `disable` (e.g. a modifier) to skip temporarily. */
export function snapEnabled(disable = false): boolean {
  return !disable && useUI.getState().view.snap;
}

/** Snap threshold in document px for the current zoom. */
export function snapThreshold(): number {
  return SNAP_PX / viewport.zoom();
}

export interface SnapOptions {
  targets: SnapTargets;
  axes?: { x?: boolean; y?: boolean };
  /** Skip snapping (still clears smart guides). */
  disabled?: boolean;
  /** Publish the resulting lines as smart guides (default true). */
  show?: boolean;
}

export function snapRect(rect: Rect, opts: SnapOptions): { dx: number; dy: number; lines: SnapLine[] } {
  if (!snapEnabled(opts.disabled)) {
    if (opts.show !== false) setSmartGuides([]);
    return { dx: 0, dy: 0, lines: [] };
  }
  const r = computeRectSnap(rect, opts.targets, snapThreshold(), opts.axes);
  if (opts.show !== false) setSmartGuides(r.lines);
  return r;
}

export function snapPoint(p: Point, opts: SnapOptions): { x: number; y: number; lines: SnapLine[] } {
  if (!snapEnabled(opts.disabled)) {
    if (opts.show !== false) setSmartGuides([]);
    return { x: p.x, y: p.y, lines: [] };
  }
  const r = computePointSnap(p, opts.targets, snapThreshold(), opts.axes);
  if (opts.show !== false) setSmartGuides(r.lines);
  return r;
}

/* ------------------------------------------------------------------ */
/* Smart guides (drawn by the viewport overlay)                        */
/* ------------------------------------------------------------------ */

let smartGuides: SnapLine[] = [];

export function setSmartGuides(lines: SnapLine[]) {
  if (!lines.length && !smartGuides.length) return;
  smartGuides = lines;
  viewport.requestOverlay();
}

export function clearSmartGuides() {
  setSmartGuides([]);
}

export function getSmartGuides(): readonly SnapLine[] {
  return smartGuides;
}

/** Draw the current smart guides (screen-space context). */
export function drawSmartGuides(ctx: CanvasRenderingContext2D) {
  if (!smartGuides.length) return;
  const size = viewport.getSize();
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#ff36d9';
  ctx.fillStyle = '#ff36d9';
  for (const l of smartGuides) {
    if (l.axis === 'x') {
      const p = viewport.docToScreen({ x: l.pos, y: 0 });
      const a = isFinite(l.from) ? viewport.docToScreen({ x: 0, y: l.from }).y : 0;
      const b = isFinite(l.to) ? viewport.docToScreen({ x: 0, y: l.to }).y : size.height;
      const x = Math.round(p.x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, Math.min(a, b));
      ctx.lineTo(x, Math.max(a, b));
      ctx.stroke();
      cross(ctx, x, a);
      cross(ctx, x, b);
    } else {
      const p = viewport.docToScreen({ x: 0, y: l.pos });
      const a = isFinite(l.from) ? viewport.docToScreen({ x: l.from, y: 0 }).x : 0;
      const b = isFinite(l.to) ? viewport.docToScreen({ x: l.to, y: 0 }).x : size.width;
      const y = Math.round(p.y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(Math.min(a, b), y);
      ctx.lineTo(Math.max(a, b), y);
      ctx.stroke();
      cross(ctx, a, y);
      cross(ctx, b, y);
    }
  }
  ctx.restore();
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number) {
  if (!isFinite(x) || !isFinite(y)) return;
  ctx.beginPath();
  ctx.moveTo(x - 2.5, y - 2.5);
  ctx.lineTo(x + 2.5, y + 2.5);
  ctx.moveTo(x + 2.5, y - 2.5);
  ctx.lineTo(x - 2.5, y + 2.5);
  ctx.stroke();
}
