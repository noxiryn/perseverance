/**
 * Edit menu: undo/redo and layer flip/rotate on the selected transformable layers.
 */
import { activeSession, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { getLayerBounds, getLayerSize } from '../render/compositor';
import { rectUnion } from '../core/geometry';
import type { ID, Layer, Rect } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../core/canvas';
import { layerTurnAbout, turnAffine, type LayerTurn } from './math';
import { isPositionLocked, maskFollowers, requireSession, selectedTransformables } from './util';

export function canUndo(): boolean {
  const s = activeSession();
  return !!s && s.history.index > 0;
}

export function canRedo(): boolean {
  const s = activeSession();
  return !!s && s.history.index < s.history.entries.length - 1;
}

export function undoLabel(): string {
  const s = activeSession();
  return s && s.history.index > 0 ? `Undo ${s.history.entries[s.history.index].label}` : 'Undo';
}

export function redoLabel(): string {
  const s = activeSession();
  return s && s.history.index < s.history.entries.length - 1 ? `Redo ${s.history.entries[s.history.index + 1].label}` : 'Redo';
}

export function undo() {
  if (!canUndo()) return;
  useEditor.getState().undo();
  viewport.requestRender();
}

export function redo() {
  if (!canRedo()) return;
  useEditor.getState().redo();
  viewport.requestRender();
}

const LABELS: Record<LayerTurn, string> = {
  flipH: 'Flip Horizontal',
  flipV: 'Flip Vertical',
  rotate90cw: 'Rotate 90° Clockwise',
  rotate90ccw: 'Rotate 90° Counter Clockwise',
  rotate180: 'Rotate 180°',
};

/** Majority value of a mask's four corners (white = reveal): fills area a turn uncovers. */
function maskBackground(c: HTMLCanvasElement): string {
  try {
    const ctx = ctxRead(c);
    const w = c.width - 1;
    const h = c.height - 1;
    let white = 0;
    for (const [x, y] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ])
      if (ctx.getImageData(x, y, 1, 1).data[0] >= 128) white++;
    return white >= 2 ? '#ffffff' : '#000000';
  } catch {
    return '#ffffff';
  }
}

/**
 * New mask bitmaps for layers whose content turns: masks are document-space bitmaps, so they are
 * redrawn through the same document-space mapping as the layers (like the move tool / free
 * transform keep linked masks aligned). The old bitmaps stay untouched for undo.
 */
function turnMasks(layers: Layer[], op: LayerTurn, pivot: { x: number; y: number }): Map<ID, ID> {
  const A = turnAffine(op, pivot);
  // Integer offsets map pixels onto pixels exactly: no resampling blur.
  const exact = Number.isInteger(A.e) && Number.isInteger(A.f);
  const byBitmap = new Map<ID, ID>();
  const out = new Map<ID, ID>();
  for (const l of layers) {
    if (!l.mask) continue;
    let next = byBitmap.get(l.mask.bitmapId);
    if (!next) {
      const src = bitmaps.tryGet(l.mask.bitmapId);
      if (!src) continue;
      const dst = createCanvas(src.width, src.height);
      const ctx = ctx2d(dst);
      ctx.fillStyle = maskBackground(src);
      ctx.fillRect(0, 0, dst.width, dst.height);
      ctx.setTransform(A.a, A.b, A.c, A.d, A.e, A.f);
      ctx.imageSmoothingEnabled = !exact;
      ctx.imageSmoothingQuality = 'high';
      // Masks are opaque grayscale: drawing over the background replaces it exactly.
      ctx.drawImage(src, 0, 0);
      next = bitmaps.add(dst);
      byBitmap.set(l.mask.bitmapId, next);
    }
    out.set(l.id, next);
  }
  return out;
}

/** Flip/rotate the selected layers (and their masks) about their combined center — non-destructive. */
export function turnLayers(op: LayerTurn) {
  const s = requireSession('transform layers');
  if (!s) return;
  const targets = selectedTransformables(s);
  if (!targets.length) {
    const l = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
    toast(
      l
        ? isPositionLocked(s.doc, l.id)
          ? `“${l.name}” is locked (or inside a locked group).`
          : `${l.type === 'fill' || l.type === 'adjustment' ? 'Fill and adjustment layers' : 'This layer'} can't be transformed. Use Image ▸ Image Rotation to turn the whole canvas.`
        : 'Select a layer to transform.',
      'info',
      3600,
    );
    return;
  }
  // Pivot: center of the combined bounds (a single layer turns about its own center).
  let box: Rect | null = null;
  for (const t of targets) box = rectUnion(box, getLayerBounds(s.doc, t.id));
  const sizes = new Map(targets.map((t) => [t.id, getLayerSize(t)]));
  const pivot = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: s.doc.width / 2, y: s.doc.height / 2 };
  const masks = turnMasks(maskFollowers(s, targets), op, pivot);
  useEditor.getState().commit(LABELS[op], (d) => {
    for (const [id, size] of sizes) {
      const l = d.layers[id];
      if (!l || (l.type !== 'raster' && l.type !== 'text' && l.type !== 'shape')) continue;
      l.transform = layerTurnAbout(op, l.transform, size.width, size.height, pivot);
    }
    for (const [id, bitmapId] of masks) {
      const l = d.layers[id];
      if (l?.mask) l.mask.bitmapId = bitmapId;
    }
  });
  viewport.requestRender();
}
