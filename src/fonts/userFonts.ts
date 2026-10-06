/**
 * User fonts: "Add font file…" (ttf/otf/woff/woff2). Each file becomes a FontFace added to
 * `document.fonts`, is persisted in IndexedDB ('perseverance-fonts') and re-registered at startup
 * (source 'user').
 *
 * Project files embed the user fonts their text layers use (`userFontFiles`); opening such a project
 * on a machine without them registers the embedded files for the session (`registerEmbeddedFonts`).
 */
import { create } from 'zustand';
import { fonts, type FontCategory, type FontDef } from '../registry';
import { openFiles, type OpenedFile } from '../platform';
import { toast } from '../state/ui';
import { parseFontFile, type FontFileInfo } from './sfnt';
import { guessCategory } from './catalog';
import { ensureFont } from './loader';

const DB_NAME = 'perseverance-fonts';
const STORE = 'fonts';

export interface StoredFont {
  id: string;
  family: string;
  subfamily: string;
  weight: number;
  style: 'normal' | 'italic';
  fileName: string;
  format: string;
  /** Category chosen at install time (older records: guessed from the family name). */
  category?: FontCategory;
  data: ArrayBuffer;
  addedAt: number;
}

/** Live list of user font files (for the Fonts panel "My Fonts" view / removal). */
export const useUserFonts = create<{ files: Omit<StoredFont, 'data'>[] }>()(() => ({ files: [] }));

const faces = new Map<string, FontFace>();

/**
 * Font files known this session but not in IndexedDB: files added while font storage was
 * unavailable, and fonts embedded in opened projects. Kept so saving a project embeds them again.
 */
const sessionFiles = new Map<string, StoredFont>();

