/**
 * Perseverance project files (.pgfx): encode the active document + every bitmap it references
 * into the binary container (see container.ts), and load them back into new sessions.
 */
import type { Document, ID, Layer, LayerBase } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { canvasToBlob, createCanvas, ctx2d } from '../core/canvas';
import { uid } from '../core/ids';
import { DEFAULT_LOCKS } from '../core/document';
import { appVersion, type OpenedFile } from '../platform';
import { useEditor } from '../state/editor';
import { packContainer, PGFX_VERSION, unpackContainer, type ContainerBlob } from './container';
import { APP_NAME, baseName, docBitmapIds, idle } from './util';

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

interface PngCacheEntry {
  version: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

/** PNG cache keyed by bitmap id + version: saves/autosaves only re-encode bitmaps that changed. */
const pngCache = new Map<ID, PngCacheEntry>();

async function encodeBitmap(id: ID): Promise<ContainerBlob | null> {
  const c = bitmaps.tryGet(id);
  if (!c) return null;
  const version = bitmaps.version(id);
  const hit = pngCache.get(id);
  if (hit && hit.version === version && hit.width === c.width && hit.height === c.height) {
    return { id, width: hit.width, height: hit.height, data: hit.data };
  }
  const blob = await canvasToBlob(c, 'image/png');
  const data = await blob.arrayBuffer();
  pngCache.set(id, { version, width: c.width, height: c.height, data });
  return { id, width: c.width, height: c.height, data };
}

/** Drop cached PNGs for bitmaps no open document references any more. */
function prunePngCache() {
  const keep = new Set<ID>();
  for (const s of Object.values(useEditor.getState().sessions)) for (const id of docBitmapIds(s.doc)) keep.add(id);
  for (const id of pngCache.keys()) if (!keep.has(id)) pngCache.delete(id);
}

/**
 * Encode a document as a .pgfx container. Bitmaps are encoded asynchronously one by one;
 * with `background: true` the work yields to idle time between bitmaps (autosave).
 */
export async function encodeProject(doc: Document, opts: { background?: boolean } = {}): Promise<ArrayBuffer> {
  const blobs: ContainerBlob[] = [];
  for (const id of docBitmapIds(doc)) {
    if (opts.background) await idle();
    const b = await encodeBitmap(id);
    if (b) blobs.push(b);
  }
  prunePngCache();
  return packContainer(
    { version: PGFX_VERSION, app: `${APP_NAME} ${appVersion}`, savedAt: new Date().toISOString(), document: doc },
    blobs,
  );
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

const BASE_DEFAULTS: Omit<LayerBase, 'id' | 'name' | 'type'> = {
  visible: true,
  locks: { ...DEFAULT_LOCKS },
  opacity: 1,
  fillOpacity: 1,
  blendMode: 'normal',
  clipped: false,
  mask: null,
  effects: [],
  filters: [],
  label: 'none',
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Validate/repair a document coming from disk (older versions, hand edits, partial writes). */
export function sanitizeDocument(raw: unknown): Document {
  if (!raw || typeof raw !== 'object') throw new Error('Project has no document');
  const d = raw as Partial<Document> & Record<string, unknown>;
  const width = Math.round(num(d.width, 0));
  const height = Math.round(num(d.height, 0));
  if (width < 1 || height < 1 || width > 30000 || height > 30000) throw new Error('Project document has an invalid size');
  const rawLayers = d.layers && typeof d.layers === 'object' ? (d.layers as Record<string, Layer>) : {};
  const layers: Record<ID, Layer> = {};
  for (const [id, l] of Object.entries(rawLayers)) {
    if (!l || typeof l !== 'object' || typeof l.type !== 'string') continue;
    const fixed = { ...BASE_DEFAULTS, ...l, id, name: typeof l.name === 'string' ? l.name : 'Layer' } as Layer;
    fixed.locks = { ...DEFAULT_LOCKS, ...(l.locks ?? {}) };
    if (!Array.isArray(fixed.effects)) fixed.effects = [];
    if (!Array.isArray(fixed.filters)) fixed.filters = [];
    if (fixed.type === 'group' && !Array.isArray(fixed.childIds)) fixed.childIds = [];
    if (fixed.type === 'raster' && (typeof fixed.bitmapId !== 'string' || !fixed.width || !fixed.height)) continue;
    layers[id] = fixed;
  }
  // Keep only layers reachable from the root (each exactly once).
  const seen = new Set<ID>();
  const walk = (ids: unknown): ID[] => {
    if (!Array.isArray(ids)) return [];
    const out: ID[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || seen.has(id) || !layers[id]) continue;
      seen.add(id);
      out.push(id);
      const l = layers[id];
      if (l.type === 'group') l.childIds = walk(l.childIds);
    }
    return out;
  };
  const rootIds = walk(d.rootIds);
  for (const id of Object.keys(layers)) if (!seen.has(id)) delete layers[id];
  return {
    id: typeof d.id === 'string' ? d.id : uid('doc_'),
    name: typeof d.name === 'string' && d.name ? d.name : 'Untitled',
    width,
    height,
    background: typeof d.background === 'string' ? d.background : null,
    layers,
    rootIds,
    selection: d.selection && typeof d.selection === 'object' && typeof d.selection.bitmapId === 'string' ? d.selection : null,
    guides: Array.isArray(d.guides) ? d.guides : [],
    dpi: num(d.dpi, 72),
    ...(d.meta && typeof d.meta === 'object' ? { meta: d.meta } : {}),
  };
}

async function decodePng(data: Uint8Array, w: number, h: number): Promise<HTMLCanvasElement> {
  const c = createCanvas(w || 1, h || 1);
  if (!data.byteLength) return c;
  const bmp = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/png' }));
  if (bmp.width !== c.width || bmp.height !== c.height) {
    c.width = bmp.width;
    c.height = bmp.height;
  }
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

/**
 * Decode a .pgfx buffer into a Document whose bitmaps are registered in the store.
 * Bitmap ids that already exist in the store (e.g. the same file opened twice) are remapped.
 */
export async function decodeProject(buf: ArrayBuffer | Uint8Array): Promise<Document> {
  const { header, blobs } = unpackContainer(buf);
  const doc = sanitizeDocument(header.document);
  const remap = new Map<ID, ID>();
  for (const b of blobs) {
    const canvas = await decodePng(b.data, b.width, b.height);
    const id = bitmaps.has(b.id) ? uid('bmp_') : b.id;
    bitmaps.add(canvas, id);
    remap.set(b.id, id);
  }
  const fix = (id: ID, w: number, h: number): ID => {
    const m = remap.get(id);
    if (m) return m;
    // Missing pixel data: substitute an empty bitmap so the document stays editable.
    const nid = bitmaps.create(w, h);
    remap.set(id, nid);
    return nid;
  };
  for (const l of Object.values(doc.layers)) {
    if (l.type === 'raster') l.bitmapId = fix(l.bitmapId, l.width, l.height);
    if (l.mask) l.mask = { ...l.mask, bitmapId: fix(l.mask.bitmapId, doc.width, doc.height) };
  }
  if (doc.selection) doc.selection = { ...doc.selection, bitmapId: fix(doc.selection.bitmapId, doc.width, doc.height) };
  // A document with the same id may already be open (same file opened twice).
  if (useEditor.getState().sessions[doc.id]) doc.id = uid('doc_');
  return doc;
}

/** Open a .pgfx file as a new document session. */
export async function loadProject(file: OpenedFile): Promise<Document> {
  const doc = await decodeProject(file.data);
  if (!doc.name || doc.name === 'Untitled') doc.name = baseName(file.name);
  useEditor.getState().openDocument(doc, { filePath: file.path, label: 'Open' });
  return doc;
}
