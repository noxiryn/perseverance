/**
 * Edit menu: undo/redo and layer flip/rotate on the selected transformable layers.
 */
import { activeSession, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { getLayerBounds, getLayerSize } from '../render/compositor';
import { rectUnion } from '../core/geometry';
import type { Rect } from '../core/types';
import { layerTurnAbout, type LayerTurn } from './math';
import { requireSession, selectedTransformables } from './util';

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

/** Flip/rotate the selected layers about their combined center (transform only — non-destructive). */
export function turnLayers(op: LayerTurn) {
  const s = requireSession('transform layers');
  if (!s) return;
  const targets = selectedTransformables(s);
  if (!targets.length) {
    const l = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
    toast(
      l
        ? l.locks.all || l.locks.position
          ? `“${l.name}” is locked.`
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
  useEditor.getState().commit(LABELS[op], (d) => {
    for (const [id, size] of sizes) {
      const l = d.layers[id];
      if (!l || (l.type !== 'raster' && l.type !== 'text' && l.type !== 'shape')) continue;
      l.transform = layerTurnAbout(op, l.transform, size.width, size.height, pivot);
    }
  });
  viewport.requestRender();
}
