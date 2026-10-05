/**
 * "My Templates": File ▸ Save as Template… stores the current document as a reusable template
 * (a .pgfx project in IndexedDB, metadata in localStorage) and registers it in the templates
 * registry (category 'Mine'). The chosen character layer is marked as the placeholder, so a new
 * thumbnail of the series starts with Replace Character / dropping the next render on it, and
 * the template's character treatment is recorded so styles and looks replace it cleanly.
 */
import { produce } from 'immer';
import type { Document, ID, Layer } from '../core/types';
import { templates, type TemplateDef } from '../registry';
import { activeSession } from '../state/editor';
import { toast } from '../state/ui';
import { uid } from '../core/ids';
import { encodeProject, decodeProject } from '../io/project';
import { TEMPLATE_STYLE_KEY } from '../looks/characterStyling';
import { documentCharacter } from '../looks/engine';
import { promptSave } from '../looks/SavePresetDialog';

export const USER_TEMPLATE_PREFIX = 'user-tpl:';
const META_KEY = 'perseverance.userTemplates';
const DB_NAME = 'perseverance-templates';
const STORE = 'templates';

export interface UserTemplateMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  created: number;
  swatch?: string[];
}

export const isUserTemplate = (id: string) => id.startsWith(USER_TEMPLATE_PREFIX);

/* ---------------- storage ---------------- */

let dbp: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the template library'));
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Template library error'));
      }),
  );
}

/** Defensive parse of the stored template index. Pure. */
export function parseTemplateMetas(raw: unknown): UserTemplateMeta[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is UserTemplateMeta =>
      !!m && typeof m === 'object' && typeof (m as UserTemplateMeta).id === 'string' && isUserTemplate((m as UserTemplateMeta).id) && typeof (m as UserTemplateMeta).name === 'string' && (m as UserTemplateMeta).width > 0 && (m as UserTemplateMeta).height > 0,
  );
}

function readMetas(): UserTemplateMeta[] {
  try {
    return parseTemplateMetas(JSON.parse(localStorage.getItem(META_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

function writeMetas(list: UserTemplateMeta[]) {
  localStorage.setItem(META_KEY, JSON.stringify(list));
}

/* ---------------- registry ---------------- */

function toDef(m: UserTemplateMeta): TemplateDef {
  return {
    id: m.id,
    name: m.name,
    category: 'Mine',
    description: 'Your template — replace the character and edit the text.',
    width: m.width,
    height: m.height,
    swatch: m.swatch,
    async build(): Promise<Document> {
      const buf = await idb<ArrayBuffer | undefined>('readonly', (s) => s.get(m.id));
      if (!buf) throw new Error('the saved template data is missing');
      const doc = await decodeProject(buf);
      doc.id = uid('doc_');
      doc.name = m.name;
      doc.meta = { ...(doc.meta ?? {}), template: m.id };
      return doc;
    },
  };
}

/** Register the saved templates (called once at startup). */
export function loadUserTemplates() {
  for (const m of readMetas()) if (!templates.has(m.id)) templates.register(toDef(m));
}

export async function deleteUserTemplate(id: string) {
  if (!isUserTemplate(id)) return;
  try {
    await idb('readwrite', (s) => s.delete(id));
  } catch (e) {
    console.warn('[templates] delete failed', e);
  }
  writeMetas(readMetas().filter((m) => m.id !== id));
  templates.unregister(id);
  toast('Template deleted.', 'info');
}

/* ---------------- save ---------------- */

/**
 * The document prepared as a template (pure): `characterId` (when given) becomes the
 * placeholder character with its current treatment recorded as the template's; the selection
 * is dropped.
 */
export function templateDocument(doc: Document, templateId: string, characterId: ID | null): Document {
  return produce(doc, (d) => {
    d.selection = null;
    const meta: Record<string, unknown> = { ...(d.meta ?? {}), template: templateId };
    delete meta.characterId;
    const l = characterId ? (d.layers[characterId] as Layer | undefined) : undefined;
    if (l && l.type === 'raster') {
      // The character's whole current treatment (styler/look included) becomes the template's.
      const lm: Record<string, unknown> = { ...(l.meta ?? {}), placeholder: true, kind: 'character' };
      delete lm.styler;
      delete lm.look;
      if (l.filters.length || l.effects.length) lm[TEMPLATE_STYLE_KEY] = { filterIds: l.filters.map((f) => f.id), effectIds: l.effects.map((e) => e.id) };
      l.meta = lm;
      meta.characterId = l.id;
    }
    d.meta = meta;
  });
}

function candidateCharacter(doc: Document, activeId: ID | null): ID | null {
  const active = activeId ? doc.layers[activeId] : null;
  if (active?.type === 'raster' && (active.meta?.kind === 'character' || active.meta?.placeholder === true || doc.meta?.characterId === active.id)) return active.id;
  const ch = documentCharacter(doc);
  if (ch) return ch;
  return active?.type === 'raster' ? active.id : null;
}

/** File ▸ Save as Template…: store the active document as one of My Templates. */
export async function saveAsTemplate() {
  const s = activeSession();
  if (!s) return void toast('Open the document you want to reuse first.', 'info');
  const doc = s.doc;
  const charId = candidateCharacter(doc, s.activeLayerId);
  const charLayer = charId ? doc.layers[charId] : null;
  const res = await promptSave({
    title: 'Save as Template',
    defaultName: doc.name || 'My template',
    options: charLayer
      ? [{ key: 'placeholder', label: `Mark “${charLayer.name}” as the character to replace`, checked: true, hint: 'New documents from this template start with this layer selected for Replace Character' }]
      : [],
    description: (
      <>
        Saves every layer (pixels, text, effects, looks) as a template under <b>My templates</b> in File ▸ New from Template…
        {charLayer ? ' The marked character keeps its spot, filters and effects when you swap in the next render.' : ' Select your character layer first to mark it as the one to replace.'}
      </>
    ),
  });
  if (!res) return;
  const id = `${USER_TEMPLATE_PREFIX}${uid('t_')}`;
  try {
    const tdoc = templateDocument(doc, id, res.options.placeholder ? charId : null);
    const data = await encodeProject(tdoc, { background: true });
    await idb('readwrite', (st) => st.put(data, id));
    const meta: UserTemplateMeta = { id, name: res.name, width: doc.width, height: doc.height, created: Date.now(), swatch: doc.background ? [doc.background, '#1e1e1e'] : undefined };
    writeMetas([...readMetas(), meta]);
    templates.register(toDef(meta));
    toast(`Saved “${res.name}” to My Templates — find it in File ▸ New from Template….`, 'success', 4200);
  } catch (e) {
    console.error('[templates] save failed', e);
    toast(`Could not save the template: ${(e as Error)?.message ?? e}`, 'error', 4200);
  }
}
