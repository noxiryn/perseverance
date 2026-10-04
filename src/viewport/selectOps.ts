/**
 * Select-menu operations built on src/editor/selection.ts: modify (feather / expand / contract /
 * border / smooth) with exact round distance transforms, load selection from a layer, reselect.
 * Every change is one undoable history step via setSelection().
 */
import type { Document, Rect } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../core/canvas';
import { flattenIds } from '../core/document';
import {
  alphaMask,
  combine,
  featherSelection,
  selectionFromCanvas,
  setSelection,
  type SelectionMode,
} from '../editor/selection';
import { rasterizeLayer } from '../render/compositor';
import { activeDoc, activeSession, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { borderAlpha, morphAlpha, smoothAlpha } from './math/mask';
import { lastSelectionFor } from './lifecycle';
import { requireDoc } from './state';

export type ModifyKind = 'feather' | 'expand' | 'contract' | 'border' | 'smooth';

function requireSelection(what: string): Document | null {
  const doc = requireDoc(what);
  if (!doc) return null;
  if (!doc.selection) {
    toast(`${what} needs an active selection. Make one with the marquee, lasso or magic wand.`, 'info');
    return null;
  }
  return doc;
}

/** Read the selection alpha in `region` as a single-channel array. */
function readAlpha(doc: Document, region: Rect): Uint8ClampedArray | null {
  const bmp = doc.selection ? bitmaps.tryGet(doc.selection.bitmapId) : null;
  if (!bmp) return null;
  const img = ctxRead(bmp).getImageData(region.x, region.y, region.width, region.height).data;
  const n = region.width * region.height;
  const out = new Uint8ClampedArray(n);
  for (let i = 0, j = 3; i < n; i++, j += 4) out[i] = img[j];
  return out;
}

/** Doc-sized mask canvas with `alpha` placed at `region`. */
function alphaToCanvas(doc: Document, alpha: Uint8ClampedArray, region: Rect): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctxRead(c);
  const img = ctx.createImageData(region.width, region.height);
  const d = img.data;
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) d[j] = alpha[i];
  ctx.putImageData(img, region.x, region.y);
  return c;
}

function paddedRegion(doc: Document, pad: number): Rect {
  const b = doc.selection!.bounds;
  const x0 = Math.max(0, Math.floor(b.x - pad));
  const y0 = Math.max(0, Math.floor(b.y - pad));
  const x1 = Math.min(doc.width, Math.ceil(b.x + b.width + pad));
  const y1 = Math.min(doc.height, Math.ceil(b.y + b.height + pad));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

const LABELS: Record<ModifyKind, string> = {
  feather: 'Feather',
  expand: 'Expand Selection',
  contract: 'Contract Selection',
  border: 'Border Selection',
  smooth: 'Smooth Selection',
};

/** Select ▸ Modify ▸ … with `amount` px. */
export function modifySelection(kind: ModifyKind, amount: number) {
  const doc = requireSelection(LABELS[kind]);
  if (!doc || !(amount > 0)) return;
  if (kind === 'feather') {
    featherSelection(amount);
    return;
  }
  const pad = Math.ceil(amount) + 3;
  const region = paddedRegion(doc, kind === 'contract' ? 2 : pad);
  const alpha = readAlpha(doc, region);
  if (!alpha) return;
  let out: Uint8ClampedArray;
  if (kind === 'expand') out = morphAlpha(alpha, region.width, region.height, amount);
  else if (kind === 'contract') out = morphAlpha(alpha, region.width, region.height, -amount);
  else if (kind === 'border') out = borderAlpha(alpha, region.width, region.height, amount);
  else out = smoothAlpha(alpha, region.width, region.height, amount);
  const sel = selectionFromCanvas(alphaToCanvas(doc, out, region));
  if (!sel) toast('No pixels are selected after this change — the selection was removed.', 'warning');
  setSelection(sel, sel ? LABELS[kind] : 'Deselect');
}

/** Select ▸ Load Selection: selection from the active layer's opaque pixels. */
export function loadLayerSelection(mode: SelectionMode = 'new') {
  const s = activeSession();
  if (!s) {
    requireDoc('Load Selection');
    return;
  }
  const id = s.activeLayerId;
  const l = id ? s.doc.layers[id] : null;
  if (!id || !l) {
    toast('Select a layer to load its pixels as a selection.', 'info');
    return;
  }
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = rasterizeLayer(s.doc, id);
  } catch (err) {
    console.error('[select] rasterize failed', err);
  }
  if (!canvas) {
    toast(`“${l.name}” has no pixels to load as a selection.`, 'info');
    return;
  }
  const mask = alphaMask(s.doc, canvas);
  const sel = combine(s.doc, mask, mode);
  if (!sel && mode === 'new') {
    toast(`“${l.name}” is empty — nothing to select.`, 'info');
    return;
  }
  setSelection(sel, sel ? 'Load Selection' : 'Deselect');
}

/** Select ▸ Reselect. */
export function reselect() {
  const s = activeSession();
  if (!s) return;
  const sel = lastSelectionFor(s.doc.id);
  if (!sel) {
    toast('There is no previous selection to restore.', 'info');
    return;
  }
  setSelection(sel, 'Reselect');
}

/** Select ▸ All Layers. */
export function selectAllLayers() {
  const s = activeSession();
  if (!s) return;
  const ids = flattenIds(s.doc).filter((id) => s.doc.layers[id]?.visible !== undefined);
  if (!ids.length) {
    toast('This document has no layers.', 'info');
    return;
  }
  useEditor.getState().setSelectedLayers(ids, s.activeLayerId && ids.includes(s.activeLayerId) ? s.activeLayerId : ids[ids.length - 1]);
}

/** Apply a full-resolution alpha (0..255, doc-sized) as a selection with a mode. */
export function commitAlphaSelection(alpha: Uint8ClampedArray, mode: SelectionMode, label: string) {
  const doc = activeDoc();
  if (!doc) return;
  const c = alphaToCanvas(doc, alpha, { x: 0, y: 0, width: doc.width, height: doc.height });
  const sel = combine(doc, c, mode);
  if (!sel && !doc.selection) {
    toast('No pixels matched — nothing was selected.', 'info');
    return;
  }
  setSelection(sel, sel ? label : 'Deselect');
}

/** Composite pixels of a document at full resolution (CPU readable). */
export function readComposite(source: HTMLCanvasElement, w: number, h: number): Uint8ClampedArray {
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** Draw a grayscale preview of an alpha array into a canvas of the same size. */
export function paintAlphaPreview(target: HTMLCanvasElement, alpha: Uint8ClampedArray) {
  const ctx = ctx2d(target);
  const img = ctx.createImageData(target.width, target.height);
  const d = img.data;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    const v = alpha[i];
    d[j] = v;
    d[j + 1] = v;
    d[j + 2] = v;
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
