/**
 * CONTRACT (owned by the IO module): open any supported file.
 *  - .pgfx project → new document session
 *  - .psd → new document with layers
 *  - images (png/jpg/webp/gif/bmp) → new document (asNewDocument / no doc open) or placed as a
 *    new layer in the active document.
 */
import type { OpenedFile } from '../platform';
import { extOf } from '../platform';
import { bitmaps } from '../core/bitmaps';
import { blobToCanvas, createCanvas, ctx2d } from '../core/canvas';
import { createDocument, insertLayerDraft, makeRasterLayer } from '../core/document';
import { activeSession, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { isPgfx } from './container';
import { loadProject } from './project';
import { addRecentFile } from './recent';
import { baseName } from './util';

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

type Kind = 'pgfx' | 'psd' | 'image' | 'unknown';

function sniff(file: OpenedFile): Kind {
  const ext = extOf(file.name);
  const b = new Uint8Array(file.data, 0, Math.min(12, file.data.byteLength));
  if (ext === 'pgfx' || isPgfx(b)) return 'pgfx';
  if (ext === 'psd' || ext === 'psb' || (b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53)) return 'psd';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  // Magic numbers for images with missing/odd extensions.
  if (b[0] === 0x89 && b[1] === 0x50) return 'image'; // PNG
  if (b[0] === 0xff && b[1] === 0xd8) return 'image'; // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image'; // GIF
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image'; // BMP
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image'; // RIFF WEBP
  return 'unknown';
}

export async function openFile(file: OpenedFile, opts: { asNewDocument?: boolean } = {}): Promise<void> {
  const kind = sniff(file);
  try {
    if (kind === 'pgfx') {
      const doc = await loadProject(file);
      addRecentFile(file.path, file.name);
      toast(`Opened “${doc.name}”`, 'success');
      return;
    }
    if (kind === 'psd') {
      if (file.data.byteLength > 4 * 1024 * 1024) {
        // Parsing is synchronous: show feedback and let it paint first.
        toast(`Reading “${file.name}”…`, 'info', 2000);
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      }
      const { importPsd } = await import('./psd');
      const doc = await importPsd(file);
      addRecentFile(file.path, file.name);
      toast(`Imported “${doc.name}” (${Object.keys(doc.layers).length} layers)`, 'success');
      return;
    }
    if (kind === 'image') {
      const canvas = await blobToCanvas(new Blob([file.data], { type: MIME[extOf(file.name)] ?? '' }));
      if (opts.asNewDocument || !activeSession()) {
        openImageAsDocument(canvas, baseName(file.name), file.path);
        addRecentFile(file.path, file.name);
        toast(`Opened “${file.name}”`, 'success');
      } else {
        placeCanvas(canvas, baseName(file.name));
      }
      return;
    }
  } catch (e) {
    console.error('[io] open failed', e);
    const msg = (e as Error)?.message || String(e);
    throw new Error(kind === 'image' ? `the image could not be decoded (${msg})` : msg);
  }
  throw new Error(`unsupported file type “.${extOf(file.name) || '?'}” — open .pgfx, .psd, PNG, JPEG, WebP, GIF or BMP files`);
}

/** Create a new document sized to the image with the image as its only layer. */
export function openImageAsDocument(canvas: HTMLCanvasElement, name: string, filePath: string | null = null) {
  const doc = createDocument({ name, width: canvas.width, height: canvas.height, background: null });
  const layer = makeRasterLayer({ name: 'Background', bitmapId: bitmaps.add(canvas), width: canvas.width, height: canvas.height });
  insertLayerDraft(doc, layer, {});
  // Image paths are not project paths: Save goes through Save As (never overwrite the image).
  void filePath;
  useEditor.getState().openDocument(doc, { label: 'Open', activeLayerId: layer.id });
  return doc.id;
}

/** High-quality downscale (stepwise halving avoids aliasing on big reductions). */
export function resampleCanvas(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  let cur = src;
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  while (cur.width / 2 > w && cur.height / 2 > h) {
    const half = createCanvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
    const hctx = ctx2d(half);
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

/**
 * Place a canvas as a new raster layer in the active document (centered, scaled down to fit 90%
 * of the canvas when larger) — or open it as a new document when nothing is open.
 * `at` places the image's top-left at a document position instead (paste in place).
 */
export function placeCanvas(
  canvas: HTMLCanvasElement,
  name: string,
  opts: { at?: { x: number; y: number }; label?: string; quiet?: boolean } = {},
) {
  const s = activeSession();
  if (!s) {
    openImageAsDocument(canvas, name);
    return;
  }
  const doc = s.doc;
  let img = canvas;
  if (!opts.at) {
    const k = Math.min(1, (doc.width * 0.9) / canvas.width, (doc.height * 0.9) / canvas.height);
    if (k < 1) img = resampleCanvas(canvas, canvas.width * k, canvas.height * k);
  }
  const x = opts.at ? opts.at.x : Math.round((doc.width - img.width) / 2);
  const y = opts.at ? opts.at.y : Math.round((doc.height - img.height) / 2);
  const layer = makeRasterLayer({ name, bitmapId: bitmaps.add(img), width: img.width, height: img.height, transform: { x, y } });
  useEditor.getState().addLayer(layer, { label: opts.label ?? `Place ${name}` });
  viewport.requestRender();
  if (!opts.quiet) toast(`Placed ${name}${img !== canvas ? ` (scaled to ${img.width}×${img.height})` : ''}`, 'success');
  return layer.id;
}

/** Place image data (clipboard / drag-drop blob) into the active document as a new layer. */
export async function placeImageBlob(blob: Blob, name = 'Pasted Image'): Promise<void> {
  let canvas: HTMLCanvasElement;
  try {
    canvas = await blobToCanvas(blob);
  } catch (e) {
    console.error('[io] placeImageBlob decode failed', e);
    toast(`Could not read ${name}: the image format is not supported.`, 'error');
    return;
  }
  const clean = baseName(name);
  if (!activeSession()) {
    openImageAsDocument(canvas, clean);
    toast(`Opened ${clean} as a new document`, 'success');
    return;
  }
  placeCanvas(canvas, clean);
}
