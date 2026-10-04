/**
 * Shapes library: adds a vector shape layer from a registered shape preset.
 */
import type { ID, Point } from '../../core/types';
import { makeShapeLayer } from '../../core/document';
import { viewport } from '../../editor/viewport';
import { shapePresets } from '../../registry';
import { activeDoc, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';

/** Box for a preset: ~30% of the document height, keeping the viewBox aspect. Pure. */
export function presetBox(viewBox: [number, number, number, number], docW: number, docH: number, frac = 0.3): { width: number; height: number } {
  const vw = Math.max(1e-6, viewBox[2]);
  const vh = Math.max(1e-6, viewBox[3]);
  let height = docH * frac;
  let width = (height * vw) / vh;
  // very wide presets (banners) must still fit the canvas
  const maxW = docW * 0.9;
  if (width > maxW) {
    height *= maxW / width;
    width = maxW;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

export function addShapePreset(presetId: string, at?: Point | null): ID | null {
  const doc = activeDoc();
  if (!doc) {
    toast('Open or create a document to add shapes', 'info');
    return null;
  }
  const pr = shapePresets.get(presetId);
  if (!pr) {
    toast('That shape is no longer available', 'warning');
    return null;
  }
  const { width, height } = presetBox(pr.viewBox, doc.width, doc.height);
  const cx = at ? at.x : doc.width / 2;
  const cy = at ? at.y : doc.height / 2;
  const layer = makeShapeLayer({
    name: pr.name,
    x: Math.round(cx - width / 2),
    y: Math.round(cy - height / 2),
    shape: {
      kind: 'path',
      path: pr.path,
      viewBox: [...pr.viewBox] as [number, number, number, number],
      presetId: pr.id,
      width,
      height,
      fill: { type: 'solid', color: useEditor.getState().primaryColor },
      stroke: null,
    },
  });
  const id = useEditor.getState().addLayer(layer, { label: `Add ${pr.name}` });
  viewport.requestRender();
  return id;
}
