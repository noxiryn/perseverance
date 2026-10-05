/**
 * Mask painting helpers shared by looks and templates. Masks are doc-sized grayscale bitmaps
 * (white = visible). Everything here draws in document px on a context that may be scaled down
 * (previews), so shapes stay identical at any mask resolution.
 */
import type { ID, LayerMask } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas } from '../core/canvas';

/**
 * Trace and fill a polygon whose edges are torn (jagged, seeded) — e.g. a torn newspaper strip.
 * Points are in document px; `amp` is the tear depth, `step` the distance between tear points.
 */
export function tornPolygon(ctx: CanvasRenderingContext2D, pts: [number, number][], amp: number, seed = 1, step = 14) {
  let st = seed >>> 0 || 1;
  const rand = () => {
    st = (st * 1664525 + 1013904223) >>> 0;
    return st / 0xffffffff;
  };
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    const [nx, ny] = pts[(i + 1) % pts.length];
    if (i === 0) ctx.moveTo(x, y);
    const len = Math.hypot(nx - x, ny - y);
    const n = Math.max(1, Math.round(len / step));
    // perpendicular unit vector
    const px = -(ny - y) / (len || 1);
    const py = (nx - x) / (len || 1);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const j = k === n ? 0 : (rand() - 0.5) * 2 * amp;
      ctx.lineTo(x + (nx - x) * t + px * j, y + (ny - y) * t + py * j);
    }
  });
  ctx.closePath();
  ctx.fill();
}

/** Mask spec a look overlay can carry (confines the overlay to part of the canvas). */
export interface OverlayMaskSpec {
  /** Torn-edged strips along the left and/or right document edges. */
  kind: 'edge-strips';
  /** Strip width as a fraction of the document width (top of the strip; the bottom tapers a little). */
  width: number;
  sides?: 'both' | 'left' | 'right';
  /** Tear depth as a fraction of the shorter document side. */
  tear?: number;
  seed?: number;
  feather?: number;
}

/** Corner points (doc px) of the edge strips of a spec, left strip first. */
export function edgeStripPolygons(spec: OverlayMaskSpec, W: number, H: number): [number, number][][] {
  const out: [number, number][][] = [];
  const sides = spec.sides ?? 'both';
  const w = Math.max(0, Math.min(0.5, spec.width)) * W;
  const pad = Math.max(W, H) * 0.02;
  if (sides !== 'right')
    out.push([
      [-pad, -pad],
      [w, -pad],
      [w * 0.86, H + pad],
      [-pad, H + pad],
    ]);
  if (sides !== 'left')
    out.push([
      [W - w * 0.9, -pad],
      [W + pad, -pad],
      [W + pad, H + pad],
      [W - w, H + pad],
    ]);
  return out;
}

/** Paint a mask spec (white = visible) on a black-cleared context in doc px. */
export function paintOverlayMask(ctx: CanvasRenderingContext2D, spec: OverlayMaskSpec, W: number, H: number) {
  const amp = Math.max(0, spec.tear ?? 0.009) * Math.min(W, H);
  const step = Math.max(6, Math.min(W, H) * 0.013);
  ctx.fillStyle = '#ffffff';
  edgeStripPolygons(spec, W, H).forEach((poly, i) => tornPolygon(ctx, poly, amp, (spec.seed ?? 5) + i * 7, step));
}

/**
 * Render a mask spec into a new bitmap (resolution `scale` × doc size) and return the LayerMask.
 * Returns null when no canvas is available (tests) — callers then keep the layer unmasked.
 */
export function createOverlayMask(spec: OverlayMaskSpec, W: number, H: number, scale = 1): { mask: LayerMask; bitmapId: ID } | null {
  try {
    const w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.scale(w / W, h / H);
    paintOverlayMask(ctx, spec, W, H);
    const bitmapId = bitmaps.add(c);
    return { bitmapId, mask: { bitmapId, enabled: true, density: 1, feather: spec.feather ?? 0, inverted: false } };
  } catch {
    return null;
  }
}
