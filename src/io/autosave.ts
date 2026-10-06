/**
 * Autosave & crash recovery. Dirty documents are packed (as .pgfx containers) every N minutes
 * (pref 'autosaveMinutes', default 2, 0 = off) into IndexedDB 'perseverance-recovery'.
 *
 * Entries are keyed per app launch (page load): `<launchId>:<docId>`. A document keeps its id across
 * save and open, so keying entries by document id let a project reopened after a crash (Explorer
 * double-click, Open Recent) hide its own crash entry, overwrite it with the next autosave, or delete
 * it on Save / Close. Now a launch only ever writes and removes its OWN entries (removed when the
 * document is saved, closed, or the user discards its changes); entries of earlier launches — a
 * crash, a forced quit ("Quit Anyway"), Windows shutting down, a renderer reload — are offered on the
 * next start, also when the same project is already open, and stay until the user recovers or
 * discards them ("Later" keeps them for the next start).
 */
import type { DocSession, Document, ID } from '../core/types';
import { uid } from '../core/ids';
import { renderThumbnail } from '../render/compositor';
import { isDesktop, samePath } from '../platform';
import { savedIndexOf, useEditor, type SavedState } from '../state/editor';
import { openDialog, toast } from '../state/ui';
import { encodeProject, decodeProjectWithFonts } from './project';
import { reportProjectFonts } from './projectFonts';
import { currentEntryId, idle, markDirty, readJSON, readPref, writeJSON } from './util';

const DB_NAME = 'perseverance-recovery';
const STORE = 'docs';

export interface RecoveryEntry {
  /** Storage key: `<launchId>:<docId>` (entries written by older versions: the document id). */
  id: string;
  /** Id of the document in the entry (older entries: same as `id`). */
  docId?: ID;
  /** The app launch (page load) that wrote the entry (older entries: none — an earlier launch). */
  launchId?: string;
  name: string;
  time: number;
  width: number;
  height: number;
  data: ArrayBuffer;
  /** Small JPEG data URL of the composite (for the recovery dialog). */
  thumb?: string;
  /** Project path on disk (desktop), so a recovered document saves back to its file. */
  filePath?: string | null;
}

/** This launch (page load). A renderer reload is a new launch: the previous page's entries are offered. */
const LAUNCH_ID = uid('run_');

/** Storage key of this launch's entry for a document. */
export function recoveryKey(docId: ID): string {
  return `${LAUNCH_ID}:${docId}`;
}

/** The id of the document an entry holds. */
export function entryDocId(e: RecoveryEntry): ID {
  return e.docId ?? e.id;
}

/** True for entries written by this launch (they describe documents open right now). */
export function isOwnEntry(e: RecoveryEntry): boolean {
  return e.launchId === LAUNCH_ID;
}

/** Small composite preview for the recovery list (never throws). */
function thumbnailOf(doc: Document): string | undefined {
  try {
    const t = renderThumbnail(doc, null, 112);
    const c = document.createElement('canvas');
    c.width = t.width;
    c.height = t.height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(t, 0, 0);
    return c.toDataURL('image/jpeg', 0.8);
  } catch {
    return undefined;
  }
}

/* ---------------- storage ---------------- */

