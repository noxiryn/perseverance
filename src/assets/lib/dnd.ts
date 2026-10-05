/**
 * Drag & drop of library items onto the canvas. Cards put a JSON payload under the
 * 'application/x-perseverance-asset' type (the shell's file-drop overlay ignores it); a single
 * window listener maps the drop point into document space and places the item there.
 */
import type { DragEvent as ReactDragEvent } from 'react';
import type { ParamValues, Point } from '../../core/types';
import { viewport } from '../../editor/viewport';
import { activeDoc } from '../../state/editor';
import { toast } from '../../state/ui';
import { placeAssetWhenReady, prepareAsset } from '../place';
import type { AssetLayerOptions } from '../place';
import { addShapePreset } from './shapes';

export const ASSET_MIME = 'application/x-perseverance-asset';

export type DragPayload =
  | { kind: 'asset'; id: string; params?: ParamValues; blendMode?: AssetLayerOptions['blendMode']; opacity?: number }
  | { kind: 'shape'; id: string };

/** Parse a payload string; null when malformed. Pure. */
export function parsePayload(raw: string | null | undefined): DragPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DragPayload>;
    if (!v || typeof v.id !== 'string') return null;
    if (v.kind === 'asset' || v.kind === 'shape') return v as DragPayload;
    return null;
  } catch {
    return null;
  }
}

export function startDrag(e: ReactDragEvent, payload: DragPayload, image?: HTMLCanvasElement | null) {
  // start decoding/loading what the asset needs while it is being dragged
  if (payload.kind === 'asset') void prepareAsset(payload.id);
  e.dataTransfer.setData(ASSET_MIME, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', payload.id);
  e.dataTransfer.effectAllowed = 'copy';
  if (image) {
    try {
      e.dataTransfer.setDragImage(image, image.width / 2, image.height / 2);
    } catch {
      /* drag image is cosmetic */
    }
  }
}

function hasPayload(e: DragEvent) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(ASSET_MIME);
}

/**
 * Viewport-relative point when the event targets the canvas viewport itself. Checking the
 * target (not just the geometry) keeps panels/flyouts that float over the canvas area from
 * accepting asset drops meant for themselves.
 */
function viewportPoint(e: DragEvent): Point | null {
  const el = viewport.element();
  if (!el || !(e.target instanceof Node) || !el.contains(e.target)) return null;
  const r = el.getBoundingClientRect();
  if (e.clientX < r.left || e.clientY < r.top || e.clientX > r.right || e.clientY > r.bottom) return null;
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

let installed = false;

export function installCanvasDrop() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('dragover', (e) => {
    if (!hasPayload(e)) return;
    if (viewportPoint(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
  });
  window.addEventListener('drop', (e) => {
    if (!hasPayload(e) || e.defaultPrevented) return;
    const vp = viewportPoint(e);
    if (!vp) return;
    e.preventDefault();
    const payload = parsePayload(e.dataTransfer?.getData(ASSET_MIME));
    if (!payload) return;
    if (!activeDoc()) {
      toast('Open or create a document first, then drop assets onto it', 'info');
      return;
    }
    const at = viewport.screenToDoc(vp);
    if (payload.kind === 'shape') addShapePreset(payload.id, at);
    else void placeAssetWhenReady(payload.id, payload.params, { blendMode: payload.blendMode, opacity: payload.opacity }, at);
  });
}
