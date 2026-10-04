/**
 * User fonts: "Add font file…" (ttf/otf/woff/woff2). Each file becomes a FontFace added to
 * `document.fonts`, is persisted in IndexedDB ('perseverance-fonts') and re-registered at startup
 * (source 'user').
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


function syncRegistry(family: string) {
  const files = useUserFonts.getState().files.filter((f) => f.family === family);
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
    tags: ['my fonts', ...files.map((f) => f.subfamily.toLowerCase())],
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

/** Re-register fonts stored in IndexedDB. Called once at startup. */
export async function restoreUserFonts(): Promise<void> {
  const all = (await tx<StoredFont[]>('readonly', (s) => s.getAll())) ?? [];
  if (!all.length) return;
  const ok: StoredFont[] = [];
  for (const rec of all) if (await addFace(rec)) ok.push(rec);
  useUserFonts.setState({ files: ok.map(meta) });
  for (const fam of new Set(ok.map((r) => r.family))) syncRegistry(fam);
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
  const id = `${info.family}|${info.weight}|${style}`;
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
  if (saved === null) toast(`${info.family} added for this session only (font storage unavailable)`, 'warning');
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
    await tx('readwrite', (s) => s.delete(f.id));
  }
  useUserFonts.setState((st) => ({ files: st.files.filter((f) => f.family !== family) }));
  syncRegistry(family);
  toast(`Removed font ${family}`, 'success');
}