/** Where entries live: IndexedDB in the app, an in-memory stand-in in unit tests. */
export interface RecoveryStore {
  getAll(): Promise<RecoveryEntry[]>;
  put(e: RecoveryEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

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

// Read-write transactions on the store run in the order they are created, so a delete issued after a
// put always wins (see discardRecoveryFor).
const idbStore: RecoveryStore = {
  getAll: () => tx<RecoveryEntry[]>('readonly', (s) => s.getAll() as IDBRequest<RecoveryEntry[]>),
  put: (e) => tx('readwrite', (s) => s.put(e)).then(() => undefined),
  delete: (key) => tx('readwrite', (s) => s.delete(key)).then(() => undefined),
};

let store: RecoveryStore = idbStore;

/** Replace the entry storage (unit tests); null restores IndexedDB. */
export function setRecoveryStore(s: RecoveryStore | null) {
  store = s ?? idbStore;
}

/** Every stored entry (all launches), newest first. */
export async function listRecovery(): Promise<RecoveryEntry[]> {
  try {
    const all = await store.getAll();
    return all.filter((e) => e && typeof e.id === 'string' && e.data instanceof ArrayBuffer).sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

async function putRecovery(e: RecoveryEntry) {
  await store.put(e);
  stored.add(entryDocId(e));
}

async function deleteEntry(key: string) {
  try {
    await store.delete(key);
  } catch {
    /* ignore */
  }
}

/**
 * Remove THIS launch's entry for a document (it was saved or closed). Entries an earlier launch left
 * for the same document (a crash before it was reopened) are never touched here.
 */
export async function removeRecovery(docId: ID): Promise<void> {
  stored.delete(docId);
  lastRun.delete(docId);
  lastEntry.delete(docId);
  await deleteEntry(recoveryKey(docId));
}

/* ---------------- autosave loop ---------------- */

/** Doc ids with an entry of this launch in storage. */
const stored = new Set<ID>();
const lastRun = new Map<ID, number>();
/** The state last written per document: step id + document (a coalesced edit keeps the id). */
const lastEntry = new Map<ID, SavedState>();
/** Documents whose changes the user discarded (quit → Discard): their state then, and when. */
const discarded = new Map<ID, { at: SavedState; time: number }>();
let running = false;

/** True when the session's current step is exactly `at`. */
function isAt(s: DocSession, at: SavedState | undefined): boolean {
  return !!at && savedIndexOf(s.history.entries, at) === s.history.index;
}

/** True when the session's current step is exactly the state last written to its recovery entry. */
function alreadyWritten(id: ID, s: DocSession): boolean {
  return isAt(s, lastEntry.get(id));
}

/** The user threw this exact state away (a later edit — the window stayed open — is autosaved again). */
function isDiscardedState(id: ID, s: DocSession): boolean {
  return isAt(s, discarded.get(id)?.at);
}

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
      if (alreadyWritten(id, s) || isDiscardedState(id, s)) continue;
      if (!force && now - (lastRun.get(id) ?? now) < minutes * 60000) continue;
      await idle(1000);
      // Re-read after yielding and snapshot synchronously: the recovery entry, its thumbnail and
      // its pixels all describe the same (committed) history step.
      const live = useEditor.getState().sessions[id];
      if (!live || !live.dirty || alreadyWritten(id, live) || isDiscardedState(id, live)) continue;
      const snapAt = Date.now();
      const doc = live.history.entries[live.history.index]?.doc ?? live.doc;
      const written: SavedState = { entryId: currentEntryId(live), doc };
      const thumb = thumbnailOf(doc);
      const data = await encodeProject(doc, { background: true });
      // The document may have been saved or closed while encoding, or the user discarded its changes.
      const cur = useEditor.getState().sessions[id];
      if (!cur || !cur.dirty) continue;
      if ((discarded.get(id)?.time ?? -Infinity) >= snapAt) continue;
      // No await between the checks above and the put: a discard issued later deletes after it.
      await putRecovery({
        id: recoveryKey(id),
        docId: id,
        launchId: LAUNCH_ID,
        name: doc.name,
        time: Date.now(),
        width: doc.width,
        height: doc.height,
        data,
        thumb,
        filePath: live.filePath,
      });
      lastRun.set(id, Date.now());
      lastEntry.set(id, written);
    }
  } catch (e) {
    console.warn('[io] autosave failed', e);
  } finally {
    running = false;
  }
}

/** Write recovery data for all dirty documents now (used before risky operations / tests). */
export function autosaveNow() {
  return autosaveTick(true);
}

/**
 * A close / quit was requested: bring the recovery entries of dirty documents up to date in the
 * background while the unsaved-changes prompt is open, so a forced quit ("Quit Anyway") keeps the
 * latest state. Respects 'autosaveMinutes' = 0 (autosave off).
 */
export function autosaveBeforeClose() {
  if (autosaveMinutes() > 0) void autosaveTick(true);
}

/**
 * The user chose to throw away the unsaved changes of these documents (quit → Discard): delete their
 * recovery entries now — before the window closes — and never write the discarded state again (an
 * autosave encoding meanwhile skips its write; one already writing is deleted after it). Any other way
 * out (a forced quit, a crash, Windows shutting down) keeps the entries for recovery on the next start.
 */
export async function discardRecoveryFor(ids: ID[]): Promise<void> {
  const st = useEditor.getState();
  const time = Date.now();
  for (const id of ids) {
    const s = st.sessions[id];
    if (s) discarded.set(id, { at: { entryId: currentEntryId(s), doc: s.history.entries[s.history.index]?.doc ?? s.doc }, time });
  }
  await Promise.all(ids.map((id) => removeRecovery(id)));
}

/* ---------------- recovery ---------------- */

/**
 * The open document a recovery entry belongs to: the session showing the same project file, or (no
 * file) the same unsaved document. Recovering into it adds the autosaved state as an undoable step
 * instead of a second tab on the same file (whose Save would overwrite the other copy).
 */
export function recoveryTarget(e: RecoveryEntry, sessions: Record<ID, DocSession> = useEditor.getState().sessions): DocSession | null {
  const list = Object.values(sessions);
  if (typeof e.filePath === 'string' && e.filePath) return list.find((s) => samePath(s.filePath, e.filePath)) ?? null;
  const docId = entryDocId(e);
  return list.find((s) => s.doc.id === docId && !s.filePath) ?? null;
}

/** Replace an open document's content with the recovered state, as one undoable step. */
function applyToOpen(target: DocSession, recovered: Document) {
  const st = useEditor.getState();
  st.setActiveDoc(target.doc.id);
  const doc: Document = { ...recovered, id: target.doc.id };
  st.commit('Recover Autosaved Changes', () => doc);
}

/**
 * Keep a recovered document safe at once: copy the entry under this launch's key (it describes the
 * recovered state exactly), so a crash before the next autosave still finds it.
 */
async function keepAsOwn(docId: ID, e: RecoveryEntry): Promise<boolean> {
  const s = useEditor.getState().sessions[docId];
  if (!s) return false;
  try {
    await putRecovery({ ...e, id: recoveryKey(docId), docId, launchId: LAUNCH_ID, filePath: s.filePath });
  } catch (err) {
    console.warn('[io] could not keep the recovered document for recovery', err);
    return false;
  }
  lastEntry.set(docId, { entryId: currentEntryId(s), doc: s.history.entries[s.history.index]?.doc ?? s.doc });
  lastRun.set(docId, Date.now());
  return true;
}

export async function recoverEntries(entries: RecoveryEntry[]) {
  let ok = 0;
  const applied: string[] = [];
  // Oldest first: when two entries belong to the same open project, the newest ends up on top.
  for (const e of [...entries].sort((a, b) => a.time - b.time)) {
    try {
      const { doc, embeddedFonts } = await decodeProjectWithFonts(e.data);
      const target = recoveryTarget(e);
      let docId: ID;
      if (target) {
        applyToOpen(target, doc);
        docId = target.doc.id;
        applied.push(target.doc.name);
      } else {
        // decodeProject gave the document a fresh id if one with its id is open.
        useEditor.getState().openDocument(doc, { label: 'Recovered', filePath: typeof e.filePath === 'string' ? e.filePath : null });
        markDirty(doc.id);
        docId = doc.id;
      }
      // The old entry goes only once the recovered state is stored under this launch's key.
      if ((await keepAsOwn(docId, e)) && e.id !== recoveryKey(docId)) await deleteEntry(e.id);
      const opened = useEditor.getState().sessions[docId]?.doc ?? doc;
      // Fonts the entry carries are registered again; families still missing get the usual warning.
      void reportProjectFonts(opened, embeddedFonts).catch(() => undefined);
      ok++;
    } catch (err) {
      console.error('[io] recovery failed', err);
      toast(`Could not recover “${e.name}”: ${(err as Error).message}`, 'error', 5000);
    }
  }
  if (!ok) return;
  if (applied.length)
    toast(
      `Recovered the autosaved changes to ${applied.map((n) => `“${n}”`).join(', ')} — Edit ▸ Undo goes back to the version you had open. Save to keep them.`,
      'success',
      6000,
    );
  else toast(`Recovered ${ok} document${ok > 1 ? 's' : ''} — save to keep your changes`, 'success', 4200);
}

/** Delete entries the user chose to discard in the recovery dialog. */
export async function discardEntries(entries: RecoveryEntry[]) {
  for (const e of entries) {
    if (isOwnEntry(e)) await removeRecovery(entryDocId(e));
    else await deleteEntry(e.id);
  }
}

/**
 * Browser build only: keys of entries whose documents were still dirty when the page unloaded
 * normally — the user left through the browser's "Leave page?" prompt, i.e. chose not to save.
 * Written synchronously on 'pagehide'; a crash never gets there. The desktop app never writes it:
 * its own unsaved-changes prompt deletes the entries when the user picks Discard
 * (discardRecoveryFor), and every other way the window closes keeps them.
 */
const CLOSED_KEY = 'perseverance.recovery.closedDirty';

function markClosedWithoutSaving() {
  const st = useEditor.getState();
  const keys = Object.values(st.sessions)
    .filter((s) => s.dirty && stored.has(s.doc.id))
    .map((s) => recoveryKey(s.doc.id));
  if (!keys.length) return;
  const prev = readJSON<unknown>(CLOSED_KEY, []);
  writeJSON(CLOSED_KEY, [...new Set([...(Array.isArray(prev) ? prev : []), ...keys])]);
}

/** Entries earlier launches left behind (minus those the browser marked as left without saving). */
export async function pendingRecovery(): Promise<RecoveryEntry[]> {
  const marker = readJSON<unknown>(CLOSED_KEY, []);
  const closed = new Set(Array.isArray(marker) ? marker.filter((x): x is string => typeof x === 'string') : []);
  try {
    localStorage.removeItem(CLOSED_KEY);
  } catch {
    /* ignore */
  }
  const all = (await listRecovery()).filter((e) => !isOwnEntry(e));
  await discardEntries(all.filter((e) => closed.has(e.id)));
  return all.filter((e) => !closed.has(e.id));
}

async function offerRecovery() {
  const entries = await pendingRecovery();
  if (!entries.length) return;
  const { RecoveryDialog } = await import('./dialogs/RecoveryDialog');
  await openDialog(RecoveryDialog, { entries });
}

/* ---------------- lifecycle ---------------- */

let started = false;

/** Forget this launch's bookkeeping (unit tests). */
export function resetAutosaveState() {
  stored.clear();
  lastRun.clear();
  lastEntry.clear();
  discarded.clear();
  running = false;
}

/** Remove this launch's entries for documents that were saved (clean) or closed. */
function onSessionsChange(st: { sessions: Record<ID, DocSession> }) {
  for (const id of [...stored]) {
    const s = st.sessions[id];
    if (!s || !s.dirty) void removeRecovery(id);
  }
  for (const id of [...lastRun.keys()]) if (!st.sessions[id]) lastRun.delete(id);
  for (const id of [...discarded.keys()]) if (!st.sessions[id]) discarded.delete(id);
}

/** Track saves / closes (also used by unit tests). */
export function watchSessions(): () => void {
  return useEditor.subscribe((st, prev) => {
    if (st.sessions !== prev.sessions) onSessionsChange(st);
  });
}

export function startAutosave() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.setInterval(() => void autosaveTick(), 15000);
  watchSessions();
  if (!isDesktop) window.addEventListener('pagehide', markClosedWithoutSaving);
  window.setTimeout(() => void offerRecovery(), 1200);
}
