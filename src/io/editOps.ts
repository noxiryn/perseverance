/**
 * Edit menu: undo/redo and layer flip/rotate on the selected transformable layers.
 */
import { activeSession, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { normAngle } from './math';
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

type LayerTurn = 'flipH' | 'flipV' | 'rotate90cw' | 'rotate90ccw' | 'rotate180';

const LABELS: Record<LayerTurn, string> = {
  flipH: 'Flip Horizontal',
  flipV: 'Flip Vertical',
  rotate90cw: 'Rotate 90° Clockwise',
  rotate90ccw: 'Rotate 90° Counter Clockwise',
  rotate180: 'Rotate 180°',
};

/** Flip/rotate the selected layers about their own centers (transform only — non-destructive). */
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
  const ids = new Set(targets.map((t) => t.id));
  useEditor.getState().commit(LABELS[op], (d) => {
    for (const id of ids) {
      const l = d.layers[id];
      if (!l || (l.type !== 'raster' && l.type !== 'text' && l.type !== 'shape')) continue;
      const t = l.transform;
      switch (op) {
        case 'flipH':
          l.transform = { ...t, scaleX: -t.scaleX };
          break;
        case 'flipV':
          l.transform = { ...t, scaleY: -t.scaleY };
          break;
        case 'rotate90cw':
          l.transform = { ...t, rotation: normAngle(t.rotation + 90) };
          break;
        case 'rotate90ccw':
          l.transform = { ...t, rotation: normAngle(t.rotation - 90) };
          break;
        case 'rotate180':
          l.transform = { ...t, rotation: normAngle(t.rotation + 180) };
          break;
      }
    }
  });
  viewport.requestRender();
}
