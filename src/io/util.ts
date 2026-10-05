/**
 * Shared helpers for the IO module: document guards, prefs, bitmap references, layer matrices,
 * fonts, and small session-state utilities.
 */
import type { DocSession, Document, ID, Layer, RasterLayer, TransformableLayer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d } from '../core/canvas';
import { transformMatrix } from '../core/geometry';
import { getLayerSize } from '../render/compositor';
import { ensureDocumentFonts } from '../fonts/loader';
import { activeSession, useEditor, type SavedState } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';

export const APP_NAME = 'Perseverance';

/* ---------------- guards ---------------- */

/** Active session or a helpful toast when no document is open. */
export function requireSession(action = 'do that'): DocSession | null {
  const s = activeSession();
  if (!s) toast(`Open or create a document to ${action} (File ▸ New / Open).`, 'info');
  return s;
}

export function hasDoc(): boolean {
  return !!activeSession();
}

/** Active raster layer, or a toast explaining why the action needs one. */
export function requireRasterLayer(action: string): { session: DocSession; layer: RasterLayer } | null {
  const s = requireSession(action);
  if (!s) return null;
  const l = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!l) {
    toast(`Select a layer to ${action}.`, 'info');
    return null;
  }
  if (l.type !== 'raster') {
    toast(`“${l.name}” is a ${l.type} layer — ${action} works on pixel layers. Rasterize it first (Layer ▸ Rasterize).`, 'warning', 4200);
    return null;
  }
  if (l.locks.all || l.locks.pixels) {
    toast(`“${l.name}” is locked. Unlock it in the Layers panel to ${action}.`, 'warning', 3600);
    return null;
  }
  return { session: s, layer: l };
}

/* ---------------- prefs ---------------- */

export const PREFS_KEY = 'perseverance.prefs';

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const v = (JSON.parse(raw) as Record<string, unknown>)[key];
    if (v === undefined || v === null) return fallback;
    if (fallback !== null && fallback !== undefined && typeof v !== typeof fallback) return fallback;
    return v as T;
  } catch {
    return fallback;
  }
}

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable/full */
  }
}

/* ---------------- document references ---------------- */

/** Every bitmap id referenced by the document (raster layers, masks, selection). */
export function docBitmapIds(doc: Document): ID[] {
  const ids = new Set<ID>();
  for (const l of Object.values(doc.layers)) {
    if (l.type === 'raster') ids.add(l.bitmapId);
    if (l.mask) ids.add(l.mask.bitmapId);
  }
  if (doc.selection) ids.add(doc.selection.bitmapId);
  return [...ids];
}

/** Text faces used by the document. */
export function docFonts(doc: Document): { family: string; weight: number; style: string }[] {
  const seen = new Map<string, { family: string; weight: number; style: string }>();
  for (const l of Object.values(doc.layers)) {
    if (l.type !== 'text') continue;
    const f = { family: l.text.fontFamily, weight: l.text.fontWeight, style: l.text.fontStyle };
    seen.set(`${f.family}|${f.weight}|${f.style}`, f);
  }
  return [...seen.values()];
}

/** Load every font the document uses (before exporting) — never rejects, bounded wait. */
export async function ensureFontsFor(doc: Document): Promise<void> {
  const faces = docFonts(doc);
  if (!faces.length) return;
  await Promise.race([ensureDocumentFonts(faces).catch(() => undefined), new Promise((r) => setTimeout(r, 4000))]);
}

/** Local → document matrix of a transformable layer. */
export function layerMatrix(layer: TransformableLayer): DOMMatrix {
  const s = getLayerSize(layer);
  return transformMatrix(layer.transform, s.width, s.height);
}

/** True when a raster layer exactly covers the document with an identity transform. */
export function isDocAligned(layer: RasterLayer, doc: Document): boolean {
  const t = layer.transform;
  return (
    layer.width === doc.width &&
    layer.height === doc.height &&
    Math.abs(t.x) < 1e-6 &&
    Math.abs(t.y) < 1e-6 &&
    t.scaleX === 1 &&
    t.scaleY === 1 &&
    !t.rotation &&
    !t.skewX
  );
}

/**
 * The document's "Background" layer: the bottom root layer when it is a raster layer named
 * "Background" that exactly covers the canvas (new documents, opened images and PSD backgrounds).
 * Canvas Size paints the extension color into it; an ordinary bottom layer (e.g. "Layer 1" of a
 * transparent document) is never treated as a background.
 */
export function backgroundLayerOf(doc: Document): RasterLayer | null {
  const bottom = doc.layers[doc.rootIds[0]];
  if (!bottom || bottom.type !== 'raster') return null;
  if (bottom.name.trim().toLowerCase() !== 'background') return null;
  return isDocAligned(bottom, doc) ? bottom : null;
}

