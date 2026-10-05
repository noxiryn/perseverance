/**
 * Pure layout math for swapping a layer's pixels (Replace Character / Replace Contents) and for
 * trimming a layer to its visible pixels — no canvas or store access, unit tested.
 */
import type { Rect, Transform } from '../../core/types';
import { linearApply, reboxTransform } from '../../panels/geometryMath';

export interface FitResult {
  /** Size of the new bitmap (document px at 1:1). */
  width: number;
  height: number;
  transform: Transform;
}

export type FitAlign = 'center' | 'bottom';

/**
 * Fit a srcW×srcH image into the box a layer currently covers on the canvas ("contain": aspect
 * kept, as large as fits), keeping the layer's rotation, skew and flips. The new bitmap is meant
 * to be resampled to the returned size so it renders 1:1 — size-based smart filter params
 * (halftone dot size, outline width…) then look exactly as the template authored them.
 * `bottom` keeps the bottom edge of the box in place (a character's feet stay planted),
 * `center` keeps its center.
 */
export function fitIntoBox(t: Transform, w: number, h: number, srcW: number, srcH: number, align: FitAlign = 'center'): FitResult {
  const dispW = Math.max(1e-6, w * Math.abs(t.scaleX || 1));
  const dispH = Math.max(1e-6, h * Math.abs(t.scaleY || 1));
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const k = Math.min(dispW / sw, dispH / sh);
  const nw = Math.max(1, Math.round(sw * k));
  const nh = Math.max(1, Math.round(sh * k));
  const next: Transform = { ...t, scaleX: t.scaleX < 0 ? -1 : 1, scaleY: t.scaleY < 0 ? -1 : 1 };
  let cx = t.x + w / 2;
  let cy = t.y + h / 2;
  if (align === 'bottom') {
    // Old bottom-center = center + L_old(0, h/2); the new box's bottom-center must land there.
    const ob = linearApply(t, 0, h / 2);
    const nb = linearApply(next, 0, nh / 2);
    cx += ob.x - nb.x;
    cy += ob.y - nb.y;
  }
  next.x = cx - nw / 2;
  next.y = cy - nh / 2;
  return { width: nw, height: nh, transform: next };
}

/**
 * Same fit, but for a bitmap kept at its own resolution (srcW×srcH): returns the transform that
 * scales it into the fitted box. Used for re-editable renders (Pose Studio) whose generator
 * placement relies on the bitmap being the original render crop.
 */
export function fitIntoBoxAtScale(t: Transform, w: number, h: number, srcW: number, srcH: number, align: FitAlign = 'center'): Transform {
  const fit = fitIntoBox(t, w, h, srcW, srcH, align);
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const cx = fit.transform.x + fit.width / 2;
  const cy = fit.transform.y + fit.height / 2;
  return {
    ...fit.transform,
    scaleX: fit.transform.scaleX * (fit.width / sw),
    scaleY: fit.transform.scaleY * (fit.height / sh),
    x: cx - sw / 2,
    y: cy - sh / 2,
  };
}

/**
 * Transform for a layer trimmed to `rect` (in its old local pixel box) so every remaining pixel
 * stays exactly where it was on the canvas.
 */
export function trimTransform(t: Transform, w: number, h: number, rect: Rect): Transform {
  return reboxTransform(t, w, h, rect);
}

/** Inclusive alpha bounds → rect, or null when the whole box is still needed / nothing is visible. */
export function trimRect(bounds: { x0: number; y0: number; x1: number; y1: number } | null, w: number, h: number): Rect | null {
  if (!bounds) return null;
  const rect = { x: bounds.x0, y: bounds.y0, width: bounds.x1 - bounds.x0 + 1, height: bounds.y1 - bounds.y0 + 1 };
  if (rect.x === 0 && rect.y === 0 && rect.width === w && rect.height === h) return null;
  return rect;
}
