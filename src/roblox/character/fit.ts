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

/**
 * - `center`: keep the box's center.
 * - `bottom`: keep the bottom edge of the box in place (a full figure's feet stay planted).
 * - `cut`: an image cut off at the bottom (bust, head-and-shoulders, waist-up render) replacing a
 *   full figure. Template placeholders often reach past the canvas edge (the figure's legs are
 *   cropped by it); fitting a bust to the whole box and planting it on the box bottom dropped the
 *   face to — or off — the canvas edge. Instead the image fills the part of the box that is on the
 *   canvas (measured along the box's vertical center line, so rotation is fine) — up to
 *   CUT_MAX_WIDEN × the box width, shoulders may overhang a little — with its cut edge on the
 *   bottom of that part: the canvas edge when the box extends past it, so the cut never shows
 *   mid-canvas, and the head lands where the figure's head was (lower when the image is wide).
 *   Needs the canvas size; falls back to `bottom` when the box is (almost) off the canvas.
 *   characterFitAlign picks between `bottom` and `cut` for a character image.
 */
export type FitAlign = 'center' | 'bottom' | 'cut';

/** How much wider than the placeholder's box a cut-off image may get (`cut` fit). */
export const CUT_MAX_WIDEN = 1.25;

/**
 * How much lower (fraction of the box's on-canvas height) the top of an image planted on the box
 * bottom may land than the box top before a character image is fitted with `cut` instead — see
 * characterFitAlign.
 */
export const CUT_TOP_DROP = 0.1;

export interface CanvasSize {
  width: number;
  height: number;
}

/**
 * The part of a layer box's vertical center line (local top → bottom) that lies on the canvas,
 * as fractions [s0, s1] of the box height (0 = top edge, 1 = bottom edge), or null when the line
 * misses the canvas. Liang–Barsky clip of the segment against the canvas rectangle.
 */
export function centerLineOnCanvas(t: Transform, w: number, h: number, canvas: CanvasSize): { s0: number; s1: number } | null {
  const cx = t.x + w / 2;
  const cy = t.y + h / 2;
  const half = linearApply(t, 0, h / 2);
  const p0 = { x: cx - half.x, y: cy - half.y };
  const d = { x: 2 * half.x, y: 2 * half.y };
  let s0 = 0;
  let s1 = 1;
  const clip = (p: number, q: number) => {
    // p·s ≤ q
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) s0 = Math.max(s0, r);
    else s1 = Math.min(s1, r);
    return s0 <= s1;
  };
  if (!clip(-d.x, p0.x) || !clip(d.x, canvas.width - p0.x) || !clip(-d.y, p0.y) || !clip(d.y, canvas.height - p0.y)) return null;
  return s1 > s0 ? { s0, s1 } : null;
}

/**
 * Fit a srcW×srcH image into the box a layer currently covers on the canvas ("contain": aspect
 * kept, as large as fits), keeping the layer's rotation, skew and flips. The new bitmap is meant
 * to be resampled to the returned size so it renders 1:1 — size-based smart filter params
 * (halftone dot size, outline width…) then look exactly as the template authored them.
 * See FitAlign for the alignments (`cut` needs `canvas`).
 */
export function fitIntoBox(t: Transform, w: number, h: number, srcW: number, srcH: number, align: FitAlign = 'center', canvas?: CanvasSize): FitResult {
  const dispW = Math.max(1e-6, w * Math.abs(t.scaleX || 1));
  const dispH = Math.max(1e-6, h * Math.abs(t.scaleY || 1));
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  if (align === 'cut') {
    const span = canvas ? centerLineOnCanvas(t, w, h, canvas) : null;
    // Less than 5 % of the box on the canvas: nothing sensible to fit into.
    if (span && span.s1 - span.s0 >= 0.05) return fitCut(t, w, h, sw, sh, dispW, dispH, span, canvas!);
    align = 'bottom';
  }
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
 * The alignment for an image replacing a character / placeholder (srcW×srcH = its visible pixels).
 * - Cut off at the bottom (`cutOff`: a detected or known bust, headshot, waist-up render) → `cut`.
 * - Otherwise a whole figure keeps its feet planted (`bottom`) — unless the box runs past the
 *   canvas and the image is so much wider than the box (relative to its height) that planting it
 *   on the box bottom would drop its top more than CUT_TOP_DROP of the on-canvas height below the
 *   box top. That is a bust whose cut wasn't detected (it fades out, or the export has a few
 *   transparent rows under it) or a wide pose: on the box bottom its face would sink to (or past)
 *   the canvas edge, so it gets the `cut` fit too — head where the placeholder's head was, bottom
 *   on the canvas edge. Tall figures (height-limited in the box) are never affected.
 */