const faceId = (family: string, weight: number, style: 'normal' | 'italic') => `${family}|${weight}|${style}`;
const normFamily = (f: string) => f.replace(/["']/g, '').trim().toLowerCase();

/* ------------------------------ IndexedDB ------------------------------ */

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

/* ------------------------------ registration ------------------------------ */


/** Every known file of a family: installed ones, then session-only ones (embedded in a project). */
function familyFiles(family: string): Omit<StoredFont, 'data'>[] {
  const stored = useUserFonts.getState().files.filter((f) => f.family === family);
  const extra = [...sessionFiles.values()].filter((f) => f.family === family && !stored.some((x) => x.id === f.id)).map(meta);
  return [...stored, ...extra];
}

function syncRegistry(family: string) {
  const files = familyFiles(family);
  if (!files.length) {
    const d = fonts.get(family);
    if (d?.source === 'user') fonts.unregister(family);
    return;
  }
  const weights = [...new Set(files.filter((f) => f.style === 'normal').map((f) => f.weight))].sort((a, b) => a - b);
  const def: FontDef = {
    id: family,
    family,
    category: files.find((f) => f.category)?.category ?? guessCategory(family),
    weights: weights.length ? weights : [files[0].weight],
    italic: files.some((f) => f.style === 'italic') || undefined,
    source: 'user',
    tags: [useUserFonts.getState().files.some((f) => f.family === family) ? 'my fonts' : 'project font', ...files.map((f) => f.subfamily.toLowerCase())],
  };
  fonts.register(def);
}

async function addFace(rec: StoredFont): Promise<boolean> {
  if (typeof FontFace === 'undefined' || !document.fonts) return false;
  try {
    const face = new FontFace(rec.family, rec.data.slice(0), { weight: String(rec.weight), style: rec.style, display: 'swap' });
    await face.load();
    document.fonts.add(face);
    faces.set(rec.id, face);
    return true;
  } catch (err) {
    console.warn(`[fonts] could not load user font ${rec.fileName}`, err);
    return false;
  }
}

function meta(rec: StoredFont): Omit<StoredFont, 'data'> {
  const { data: _data, ...rest } = rec;
  return rest;
}

let restored: Promise<void> | null = null;

/** Re-register fonts stored in IndexedDB. Called once at startup (repeat calls share the first run). */
export function restoreUserFonts(): Promise<void> {
  if (!restored) {
    restored = (async () => {
      const all = (await tx<StoredFont[]>('readonly', (s) => s.getAll())) ?? [];
      if (!all.length) return;
      const ok: StoredFont[] = [];
      for (const rec of all) if (await addFace(rec)) ok.push(rec);
      useUserFonts.setState({ files: ok.map(meta) });
      for (const fam of new Set(ok.map((r) => r.family))) syncRegistry(fam);
    })().catch((err) => console.warn('[fonts] could not restore user fonts', err));
  }
  return restored;
}

/** Resolves once the installed user fonts are registered (immediately when restore never ran). */
export function userFontsReady(): Promise<void> {
  return restored ?? Promise.resolve();
}

/**
 * Font files (with data) of the given families that came from the user — installed with
 * "Add font file…" or embedded in an opened project. Used to embed them in saved projects.
 * `sessionOnly`: only files known for this session alone (not installed in IndexedDB), which are gone
 * after a restart unless a file carries them (autosave / crash recovery).
 */
export async function userFontFiles(families: Iterable<string>, opts: { sessionOnly?: boolean } = {}): Promise<StoredFont[]> {
  const wanted = new Set([...families].map(normFamily));
  if (!wanted.size) return [];
  await userFontsReady();
  const out = new Map<string, StoredFont>();
  if (opts.sessionOnly) {
    // sessionFiles holds exactly the files IndexedDB doesn't (installing one there removes it).
    for (const rec of sessionFiles.values()) if (wanted.has(normFamily(rec.family))) out.set(rec.id, rec);
    return [...out.values()];
  }
  for (const m of useUserFonts.getState().files) {
    if (!wanted.has(normFamily(m.family))) continue;
    const rec = sessionFiles.get(m.id) ?? (await tx<StoredFont | undefined>('readonly', (st) => st.get(m.id) as IDBRequest<StoredFont | undefined>));
    if (rec?.data) out.set(m.id, rec);
  }
  for (const rec of sessionFiles.values()) if (wanted.has(normFamily(rec.family)) && !out.has(rec.id)) out.set(rec.id, rec);
  return [...out.values()];
}

export interface EmbeddedFontFile {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  fileName: string;
  format: string;
  data: ArrayBuffer;
}

/**
 * Make font files embedded in an opened project usable for this session. Families that are
 * already available (`isAvailable`: bundled, installed or system fonts) are left alone. The files
 * are not installed (they don't show up under My Fonts and are gone after a restart), but saving
 * the project embeds them again. Returns the families that were registered.
 */
export async function registerEmbeddedFonts(list: EmbeddedFontFile[], isAvailable: (family: string) => boolean): Promise<string[]> {
  await userFontsReady();
  const added = new Set<string>();
  const skipped = new Set<string>();
  for (const f of list) {
    if (skipped.has(f.family)) continue;
    if (!added.has(f.family) && isAvailable(f.family)) {
      skipped.add(f.family);
      continue;
    }
    const id = faceId(f.family, f.weight, f.style);
    if (faces.has(id)) continue;
    const rec: StoredFont = {
      id,
      family: f.family,
      subfamily: f.style === 'italic' ? 'Italic' : 'Regular',
      weight: f.weight,
      style: f.style,
      fileName: f.fileName,
      format: f.format,
      category: guessCategory(f.family),
      data: f.data,
      addedAt: Date.now(),
    };
    if (!(await addFace(rec))) continue;
    sessionFiles.set(id, rec);
    added.add(f.family);
  }
  for (const fam of added) {
    syncRegistry(fam);
    void ensureFont(fam);
  }
  return [...added];
}

const ACCEPTED = /\.(ttf|otf|ttc|woff2?)$/i;

/** Install one font file. Returns the family name, or null on failure. */
export async function installFontFile(file: OpenedFile): Promise<string | null> {
  if (!ACCEPTED.test(file.name)) {
    toast(`“${file.name}” is not a font file (use .ttf, .otf, .woff or .woff2)`, 'warning');
    return null;
  }
  let info: FontFileInfo;
  try {
    info = await parseFontFile(file.data, file.name);
  } catch {
    toast(`Couldn't read “${file.name}”`, 'error');
    return null;
  }
  const existing = fonts.get(info.family);
  if (existing?.source === 'bundled') {
    toast(`${info.family} is already bundled with Perseverance`, 'info');
    return info.family;
  }
  const style: 'normal' | 'italic' = info.italic ? 'italic' : 'normal';
  const id = faceId(info.family, info.weight, style);
  const rec: StoredFont = {
    id,
    family: info.family,
    subfamily: info.subfamily,
    weight: info.weight,
    style,
    fileName: file.name,
    format: info.format,
    category: guessCategory(info.family, info.classHint),
    data: file.data,
    addedAt: Date.now(),
  };
  // Replace a previous file with the same face.
  const old = faces.get(id);
  if (old) {
    document.fonts.delete(old);
    faces.delete(id);
  }
  if (!(await addFace(rec))) {
    toast(`“${file.name}” is not a valid or supported font`, 'error');
    return null;
  }
  const saved = await tx('readwrite', (s) => s.put(rec));
  if (saved === null) {
    sessionFiles.set(id, rec);
    toast(`${info.family} added for this session only (font storage unavailable)`, 'warning');
  } else sessionFiles.delete(id);
  useUserFonts.setState((st) => ({ files: [...st.files.filter((f) => f.id !== id), meta(rec)] }));
  syncRegistry(info.family);
  void ensureFont(info.family, info.weight, style);
  return info.family;
}

/** "Add font file…" — pick and install one or more font files. Returns installed families. */
export async function addFontFiles(): Promise<string[]> {
  const files = await openFiles({
    title: 'Add Font File',
    multiple: true,
    filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }],
  });
  const families: string[] = [];
  for (const f of files) {
    const fam = await installFontFile(f);
    if (fam && !families.includes(fam)) families.push(fam);
  }
  if (families.length) toast(families.length === 1 ? `Font added: ${families[0]}` : `${families.length} fonts added`, 'success');
  return families;
}

/** Remove every stored file of a user family. */
export async function removeUserFamily(family: string): Promise<void> {
  const files = useUserFonts.getState().files.filter((f) => f.family === family);
  for (const f of files) {
    const face = faces.get(f.id);
    if (face) document.fonts.delete(face);
    faces.delete(f.id);
    sessionFiles.delete(f.id);
    await tx('readwrite', (s) => s.delete(f.id));
  }
  useUserFonts.setState((st) => ({ files: st.files.filter((f) => f.family !== family) }));
  syncRegistry(family);
  toast(`Removed font ${family}`, 'success');
}
