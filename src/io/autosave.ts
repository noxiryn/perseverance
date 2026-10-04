/**
 * Autosave & crash recovery. Dirty documents are packed (as .pgfx containers) every N minutes
 * (pref 'autosaveMinutes', default 2, 0 = off) into IndexedDB 'perseverance-recovery'. Entries are
 * removed when the document is saved or closed. On startup leftover entries are offered for recovery.
 */
import type { ID } from '../core/types';
import { useEditor } from '../state/editor';
import { openDialog, toast } from '../state/ui';
import { encodeProject, decodeProject } from './project';
import { currentEntryId, idle, markDirty, readJSON, readPref, writeJSON } from './util';

const DB_NAME = 'perseverance-recovery';
const STORE = 'docs';
const MAX_ENTRIES = 10;

export interface RecoveryEntry {
  id: ID;
  name: string;
  time: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

/* ---------------- IndexedDB ---------------- */

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export async function listRecovery(): Promise<RecoveryEntry[]> {
  try {
    const all = await tx<RecoveryEntry[]>('readonly', (s) => s.getAll() as IDBRequest<RecoveryEntry[]>);
    return all.filter((e) => e && e.data instanceof ArrayBuffer).sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

async function putRecovery(e: RecoveryEntry) {
  await tx('readwrite', (s) => s.put(e));
  stored.add(e.id);
}

export async function removeRecovery(id: ID): Promise<void> {
  stored.delete(id);
  lastRun.delete(id);
  lastEntry.delete(id);
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

/* ---------------- autosave loop ---------------- */

/** Doc ids with an entry in IndexedDB (written this session). */
const stored = new Set<ID>();
const lastRun = new Map<ID, number>();
const lastEntry = new Map<ID, string>();
let running = false;

export function autosaveMinutes(): number {
  const v = readPref<number>('autosaveMinutes', 2);
  return Number.isFinite(v) && v >= 0 ? v : 2;
}

async function autosaveTick(force = false) {
  const minutes = autosaveMinutes();
  if ((!minutes && !force) || running) return;
  running = true;
  try {
    const now = Date.now();
    const st = useEditor.getState();
    for (const id of st.docOrder) {
      const s = useEditor.getState().sessions[id];
      if (!s) continue;
      if (!lastRun.has(id)) lastRun.set(id, now);
      if (!s.dirty) continue;
      const entry = currentEntryId(s);
      if (lastEntry.get(id) === entry) continue;
      if (!force && now - (lastRun.get(id) ?? now) < minutes * 60000) continue;
      await idle(1000);
      const data = await encodeProject(s.doc, { background: true });
      // The document may have been saved or closed while encoding.
      const cur = useEditor.getState().sessions[id];
      if (!cur || !cur.dirty) continue;
      await putRecovery({ id, name: s.doc.name, time: Date.now(), width: s.doc.width, height: s.doc.height, data });
      lastRun.set(id, Date.now());
      lastEntry.set(id, entry);
    }
    await trimEntries();
  } catch (e) {
    console.warn('[io] autosave failed', e);
  } finally {
    running = false;
  }
}

async function trimEntries() {
  const all = await listRecovery();
  for (const e of all.slice(MAX_ENTRIES)) await removeRecovery(e.id);
}

/** Write recovery data for all dirty documents now (used before risky operations / tests). */
export function autosaveNow() {
  return autosaveTick(true);
}

/* ---------------- recovery ---------------- */

export async function recoverEntries(entries: RecoveryEntry[]) {
  let ok = 0;
  for (const e of entries) {
    try {
      const doc = await decodeProject(e.data);
      useEditor.getState().openDocument(doc, { label: 'Recovered' });
      markDirty(doc.id);
      // Track the entry so closing the recovered document without saving discards it.
      if (doc.id !== e.id) await removeRecovery(e.id);
      else stored.add(e.id);
      ok++;
    } catch (err) {
      console.error('[io] recovery failed', err);
      toast(`Could not recover “${e.name}”: ${(err as Error).message}`, 'error', 5000);
    }
  }
  if (ok) toast(`Recovered ${ok} document${ok > 1 ? 's' : ''} — save to keep your changes`, 'success', 4200);
}

export async function discardEntries(entries: RecoveryEntry[]) {
  for (const e of entries) await removeRecovery(e.id);
}

/**
 * Ids of documents that were still dirty when the page unloaded normally (the user quit and chose
 * not to save). Written synchronously on 'pagehide'; a crash never gets there, so whatever is left
 * in IndexedDB without this marker is a genuine crash leftover.
 */
const CLOSED_KEY = 'perseverance.recovery.closedDirty';

function markClosedWithoutSaving() {
  const st = useEditor.getState();
  const ids = Object.values(st.sessions)
    .filter((s) => s.dirty && stored.has(s.doc.id))
    .map((s) => s.doc.id);
  if (!ids.length) return;
  const prev = readJSON<unknown>(CLOSED_KEY, []);
  writeJSON(CLOSED_KEY, [...new Set([...(Array.isArray(prev) ? prev : []), ...ids])]);
}

async function offerRecovery() {
  const marker = readJSON<unknown>(CLOSED_KEY, []);
  const closed = new Set(Array.isArray(marker) ? marker.filter((x): x is string => typeof x === 'string') : []);
  try {
    localStorage.removeItem(CLOSED_KEY);
  } catch {
    /* ignore */
  }
  const all = (await listRecovery()).filter((e) => !useEditor.getState().sessions[e.id]);
  // Documents deliberately closed without saving are not offered again.
  await discardEntries(all.filter((e) => closed.has(e.id)));
  const entries = all.filter((e) => !closed.has(e.id));
  if (!entries.length) return;
  const { RecoveryDialog } = await import('./dialogs/RecoveryDialog');
  await openDialog(RecoveryDialog, { entries });
}

/* ---------------- lifecycle ---------------- */

let started = false;

export function startAutosave() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.setInterval(() => void autosaveTick(), 15000);
  // Remove entries for documents that were saved (clean) or closed.
  useEditor.subscribe((st, prev) => {
    if (st.sessions === prev.sessions) return;
    for (const id of [...stored]) {
      const s = st.sessions[id];
      if (!s || !s.dirty) void removeRecovery(id);
    }
    for (const id of [...lastRun.keys()]) if (!st.sessions[id]) lastRun.delete(id);
  });
  window.addEventListener('pagehide', markClosedWithoutSaving);
  window.setTimeout(() => void offerRecovery(), 1200);
}