/** Raster layer's pixels drawn into a doc-sized canvas (no effects/opacity). */
export function rasterToDocCanvas(doc: Document, layer: RasterLayer, scale = 1): HTMLCanvasElement {
  const out = createCanvas(doc.width * scale, doc.height * scale);
  const bmp = bitmaps.tryGet(layer.bitmapId);
  if (!bmp) return out;
  const ctx = ctx2d(out);
  ctx.scale(scale, scale);
  const m = transformMatrix(layer.transform, layer.width, layer.height);
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0);
  return out;
}

/** Strip the extension from a file name. */
export function baseName(name: string): string {
  return name.replace(/\.[^./\\]+$/, '') || name;
}

/* ---------------- session state helpers ---------------- */

/** Rename a document without creating a history step (e.g. after Save As). */
export function renameDocSilently(docId: ID, name: string) {
  useEditor.setState((st) => {
    const s = st.sessions[docId];
    if (!s || s.doc.name === name) return {};
    const entries = s.history.entries.map((e) => (e.doc.id === docId ? { ...e, doc: { ...e.doc, name } } : e));
    const doc = entries[s.history.index]?.doc ?? { ...s.doc, name };
    return { sessions: { ...st.sessions, [docId]: { ...s, doc, history: { ...s.history, entries } } } };
  });
}

/** Mark the state a save wrote as saved (safe when edits happened during the async save; see SavedState). */
export function markSavedAt(docId: ID, state: SavedState) {
  useEditor.getState().markSaved(docId, state);
}

/** Mark a session as having unsaved changes (e.g. a recovered document). */
export function markDirty(docId: ID) {
  useEditor.setState((st) => {
    const s = st.sessions[docId];
    if (!s) return {};
    return { sessions: { ...st.sessions, [docId]: { ...s, savedIndex: -1, dirty: true } } };
  });
}

/** Current history entry id of a session (identifies a document state). */
export function currentEntryId(s: DocSession): string {
  return s.history.entries[s.history.index]?.id ?? '';
}

export function refreshView() {
  viewport.requestRender();
}

/** Child → parent group id for every layer in a group. */
export function parentIndex(doc: Document): Map<ID, ID> {
  const m = new Map<ID, ID>();
  for (const l of Object.values(doc.layers)) if (l.type === 'group') for (const c of l.childIds) m.set(c, l.id);
  return m;
}

/** True when the layer or any group containing it locks position (or everything). */
export function isPositionLocked(doc: Document, id: ID, parents: Map<ID, ID> = parentIndex(doc)): boolean {
  for (let cur: ID | undefined = id; cur; cur = parents.get(cur)) {
    const l = doc.layers[cur];
    if (l && (l.locks.all || l.locks.position)) return true;
  }
  return false;
}

/** Selected transformable layers (or the active one; groups expanded), excluding position-locked ones. */
export function selectedTransformables(s: DocSession): TransformableLayer[] {
  const ids = s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
  const parents = parentIndex(s.doc);
  const out: TransformableLayer[] = [];
  const add = (l: Layer | undefined) => {
    if (!l) return;
    if (l.type === 'group') {
      for (const c of l.childIds) add(s.doc.layers[c]);
      return;
    }
    if ((l.type === 'raster' || l.type === 'text' || l.type === 'shape') && !isPositionLocked(s.doc, l.id, parents)) {
      if (!out.includes(l)) out.push(l);
    }
  };
  for (const id of ids) add(s.doc.layers[id]);
  return out;
}

/**
 * Layers whose (document-space) masks must follow a transform of `targets`: the targets
 * themselves plus every selected group containing them (and nested groups), skipping
 * position-locked layers.
 */
export function maskFollowers(s: DocSession, targets: TransformableLayer[]): Layer[] {
  const doc = s.doc;
  const parents = parentIndex(doc);
  const ids = s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
  const out = new Map<ID, Layer>();
  for (const t of targets) if (t.mask) out.set(t.id, t);
  const visitGroup = (id: ID) => {
    const l = doc.layers[id];
    if (!l || l.type !== 'group') return;
    if (l.mask && !isPositionLocked(doc, id, parents)) out.set(id, l);
    l.childIds.forEach(visitGroup);
  };
  ids.forEach(visitGroup);
  return [...out.values()];
}

/** Yield to the browser (idle time when available) — keeps long async jobs from freezing the UI. */
export function idle(timeout = 200): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout });
    else setTimeout(resolve, 0);
  });
}
