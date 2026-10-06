/**
 * Perseverance project files (.pgfx): encode the active document + every bitmap it references
 * (+ the user-added fonts its text uses) into the binary container (see container.ts), and load
 * them back into new sessions.
 */
import type { Document, ID, Layer, LayerBase } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { canvasToBlob, createCanvas, ctx2d } from '../core/canvas';
import { uid } from '../core/ids';
import { DEFAULT_LOCKS } from '../core/document';
import { appVersion, fileNameOf, type OpenedFile } from '../platform';
import { useEditor } from '../state/editor';
import { packContainer, PGFX_VERSION, unpackContainer, type ContainerFont } from './container';
import { PngCache, startEncodes, type SnapshotItem } from './pngCache';
import { embeddableFonts, registerProjectFonts, reportProjectFonts } from './projectFonts';
import { APP_NAME, baseName, docBitmapIds, idle } from './util';

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

/**
 * Saves/autosaves only re-encode bitmaps that changed. Entries are bound to the exact canvas
 * object, so an id reused by another project's bitmap never serves stale pixels (see pngCache.ts).
 */
const pngCache = new PngCache();

const encodePng = async (c: HTMLCanvasElement) => (await canvasToBlob(c, 'image/png')).arrayBuffer();

/** Drop cached PNGs for bitmaps no open document references any more. */
function prunePngCache() {
  const keep = new Set<ID>();
  for (const s of Object.values(useEditor.getState().sessions)) for (const id of docBitmapIds(s.doc)) keep.add(id);
  pngCache.prune(keep);
}

export interface EncodeOptions {
  background?: boolean;
  fonts?: 'all' | 'session';
}

/** An encoded project snapshot that can be packed again under another document name (same pixels, fonts, time). */
export interface ProjectSnapshot {
  /** The .pgfx file; `name` replaces the document's name inside it (Save As: the chosen file's name). */
  pack(name?: string): ArrayBuffer;
}

/**
 * Encode a document as a .pgfx container.
 *
 * The file is a snapshot of ONE state: the document JSON is immutable, and the pixels of every
 * bitmap it references are captured synchronously when this is called — cached PNGs for unchanged
 * bitmaps, and the other encodes are started before the first await (canvas.toBlob copies the
 * pixels at call time; see startEncodes). Edits, undo/redo or bitmap GC while the PNGs encode
 * (which takes seconds for big documents) can therefore never leak into the file. Callers must
 * pass the document state they will mark as saved, and call this synchronously after reading it.
 *
 * Fonts (`fonts`): 'all' embeds every user-added font file the text uses (the default: project files
 * travel to other computers); 'session' only those this machine has for the current session alone —
 * fonts that came embedded in an opened project, or were added while font storage was unavailable —
 * which are gone after a restart unless the file carries them (the default with `background`:
 * recovery entries, whose installed fonts stay on this machine). `background: true` (autosave,
 * templates) also yields to idle time before packing.
 */
export async function encodeProject(doc: Document, opts: EncodeOptions = {}): Promise<ArrayBuffer> {
  return (await encodeProjectSnapshot(doc, opts)).pack();
}

/** encodeProject, keeping the encoded snapshot: same contract (synchronous pixel snapshot at call time). */
export async function encodeProjectSnapshot(doc: Document, opts: EncodeOptions = {}): Promise<ProjectSnapshot> {
  // ---- synchronous snapshot (no await above this line) ----
  const savedAt = new Date().toISOString();
  const items: SnapshotItem<HTMLCanvasElement>[] = [];
  for (const id of docBitmapIds(doc)) {
    const canvas = bitmaps.tryGet(id);
    if (canvas) items.push({ id, canvas, version: bitmaps.version(id) });
  }
  const jobs = startEncodes(pngCache, items, encodePng);
  // ---- asynchronous part: works only on the snapshot ----
  const fontsP: Promise<ContainerFont[]> = embeddableFonts(doc, { sessionOnly: (opts.fonts ?? (opts.background ? 'session' : 'all')) === 'session' });
  const blobs = await Promise.all(jobs.map(async (j) => ({ id: j.id, width: j.width, height: j.height, data: await j.data })));
  const embedded = await fontsP;
  prunePngCache();
  if (opts.background) await idle();
  const app = `${APP_NAME} ${appVersion}`;
  return {
    pack: (name) => packContainer({ version: PGFX_VERSION, app, savedAt, document: name && name !== doc.name ? { ...doc, name } : doc }, blobs, embedded),
  };
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
  return (await decodeProjectWithFonts(buf)).doc;
}

/**
 * decodeProject that also registers the fonts embedded in the file which this machine lacks
 * (for the session) and returns their families.
 */
export async function decodeProjectWithFonts(buf: ArrayBuffer | Uint8Array): Promise<{ doc: Document; embeddedFonts: string[] }> {
  const { header, blobs, fonts } = unpackContainer(buf);
  const doc = sanitizeDocument(header.document);
  // Before the document opens, so its text renders with the right faces from the first frame.
  const embeddedFonts = await registerProjectFonts(fonts);
  const remap = new Map<ID, ID>();
  for (const b of blobs) {
    const canvas = await decodePng(b.data, b.width, b.height);
    const id = bitmaps.has(b.id) ? uid('bmp_') : b.id;
    // The id may have belonged to a bitmap of a closed project: its cached PNG is not ours.
    pngCache.forget(id);
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
  return { doc, embeddedFonts };
}

/**
 * Open a .pgfx file as a new document session. The document is named after the file (like
 * Photoshop): copies, renamed files and projects made from one template stay distinguishable.
 */
export async function loadProject(file: OpenedFile): Promise<Document> {
  const { doc, embeddedFonts } = await decodeProjectWithFonts(file.data);
  const fromFile = baseName(fileNameOf(file.name ?? '')).trim();
  if (fromFile) doc.name = fromFile;
  useEditor.getState().openDocument(doc, { filePath: file.path, label: 'Open' });
  // Missing / embedded font notes (never blocks or fails the open).
  void reportProjectFonts(doc, embeddedFonts).catch(() => undefined);
  return doc;
}
