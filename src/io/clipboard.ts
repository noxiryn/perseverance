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
import { placeCanvas } from './open';
import { drawDocCanvasOnMask, drawDocCanvasOnRaster, pixelTarget, selectionClippedFill, selectionRect } from './pixels';
import { baseName, rasterToDocCanvas, requireSession } from './util';

interface ClipData {
  canvas: HTMLCanvasElement;
  /** Original doc-space position of the copied pixels. */
  x: number;
  y: number;
  /** When the copy happened (ms). */
  time: number;
  /** The PNG reached the system clipboard (so a different system image there is newer). */
  systemWritten: boolean;
  /** Tiny color signature used to recognize our own image when reading the system clipboard back. */
  fingerprint: Uint8ClampedArray;
}

let clip: ClipData | null = null;
let lastPasteCommand = 0;
/** Last time the window lost focus (the user may have copied something in another app). */
let lastBlur = 0;

const FP = 8;

function fingerprintOf(c: HTMLCanvasElement): Uint8ClampedArray {
  const f = createCanvas(FP, FP);
  const ctx = ctx2d(f, { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, FP, FP);
  return ctx.getImageData(0, 0, FP, FP).data;
}

/** True when `external` (read from the system clipboard) is the image we put there. */
function isOurImage(external: HTMLCanvasElement, data: ClipData): boolean {
  if (external.width !== data.canvas.width || external.height !== data.canvas.height) return false;
  const a = fingerprintOf(external);
  const b = data.fingerprint;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  // PNG round trips may alter colors slightly (color management / premultiplication).
  return diff / a.length < 10;
}

/**
 * Which clipboard to paste from: the system image unless it is our own copy, or older than our
 * internal copy (the system write failed and the window never lost focus since).
 */
function preferSystem(external: HTMLCanvasElement, data: ClipData | null): boolean {
  if (!data) return true;
  if (isOurImage(external, data)) return false;
  if (data.systemWritten) return true; // something replaced our image on the system clipboard
  return lastBlur > data.time;
}

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
    if (clip && clip.canvas === canvas) clip.systemWritten = true;
  } catch {
    /* no focus / permission — the internal clipboard still works */
  }
}

export function copy(merged = false): boolean {
  const s = requireSession(merged ? 'copy merged' : 'copy');
  if (!s) return false;
  const src = copySource(s, merged);
  if (!src) return false;
  clip = { ...src, time: Date.now(), systemWritten: false, fingerprint: fingerprintOf(src.canvas) };
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
    toast(
      layer
        ? `“${layer.name}” is a ${layer.type} layer — clearing pixels needs a pixel layer. Rasterize it first.`
        : 'Select a layer first.',
      'warning',
      4000,
    );
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
  if (s.doc.selection) {
    clearSelectedPixels(activeSession()!, 'Cut');
    return;
  }
  if (!l) return;
  if (l.locks.all || l.locks.pixels) return void toast(`“${l.name}” is locked — copied only.`, 'warning');
  // No selection: cut everything from the edited mask (hide all) or from the pixel layer.
  const editingMask = s.editTarget === 'mask' && !!l.mask && bitmaps.has(l.mask.bitmapId);
  const patch = editingMask
    ? bitmaps.edit(l.mask!.bitmapId, (ctx, c) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
      })
    : l.type === 'raster'
      ? bitmaps.edit(l.bitmapId, (ctx, c) => ctx.clearRect(0, 0, c.width, c.height))
      : null;
  if (!patch) return;
  useEditor.getState().commit('Cut', undefined, { patches: [patch] });
  viewport.requestRender();
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

/**
 * Paste an image that came from the system clipboard (another app) as a new layer, centered at
 * 1:1 like Photoshop — never resampled (a screenshot pasted into a same-sized thumbnail fills it).
 */
