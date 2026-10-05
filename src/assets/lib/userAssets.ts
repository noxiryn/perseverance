/**
 * "My Assets": user-imported images stored in IndexedDB ('perseverance-assets') and exposed as
 * element assets (category 'My Assets') in the assets registry so every module can place them.
 *
 * Memory: at startup only a small preview of each image is decoded (thumbnails and previews
 * draw from it). The full-resolution image is decoded on demand — when a card is hovered or
 * selected, or right before placing (`prepareAsset`) — and kept in a small LRU.
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
/** Longest side of the always-resident preview (covers 128–200px cards and the 416px live preview). */
export const PREVIEW_SIDE = 432;
/** Vector images (SVG) are rasterized with this longest side when imported. */
export const SVG_SIDE = 2048;
/** Full-resolution images kept decoded at once. */
const MAX_FULL = 4;

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

type Img = HTMLCanvasElement | ImageBitmap;

/** Stored blobs by record id (IndexedDB blobs are disk-backed, cheap to hold). */
const blobs = new Map<string, Blob>();
/** Small resident previews by record id. */
const previews = new Map<string, Img>();
/** Full-resolution decodes, least recently used first. */
const full = new Map<string, Img>();
const decoding = new Map<string, Promise<void>>();

function release(img: Img) {
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close();
}

function touchFull(id: string, img: Img) {
  full.delete(id);
  full.set(id, img);
  while (full.size > MAX_FULL) {
    const [oldId, old] = full.entries().next().value as [string, Img];
    full.delete(oldId);
    release(old);
  }
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

/** Longest-side clamp. Pure. */
export function clampSize(w: number, h: number, max = MAX_SIDE): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Size an image of w×h is rasterized at: bitmaps are clamped, vectors scaled to `vector`. Pure. */
export function importSize(w: number, h: number, isVector: boolean, vector = SVG_SIDE): { width: number; height: number } {
  if (!isVector) return clampSize(w, h);
  const s = vector / Math.max(w, h, 1);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

export function isSvg(name: string, blob: Blob): boolean {
  return blob.type === 'image/svg+xml' || /\.svgz?$/i.test(name);
}

/** Decode through an <img> element (handles SVG, which createImageBitmap can't decode from a blob). */
async function decodeViaImg(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // the decoded image stays usable for drawing after the URL is revoked
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return [c, ctx];
}

function encodePng(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), 'image/png'));
}

/** Downscaled copy (≤ PREVIEW_SIDE) of a decoded image. */
function makePreview(img: CanvasImageSource, w: number, h: number): Img {
  const s = clampSize(w, h, PREVIEW_SIDE);
  const [c, ctx] = canvasOf(s.width, s.height);
  ctx.drawImage(img, 0, 0, s.width, s.height);
  return c;
}

/** Preview straight from the stored blob (the decoder resizes; the full image is never kept). */
async function decodePreview(blob: Blob, w: number, h: number): Promise<Img> {
  const s = clampSize(w, h, PREVIEW_SIDE);
  try {
    return await createImageBitmap(blob, { resizeWidth: s.width, resizeHeight: s.height, resizeQuality: 'high' });
  } catch {
    const img = await decodeViaImg(blob);
    return makePreview(img, s.width, s.height);
  }
}

/** Decode a user image at full resolution into the LRU (once; concurrent calls share). Never rejects. */
export function ensureFullImage(id: string): Promise<void> {
  if (full.has(id)) {
    touchFull(id, full.get(id)!);
    return Promise.resolve();
  }
  const pending = decoding.get(id);
  if (pending) return pending;
  const blob = blobs.get(id);
  if (!blob) return Promise.resolve();
  const p = (async () => {
    try {
      let img: Img;
      try {
        img = await createImageBitmap(blob);
      } catch {
        const el = await decodeViaImg(blob);
        const [c, ctx] = canvasOf(el.naturalWidth || 1, el.naturalHeight || 1);
        ctx.drawImage(el, 0, 0);
        img = c;
      }
      if (blobs.has(id)) touchFull(id, img);
      else release(img); // deleted while decoding
    } catch (err) {
      console.warn('[assets] could not decode a My Assets image', err);
    } finally {
      decoding.delete(id);
    }
  })();
  decoding.set(id, p);
  return p;
}

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
      const [c, ctx] = canvasOf(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
      const big = full.get(e.id);
      const small = previews.get(e.id);
      // the preview is enough for thumbnails; larger renders use (or start decoding) the full image
      const fitsPreview = !!small && Math.max(c.width / small.width, c.height / small.height) <= 1.05;
      let src: Img | undefined;
      if (big && !fitsPreview) {
        touchFull(e.id, big);
        src = big;
      } else {
        src = small ?? big;
        if (!fitsPreview && !big) void ensureFullImage(e.id);
      }
      if (src) ctx.drawImage(src, 0, 0, c.width, c.height);
      return c;
    },
  };
}

