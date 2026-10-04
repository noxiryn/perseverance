/**
 * Clipboard: cut / copy / copy merged / paste / paste in place / clear, with an internal
 * clipboard (keeps the original position) and best-effort system clipboard PNG exchange.
 */
import type { DocSession } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { blobToCanvas, canvasToBlob, createCanvas, ctx2d, opaqueBounds } from '../core/canvas';
import { nextLayerName } from '../core/document';
import { renderDocument, renderLayerToDoc } from '../render/compositor';
import { activeSession, useEditor } from '../state/editor';
import { toast, useUI } from '../state/ui';
import { viewport } from '../editor/viewport';
import { isTypingTarget } from '../ui/shortcuts';
import { placeCanvas, placeImageBlob } from './open';
import { drawDocCanvasOnMask, drawDocCanvasOnRaster, pixelTarget, selectionClippedFill, selectionRect } from './pixels';
import { rasterToDocCanvas, requireSession } from './util';

interface ClipData {
  canvas: HTMLCanvasElement;
  /** Original doc-space position of the copied pixels. */
  x: number;
  y: number;
  /** Size we last put on the system clipboard (to recognize our own data when pasting). */
  systemSize: { width: number; height: number } | null;
}

let clip: ClipData | null = null;
let lastPasteCommand = 0;

export function hasInternalClipboard() {
  return !!clip;
}

/* ---------------- copy ---------------- */

function copySource(s: DocSession, merged: boolean): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  const doc = s.doc;
  let full: HTMLCanvasElement | null;
  if (merged) full = renderDocument(doc, { background: true });
  else {
    const l = s.activeLayerId ? doc.layers[s.activeLayerId] : null;
    if (!l) {
      toast('Select a layer to copy (or use Copy Merged).', 'info');
      return null;
    }
    if (s.editTarget === 'mask' && l.mask) full = bitmaps.tryGet(l.mask.bitmapId);
    else if (l.type === 'raster') full = rasterToDocCanvas(doc, l);
    else full = renderLayerToDoc(doc, l, { effects: false });
    if (!full) {
      toast(`“${l.name}” has no pixels to copy.`, 'info');
      return null;
    }
  }
  const sel = selectionRect(doc);
  const region = sel ?? (merged ? { x: 0, y: 0, width: doc.width, height: doc.height } : opaqueBounds(full));
  if (!region || region.width < 1 || region.height < 1) {
    toast(sel ? 'The selected area is empty.' : 'The layer is empty — nothing to copy.', 'info');
    return null;
  }
  const out = createCanvas(region.width, region.height);
  const ctx = ctx2d(out);
  ctx.drawImage(full, -region.x, -region.y);
  const mask = doc.selection ? bitmaps.tryGet(doc.selection.bitmapId) : null;
  if (mask) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, -region.x, -region.y);
  }
  return { canvas: out, x: region.x, y: region.y };
}

async function writeSystemClipboard(canvas: HTMLCanvasElement) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(canvas, 'image/png') })]);
    if (clip && clip.canvas === canvas) clip.systemSize = { width: canvas.width, height: canvas.height };
  } catch {
    /* no focus / permission — the internal clipboard still works */
  }
}

export function copy(merged = false): boolean {
  const s = requireSession(merged ? 'copy merged' : 'copy');
  if (!s) return false;
  const src = copySource(s, merged);
  if (!src) return false;
  clip = { ...src, systemSize: null };
  void writeSystemClipboard(src.canvas);
  toast(`Copied ${src.canvas.width}×${src.canvas.height} px${merged ? ' (merged)' : ''}`, 'success', 1800);
  return true;
}

/* ---------------- clear / cut ---------------- */

/** Erase the selected pixels of the active raster layer (or hide them on the edited mask). */
function clearSelectedPixels(s: DocSession, label: string): boolean {
  const doc = s.doc;
  const sel = doc.selection ? bitmaps.tryGet(doc.selection.bitmapId) : null;
  const rect = selectionRect(doc);
  if (!sel || !rect) return false;
  const target = pixelTarget(s);
  const layer = s.activeLayerId ? doc.layers[s.activeLayerId] : null;
  if (!target || !layer) {
    toast(layer ? `“${layer.name}” is a ${layer.type} layer — clearing pixels needs a pixel layer. Rasterize it first.` : 'Select a layer first.', 'warning', 4000);
    return false;
  }
  if (layer.locks.all || layer.locks.pixels) {
    toast(`“${layer.name}” is locked.`, 'warning');
    return false;
  }
  let patch;
  if (target.kind === 'mask') {
    const black = selectionClippedFill(doc, (ctx, w, h) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
    });
    patch = drawDocCanvasOnMask(target.bitmapId, black, rect);
  } else {
    patch = drawDocCanvasOnRaster(target.layer, sel, rect, { erase: true });
  }
  if (!patch) {
    toast('The selection does not overlap this layer.', 'info');
    return false;
  }
  useEditor.getState().commit(label, undefined, { patches: [patch] });
  viewport.requestRender();
  return true;
}

