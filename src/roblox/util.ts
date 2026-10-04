/** Shared helpers for the Roblox module (document/layer guards, new documents, layer placement). */
import type { Document, Layer, RasterLayer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeRasterLayer } from '../core/document';
import { activeDoc, activeLayer, useEditor } from '../state/editor';
import { toast } from '../state/ui';

/** The active document, or null after showing a helpful toast. */
export function requireDoc(action = 'do this'): Document | null {
  const doc = activeDoc();
  if (!doc) {
    toast(`Open or create a document to ${action} (Roblox ▸ New Icon / New Thumbnail).`, 'warning', 3600);
    return null;
  }
  return doc;
}

/** The active raster layer, or null after a toast explaining what is needed. */
export function requireRasterLayer(action: string): RasterLayer | null {
  const doc = requireDoc(action);
  if (!doc) return null;
  const l = activeLayer();
  if (!l) {
    toast(`Select a layer to ${action}.`, 'warning');
    return null;
  }
  if (l.type !== 'raster') {
    toast(`${action[0].toUpperCase()}${action.slice(1)} works on pixel layers — rasterize “${l.name}” first (Layer ▸ Rasterize).`, 'warning', 4200);
    return null;
  }
  if (l.locks.all || l.locks.pixels) {
    toast(`“${l.name}” is locked. Unlock its pixels to ${action}.`, 'warning');
    return null;
  }
  if (!bitmaps.has(l.bitmapId)) {
    toast('The layer has no pixel data.', 'error');
    return null;
  }
  return l;
}

/** The active layer if it can carry smart filters/effects (raster/text/shape). */
export function requireStylableLayer(action = 'style it'): Layer | null {
  const doc = requireDoc(action);
  if (!doc) return null;
  const l = activeLayer();
  if (!l) {
    toast(`Select your character layer to ${action}.`, 'warning');
    return null;
  }
  if (l.type !== 'raster' && l.type !== 'text' && l.type !== 'shape') {
    toast(`Select a character layer (pixel, text or shape) to ${action} — “${l.name}” is a ${l.type} layer.`, 'warning', 4000);
    return null;
  }
  return l;
}

/** Create and open a new document with a white "Background" pixel layer. */
export function newDocumentWithBackground(name: string, width: number, height: number, color = '#ffffff'): string {
  const doc = createDocument({ name, width, height, background: null });
  const bg = makeRasterLayer({ name: 'Background', bitmapId: bitmaps.create(width, height, color), width, height });
  insertLayerDraft(doc, bg);
  return useEditor.getState().openDocument(doc, { label: `New ${name}`, activeLayerId: bg.id });
}

/** Open a new transparent document (used when a render is added with no document open). */
export function newTransparentDocument(name: string, width: number, height: number): Document {
  const doc = createDocument({ name, width, height, background: null });
  useEditor.getState().openDocument(doc, { label: `New ${name}` });
  return doc;
}

/** Load an image Blob into a canvas (no DOM image needed). */
export async function blobToImageCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

export function isSquareDoc(doc: { width: number; height: number }) {
  return Math.abs(doc.width / doc.height - 1) < 0.02;
}

export function isWideDoc(doc: { width: number; height: number }) {
  return Math.abs(doc.width / doc.height - 16 / 9) < 0.04;
}