function register(e: UserAssetEntry) {
  assetMeta.set(e.assetId, { bg: 'checker', isReady: () => full.has(e.id), prepare: () => ensureFullImage(e.id) });
  assets.register(makeDef(e));
}

/** Summary toast for an import batch (successes and per-file failures). Pure. */
export function importSummary(added: string[], failed: string[]): { message: string; kind: 'success' | 'warning' | 'error' } {
  const quote = (n: string) => `“${n}”`;
  const ok = added.length === 1 ? `Added ${quote(added[0])} to My Assets` : `Added ${added.length} images to My Assets`;
  if (!failed.length) return { message: ok, kind: 'success' };
  const list = failed.length <= 2 ? failed.map(quote).join(' and ') : `${failed.length} files`;
  const bad = `${list} could not be read as ${failed.length === 1 ? 'an image' : 'images'}`;
  return added.length ? { message: `${ok}. ${bad}.`, kind: 'warning' } : { message: `${bad}.`, kind: 'error' };
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
          previews.set(r.id, await decodePreview(r.blob, r.width, r.height));
        } catch {
          continue; // undecodable blob: skip
        }
        blobs.set(r.id, r.blob);
        const e: UserAssetEntry = { id: r.id, assetId: userAssetId(r.id), name: r.name, width: r.width, height: r.height, created: r.created };
        register(e);
        items.push(e);
      }
      // keep anything imported while the library was loading
      useUserAssets.setState((st) => ({ items: [...items, ...st.items.filter((x) => !items.some((y) => y.id === x.id))], loaded: true, error: null }));
    } catch (err) {
      useUserAssets.setState({ loaded: true, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return loading;
}

export interface ImportResult {
  added: UserAssetEntry[];
  failed: { name: string; reason: string }[];
}

/** Decode one file into a storable record + its full image. Throws a readable message. */
async function prepareImport(name: string, blob: Blob): Promise<{ rec: UserAssetRecord; img: Img }> {
  const vector = isSvg(name, blob);
  let src: ImageBitmap | HTMLImageElement;
  let w: number;
  let h: number;
  try {
    if (vector) throw new Error('vector');
    src = await createImageBitmap(blob);
    w = src.width;
    h = src.height;
  } catch {
    try {
      src = await decodeViaImg(blob);
    } catch {
      throw new Error('not a readable image');
    }
    // SVGs without an intrinsic size report 0 (or 300×150): fall back to a square canvas
    w = src.naturalWidth || 1024;
    h = src.naturalHeight || 1024;
  }
  const size = importSize(w, h, vector);
  let img: Img;
  let stored = blob;
  if (src instanceof ImageBitmap && size.width === w && size.height === h) img = src;
  else {
    const [c, ctx] = canvasOf(size.width, size.height);
    ctx.drawImage(src, 0, 0, size.width, size.height);
    if (src instanceof ImageBitmap) src.close();
    stored = await encodePng(c);
    img = c;
  }
  return { rec: { id: uid('ua_'), name: displayName(name), blob: stored, width: size.width, height: size.height, created: Date.now() }, img };
}

/**
 * Import image blobs (files) into the library. Each file succeeds or fails on its own; the
 * store is updated with everything that was added even when some files failed.
 */
export async function importImages(files: { name: string; blob: Blob }[]): Promise<ImportResult> {
  await loadUserAssets();
  const added: UserAssetEntry[] = [];
  const failed: ImportResult['failed'] = [];
  try {
    for (const f of files) {
      try {
        const { rec, img } = await prepareImport(f.name, f.blob);
        await tx('readwrite', (s) => s.put(rec));
        blobs.set(rec.id, rec.blob);
        previews.set(rec.id, makePreview(img, rec.width, rec.height));
        touchFull(rec.id, img);
        const e: UserAssetEntry = { id: rec.id, assetId: userAssetId(rec.id), name: rec.name, width: rec.width, height: rec.height, created: rec.created };
        register(e);
        added.push(e);
      } catch (err) {
        failed.push({ name: f.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    if (added.length) useUserAssets.setState((st) => ({ items: [...st.items, ...added] }));
  }
  return { added, failed };
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
  blobs.delete(id);
  const f = full.get(id);
  if (f) release(f);
  full.delete(id);
  const pv = previews.get(id);
  if (pv) release(pv);
  previews.delete(id);
  assets.unregister(assetId);
  assetMeta.delete(assetId);
  invalidateThumbs(assetId);
  useUserAssets.setState((st) => ({ items: st.items.filter((e) => e.id !== id) }));
}