function pasteExternal(external: HTMLCanvasElement, name = 'Pasted Image') {
  const s = activeSession();
  if (!s) {
    placeCanvas(external, name, { label: 'Paste', quiet: true });
    toast('Pasted into a new document', 'success', 2200);
    return;
  }
  const at = { x: Math.round((s.doc.width - external.width) / 2), y: Math.round((s.doc.height - external.height) / 2) };
  placeCanvas(external, nextLayerName(s.doc), { at, label: 'Paste', quiet: true });
  const larger = external.width > s.doc.width || external.height > s.doc.height;
  toast(
    `Pasted ${external.width}×${external.height} image${larger ? ' — larger than the canvas; use Free Transform (Ctrl+T) to scale it' : ''}`,
    'success',
    larger ? 3600 : 2200,
  );
}

/** Paste the internal clipboard (centered, or at its original position). */
function pasteInternal(data: ClipData, inPlace: boolean) {
  const s = activeSession();
  const canvas = createCanvas(data.canvas.width, data.canvas.height);
  ctx2d(canvas).drawImage(data.canvas, 0, 0);
  if (!s) {
    placeCanvas(canvas, 'Pasted Image', { quiet: true });
    toast('Pasted into a new document', 'success', 1800);
    return;
  }
  const at = inPlace
    ? { x: data.x, y: data.y }
    : { x: Math.round((s.doc.width - canvas.width) / 2), y: Math.round((s.doc.height - canvas.height) / 2) };
  placeCanvas(canvas, nextLayerName(s.doc), { at, label: inPlace ? 'Paste in Place' : 'Paste', quiet: true });
}

async function decode(blob: Blob | null): Promise<HTMLCanvasElement | null> {
  if (!blob) return null;
  try {
    return await blobToCanvas(blob);
  } catch {
    return null;
  }
}

/**
 * The image Edit ▸ Paste would use right now (the system clipboard image when it is newer than
 * our internal copy, else a copy of the internal clipboard), or null when there is none. Used by
 * features that consume a clipboard image themselves (e.g. Replace Character).
 */
export async function readClipboardImage(): Promise<HTMLCanvasElement | null> {
  const external = await decode(await readSystemImage());
  if (external && preferSystem(external, clip)) return external;
  if (!clip) return external;
  const canvas = createCanvas(clip.canvas.width, clip.canvas.height);
  ctx2d(canvas).drawImage(clip.canvas, 0, 0);
  return canvas;
}

/**
 * Edit ▸ Paste / Paste in Place: the system clipboard image when it is newer than (and not the
 * same as) our internal copy, else the internal clipboard.
 */
export async function paste(inPlace = false) {
  lastPasteCommand = Date.now();
  const external = await decode(await readSystemImage());
  if (external && preferSystem(external, clip)) return pasteExternal(external);
  if (!clip) {
    toast('The clipboard has no image. Copy pixels or an image first.', 'info');
    return;
  }
  pasteInternal(clip, inPlace);
}

/** Window 'paste' events (OS menu / clipboard managers) with images → place them as layers. */
export function installPasteListener() {
  window.addEventListener('blur', () => {
    lastBlur = Date.now();
  });
  window.addEventListener('paste', (e) => {
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (useUI.getState().dialogs.length) return;
    if (Date.now() - lastPasteCommand < 1000) return;
    const items = [...(e.clipboardData?.items ?? [])];
    const img = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    const file = img?.getAsFile();
    if (file) {
      e.preventDefault();
      const name = file.name && file.name !== 'image.png' ? baseName(file.name) : 'Pasted Image';
      void decode(file).then((external) => {
        if (!external) return void toast('The pasted image could not be read.', 'error');
        if (preferSystem(external, clip)) pasteExternal(external, name);
        else if (clip) pasteInternal(clip, false);
      });
    } else if (clip && activeSession() && !e.clipboardData?.types.includes('text/plain')) {
      e.preventDefault();
      pasteInternal(clip, false);
    }
  });
}
