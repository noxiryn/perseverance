/**
 * Geometry of a text layer for editing: local layout coords ↔ document coords, including the
 * layer transform, faux-italic shear and text warp (with a numeric inverse for hit testing).
 */
import type { Point, Rect, TextLayer, TextProps } from '../../core/types';
import { measureText, textLocalBounds, type TextLayout } from '../../render/compositor';
import { isWarpActive, warpPoint, type WarpParams } from '../../render/warpMath';
import { apply, invert, keepAnchor, layerMatrix, type Mat } from './affine';
import { inverseWarp } from './warpInverse';

export { inverseWarp };

/** Faux italic shear used by the renderer (tan ≈ 12°). */
export const ITALIC_SHEAR = 0.21;

export interface TextFrame {
  layout: TextLayout;
  /** Layout box size (= getLayerSize). */
  w: number;
  h: number;
  /** Local → document. */
  M: Mat;
  inv: Mat | null;
  warp: WarpParams | null;
  /** Layout point (already sheared if needed) → document. */
  toDoc(x: number, y: number): Point;
  /** Document point → layout point (inverse warp applied). */
  toLocal(p: Point): Point;
}

/** Build the frame from a layer (its transform + text). `text` may be a plain snapshot. */
export function textFrame(layer: Pick<TextLayer, 'transform'> & { text: TextProps }): TextFrame {
  const layout = measureText(layer.text);
  const w = layout.width;
  const h = layout.height;
  const M = layerMatrix(layer.transform, w, h);
  const inv = invert(M);
  const warp = isWarpActive(layer.text.warp) ? (layer.text.warp as WarpParams) : null;
  const a = w / 2;
  const c = h / 2;
  return {
    layout,
    w,
    h,
    M,
    inv,
    warp,
    toDoc(x, y) {
      if (warp) {
        const [X, Y] = warpPoint(warp, x - a, y - c, a, c);
        return apply(M, { x: X + a, y: Y + c });
      }
      return apply(M, { x, y });
    },
    toLocal(p) {
      if (!inv) return { x: -1e9, y: -1e9 };
      const l = apply(inv, p);
      if (!warp) return l;
      const [x, y] = inverseWarp(warp, l.x - a, l.y - c, a, c);
      return { x: x + a, y: y + c };
    },
  };
}

/** Shear a layout point like faux italic does (around the line's baseline). */
export function shear(t: Pick<TextProps, 'fauxItalic'>, x: number, y: number, baseline: number): [number, number] {
  return t.fauxItalic ? [x - ITALIC_SHEAR * (y - baseline), y] : [x, y];
}

/** Undo the faux-italic shear (for hit testing). */
export function unshear(t: Pick<TextProps, 'fauxItalic'>, x: number, y: number, baseline: number): [number, number] {
  return t.fauxItalic ? [x + ITALIC_SHEAR * (y - baseline), y] : [x, y];
}

/** Baseline of the line under a local y (for shear handling). */
export function baselineNear(layout: TextLayout, y: number): number {
  if (!layout.lines.length) return layout.ascent;
  const i = Math.max(0, Math.min(layout.lines.length - 1, Math.floor(y / Math.max(1e-6, layout.lineHeight))));
  return layout.lines[i].baseline;
}

/**
 * Hit test: does document point `p` fall on the text layer (layout box, or the warped raster
 * extents for warped text)? `pad` is in local layout units.
 */
export function frameContains(frame: TextFrame, t: TextProps, p: Point, pad: number): boolean {
  if (!frame.inv) return false;
  const l = apply(frame.inv, p);
  let r: Rect;
  if (frame.warp) r = textLocalBounds(t);
  else {
    r = { x: 0, y: 0, width: frame.w, height: frame.h };
    if (t.fauxItalic) {
      const extra = ITALIC_SHEAR * (frame.layout.fontAscent + frame.layout.fontDescent);
      r = { x: r.x - extra * 0.25, y: r.y, width: r.width + extra, height: r.height };
    }
  }
  return l.x >= r.x - pad && l.x <= r.x + r.width + pad && l.y >= r.y - pad && l.y <= r.y + r.height + pad;
}

/** Local anchor kept fixed when a point text's size changes (paragraph text: top-left). */
export function anchorLocal(t: Pick<TextProps, 'boxWidth' | 'align'>, layout: TextLayout): Point {
  if (t.boxWidth && t.boxWidth > 0) return { x: 0, y: 0 };
  const ax = t.align === 'center' ? layout.width / 2 : t.align === 'right' ? layout.width : 0;
  const line0 = layout.lines[0];
  return { x: ax, y: line0 ? line0.baseline : layout.ascent };
}

/**
 * Mutate a (draft) text layer's TextProps while keeping its anchor fixed in document space:
 * point text keeps the alignment point of its first baseline (left/center/right), paragraph text
 * keeps its top-left corner. Rotation/scale/skew are respected.
 */
export function mutateKeepingAnchor(l: TextLayer, mutate: (t: TextProps) => void) {
  // Plain snapshots: the layout cache is keyed by object identity (drafts mutate in place).
  const before = { ...l.text };
  const L0 = measureText(before);
  const a0 = anchorLocal(before, L0);
  mutate(l.text);
  const after = { ...l.text };
  const L1 = measureText(after);
  const a1 = anchorLocal(after, L1);
  if (L0.width === L1.width && L0.height === L1.height && a0.x === a1.x && a0.y === a1.y) return;
  const pos = keepAnchor(l.transform, L0.width, L0.height, a0, L1.width, L1.height, a1);
  if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    l.transform.x = pos.x;
    l.transform.y = pos.y;
  }
}