export function characterFitAlign(t: Transform, w: number, h: number, srcW: number, srcH: number, canvas: CanvasSize | undefined, cutOff: boolean): FitAlign {
  if (cutOff) return 'cut';
  if (!canvas) return 'bottom';
  const span = centerLineOnCanvas(t, w, h, canvas);
  // Box entirely on the canvas (nothing to lose by planting) or (almost) off it.
  if (!span || span.s1 >= 1 - 1e-6 || span.s1 - span.s0 < 0.05) return 'bottom';
  const dispW = Math.max(1e-6, w * Math.abs(t.scaleX || 1));
  const dispH = Math.max(1e-6, h * Math.abs(t.scaleY || 1));
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const drop = dispH - sh * Math.min(dispW / sw, dispH / sh);
  return drop > CUT_TOP_DROP * (span.s1 - span.s0) * dispH ? 'cut' : 'bottom';
}

/** `cut` fit (see FitAlign): contain into the on-canvas part of the box, cut edge on its bottom. */
function fitCut(t: Transform, w: number, h: number, sw: number, sh: number, dispW: number, dispH: number, span: { s0: number; s1: number }, canvas: CanvasSize): FitResult {
  const availH = (span.s1 - span.s0) * dispH;
  const maxW = Math.max(dispW, Math.min(dispW * CUT_MAX_WIDEN, canvas.width));
  const k = Math.min(availH / sh, maxW / sw);
  const nw = Math.max(1, Math.round(sw * k));
  const nh = Math.max(1, Math.round(sh * k));
  const next: Transform = { ...t, scaleX: t.scaleX < 0 ? -1 : 1, scaleY: t.scaleY < 0 ? -1 : 1 };
  // Where the center line leaves the canvas (or the box ends): the new box's bottom-center goes there.
  const half = linearApply(t, 0, h / 2);
  let ex = t.x + w / 2 - half.x + 2 * half.x * span.s1;
  let ey = t.y + h / 2 - half.y + 2 * half.y * span.s1;
  const len = Math.hypot(half.x, half.y);
  if (span.s1 < 1 && Math.abs(ey - canvas.height) < 0.5 && len > 0) {
    // A rotated box leaving through the bottom edge: lower the image along its axis until both
    // ends of the tilted cut edge are off the canvas too.
    const dir = { x: half.x / len, y: half.y / len };
    const across = linearApply(next, nw / 2, 0);
    if (dir.y > 1e-6) {
      const shift = Math.abs(across.y) / dir.y;
      ex += dir.x * shift;
      ey += dir.y * shift;
    }
  }
  const nb = linearApply(next, 0, nh / 2);
  next.x = ex - nb.x - nw / 2;
  next.y = ey - nb.y - nh / 2;
  return { width: nw, height: nh, transform: next };
}

/**
 * Whether an image (RGBA, before trimming) is cut off at the bottom — a bust, a head-and-shoulders
 * or waist-up render — rather than a whole figure: its lowest rows are fully opaque across one
 * wide unbroken run (≥ 20 % of the content width), i.e. a straight cut at the image edge. Feet
 * touching a tightly cropped edge reach it as separate narrow soles, usually with anti-aliased
 * (partly transparent) pixels; a figure with margin below it never touches it. An image whose
 * opaque background was kept counts as cut off (a photo reaching the bottom edge).
 */
export function isCutOffAtBottom(img: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }): boolean {
  const { data, width: W, height: H } = img;
  if (W < 1 || H < 1) return false;
  // Content width (any visible pixel), to judge how wide the cut is.
  let x0 = W;
  let x1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  if (x1 < x0) return false;
  const minRun = Math.max(2, (x1 - x0 + 1) * 0.2);
  /** Longest run of fully opaque pixels in row y. */
  const longestRun = (y: number) => {
    let best = 0;
    let n = 0;
    const row = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      n = data[row + x * 4 + 3] >= 250 ? n + 1 : 0;
      if (n > best) best = n;
    }
    return best;
  };
  return longestRun(H - 1) >= minRun && longestRun(Math.max(0, H - 3)) >= minRun;
}

/**
 * Same fit, but for a bitmap kept at its own resolution (srcW×srcH): returns the transform that
 * scales it into the fitted box. Used for re-editable renders (Pose Studio) whose generator
 * placement relies on the bitmap being the original render crop.
 */
export function fitIntoBoxAtScale(t: Transform, w: number, h: number, srcW: number, srcH: number, align: FitAlign = 'center', canvas?: CanvasSize): Transform {
  const fit = fitIntoBox(t, w, h, srcW, srcH, align, canvas);
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