export function cut() {
  const s = requireSession('cut');
  if (!s) return;
  const l = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (l && l.type !== 'raster' && !(s.editTarget === 'mask' && l.mask)) {
    if (copy(false)) toast(`Copied — cut only removes pixels from pixel layers (“${l.name}” is a ${l.type} layer).`, 'info', 3600);
    return;
  }
  if (!copy(false)) return;
  if (s.doc.selection) clearSelectedPixels(activeSession()!, 'Cut');
  else if (l && l.type === 'raster') {
    if (l.locks.all || l.locks.pixels) return void toast(`“${l.name}” is locked — copied only.`, 'warning');
    const patch = bitmaps.edit(l.bitmapId, (ctx, c) => ctx.clearRect(0, 0, c.width, c.height));
    useEditor.getState().commit('Cut', undefined, { patches: [patch] });
    viewport.requestRender();
  }
}

/** Delete: clear selected pixels, or delete the selected layer(s) when nothing is selected. */
export function clear() {
  const s = requireSession('clear');
  if (!s) return;
  if (s.doc.selection) {
    clearSelectedPixels(s, 'Clear');
    return;
  }
  const ids = (s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : []).filter((id) => {
    const l = s.doc.layers[id];
    return l && !l.locks.all;
  });
  if (!ids.length) {
    toast(s.activeLayerId ? 'The layer is locked.' : 'Nothing to delete.', 'info');
    return;
  }
  useEditor.getState().removeLayers(ids);
  viewport.requestRender();
}

/* ---------------- paste ---------------- */

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

async function readSystemImage(): Promise<Blob | null> {
  try {
    if (!navigator.clipboard?.read) return null;
    const items = await withTimeout(navigator.clipboard.read(), 1500);
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) return await it.getType(type);
    }
  } catch {
    /* permission denied / no focus / unsupported */
  }
  return null;
}

export async function paste(inPlace = false) {
  lastPasteCommand = Date.now();
  const sysBlob = await readSystemImage();
  let external: HTMLCanvasElement | null = null;
  if (sysBlob) {
    try {
      external = await blobToCanvas(sysBlob);
    } catch {
      external = null;
    }
  }
  // Prefer the system image when it is not the one we put there ourselves.
  const ours =
    !!clip &&
    !!external &&
    ((clip.systemSize && clip.systemSize.width === external.width && clip.systemSize.height === external.height) ||
      (clip.canvas.width === external.width && clip.canvas.height === external.height));
  if (external && !ours) {
    placeCanvas(external, activeSession() ? nextLayerName(activeSession()!.doc) : 'Pasted Image', { label: 'Paste', quiet: true });
    toast(`Pasted ${external.width}×${external.height} image`, 'success', 1800);
    return;
  }
  if (!clip) {
    toast('The clipboard has no image. Copy pixels or an image first.', 'info');
    return;
  }
  const s = activeSession();
  const canvas = createCanvas(clip.canvas.width, clip.canvas.height);
  ctx2d(canvas).drawImage(clip.canvas, 0, 0);
  if (!s) {
    placeCanvas(canvas, 'Pasted Image', { quiet: true });
    toast('Pasted into a new document', 'success', 1800);
    return;
  }
  const at = inPlace
    ? { x: clip.x, y: clip.y }
    : { x: Math.round((s.doc.width - canvas.width) / 2), y: Math.round((s.doc.height - canvas.height) / 2) };
  placeCanvas(canvas, nextLayerName(s.doc), { at, label: inPlace ? 'Paste in Place' : 'Paste', quiet: true });
}

/** Window 'paste' events (e.g. from the OS menu) with image files → place them. */
export function installPasteListener() {
  window.addEventListener('paste', (e) => {
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (useUI.getState().dialogs.length) return;
    if (Date.now() - lastPasteCommand < 1000) return;
    const items = [...(e.clipboardData?.items ?? [])];
    const img = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    const file = img?.getAsFile();
    if (file) {
      e.preventDefault();
      void placeImageBlob(file, file.name && file.name !== 'image.png' ? file.name : 'Pasted Image');
    } else if (clip && activeSession() && !e.clipboardData?.types.includes('text/plain')) {
      e.preventDefault();
      void paste(false);
    }
  });
}
