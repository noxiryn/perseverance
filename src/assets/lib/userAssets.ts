/**
 * "My Assets": user-imported images stored in IndexedDB ('perseverance-assets') and exposed as
 * element assets (category 'My Assets') in the assets registry so every module can place them.
 */
import { create } from 'zustand';
import type { AssetDef } from '../../registry';
import { assets } from '../../registry';
import { uid } from '../../core/ids';
import { USER_CATEGORY } from '../place';
import { invalidateThumbs } from './thumbs';
import { assetMeta } from './params';

const DB_NAME = 'perseverance-assets';
const STORE = 'assets';
/** Longest side kept for imported images (keeps the library light). */
export const MAX_SIDE = 4096;

export interface UserAssetRecord {
  id: string;
  name: string;
  blob: Blob;
  width: number;
  height: number;
  created: number;
}

export interface UserAssetEntry {
  id: string;
  /** Registry id (`user:<id>`). */
  assetId: string;
  name: string;
  width: number;
  height: number;
  created: number;
}

interface UserAssetsState {
  items: UserAssetEntry[];
  loaded: boolean;
  error: string | null;
}

export const useUserAssets = create<UserAssetsState>()(() => ({ items: [], loaded: false, error: null }));

/** Decoded images by record id (for synchronous generate()). */
const images = new Map<string, HTMLCanvasElement | ImageBitmap>();

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/* ------------------------------------------------------------------ */

let dbp: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the asset library'));
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Asset library error'));
      }),
  );
}

/* ------------------------------------------------------------------ */
/* Registry bridge                                                     */
/* ------------------------------------------------------------------ */

export const userAssetId = (id: string) => `user:${id}`;

function makeDef(e: UserAssetEntry): AssetDef {
  return {
    id: e.assetId,
    name: e.name,
    category: USER_CATEGORY,
    tags: ['my assets', 'imported', 'image'],
    sizing: { width: e.width, height: e.height },
    params: [],
    defaultBlendMode: 'normal',
    defaultOpacity: 1,
    generate(_p, { width, height }) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(width));
      c.height = Math.max(1, Math.round(height));
      const img = images.get(e.id);
      const ctx = c.getContext('2d');
      if (img && ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
      }
      return c;
    },
  };
}

function register(e: UserAssetEntry) {
  assetMeta.set(e.assetId, { bg: 'checker' });
  assets.register(makeDef(e));
}

/** Longest-side clamp. Pure. */
export function clampSize(w: number, h: number, max = MAX_SIDE): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Strip the extension and tidy a file name for display. Pure. */
export function displayName(file: string): string {
  const base = file.replace(/\\/g, '/').split('/').pop() ?? file;
  const n = base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim();
  return n || 'Image';
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

let loading: Promise<void> | null = null;

/** Load the library from IndexedDB (once). Never rejects; errors land in the store. */
export function loadUserAssets(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const recs = await tx<UserAssetRecord[]>('readonly', (s) => s.getAll() as IDBRequest<UserAssetRecord[]>);
      recs.sort((a, b) => a.created - b.created);
      const items: UserAssetEntry[] = [];
      for (const r of recs) {
        try {
          images.set(r.id, await createImageBitmap(r.blob));
        } catch {
          continue; // undecodable blob: skip
        }
        const e: UserAssetEntry = { id: r.id, assetId: userAssetId(r.id), name: r.name, width: r.width, height: r.height, created: r.created };
        register(e);
        items.push(e);
      }
      useUserAssets.setState({ items, loaded: true, error: null });
    } catch (err) {
      useUserAssets.setState({ loaded: true, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return loading;
}

/** Import image blobs (files) into the library. Returns the new entries. */
export async function importImages(files: { name: string; blob: Blob }[]): Promise<UserAssetEntry[]> {
  await loadUserAssets();
  const added: UserAssetEntry[] = [];
  for (const f of files) {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(f.blob);
    } catch {
      throw new Error(`“${f.name}” is not a readable image`);
    }
    let blob = f.blob;
    let { width, height } = { width: bmp.width, height: bmp.height };
    let img: HTMLCanvasElement | ImageBitmap = bmp;
    if (Math.max(width, height) > MAX_SIDE) {
      const s = clampSize(width, height);
      const c = document.createElement('canvas');
      c.width = s.width;
      c.height = s.height;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, s.width, s.height);
      bmp.close();
      blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), 'image/png'));
      width = s.width;
      height = s.height;
      img = c;
    }
    const rec: UserAssetRecord = { id: uid('ua_'), name: displayName(f.name), blob, width, height, created: Date.now() };
    await tx('readwrite', (s) => s.put(rec));
    images.set(rec.id, img);
    const e: UserAssetEntry = { id: rec.id, assetId: userAssetId(rec.id), name: rec.name, width, height, created: rec.created };
    register(e);
    added.push(e);
  }
  if (added.length) useUserAssets.setState((st) => ({ items: [...st.items, ...added] }));
  return added;
}

export async function renameUserAsset(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const rec = await tx<UserAssetRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<UserAssetRecord | undefined>);
  if (!rec) return;
  rec.name = clean;
  await tx('readwrite', (s) => s.put(rec));
  const items = useUserAssets.getState().items.map((e) => (e.id === id ? { ...e, name: clean } : e));
  useUserAssets.setState({ items });
  const e = items.find((x) => x.id === id);
  if (e) register(e);
}

export async function deleteUserAsset(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
  const assetId = userAssetId(id);
  images.delete(id);
  assets.unregister(assetId);
  invalidateThumbs(assetId);
  useUserAssets.setState((st) => ({ items: st.items.filter((e) => e.id !== id) }));
}

/** Decoded image of a user asset (for full-quality placement). */
export function userAssetImage(id: string): HTMLCanvasElement | ImageBitmap | null {
  return images.get(id) ?? null;
}
