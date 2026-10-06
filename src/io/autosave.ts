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
 *
 * An entry older than the last save of its project file (the user kept it with "Later", then reopened,
 * edited and saved the project) is never bound to that file again: a save marks the earlier launches'
 * entries for that file (`noteProjectSaved` → `supersededAt`, in IndexedDB with strict durability, so
 * a crash right after the save keeps the mark); such an entry is offered unticked, labelled as older
 * than the saved version, and recovers as a separate unsaved copy (`savedAfter`), so a later Save
 * can't replace the newer file with it.
 *
 * Storage: the full entries (with their .pgfx data) live in the 'docs' store, and their info without
 * the data in 'meta' — written and deleted in the same transaction. The start-up list reads only
 * 'meta'; an entry's data is read when it is recovered.
 */
import type { DocSession, Document, ID } from '../core/types';
import { uid } from '../core/ids';
import { renderThumbnail } from '../render/compositor';
import { desktop, isDesktop, samePath } from '../platform';
import { savedIndexOf, useEditor, type SavedState } from '../state/editor';
import { openDialog, toast } from '../state/ui';
import { encodeProject, decodeProjectWithFonts } from './project';
import { reportProjectFonts } from './projectFonts';
import { currentEntryId, idle, markDirty, readJSON, readPref, writeJSON } from './util';

const DB_NAME = 'perseverance-recovery';
/** 1: 'docs' only. 2: + 'meta' (the entries without their data). */
const DB_VERSION = 2;
const STORE = 'docs';
const META = 'meta';

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
  /**
   * When the project file was saved after this entry was written (by a later launch): the entry holds
   * an older state than the file. Kept on the info row ('meta') only.
   */
  supersededAt?: number;
}

/** What the recovery list shows: an entry without its .pgfx data (`bytes` = its size). */
export type RecoveryInfo = Omit<RecoveryEntry, 'data'> & { bytes: number };

/** What identifies an entry and its document (a full entry or its info). */
export type RecoveryRef = Pick<RecoveryEntry, 'id' | 'docId' | 'launchId' | 'name' | 'time' | 'filePath' | 'supersededAt'>;

/** The info of an entry (everything but its data). */
export function recoveryInfo(e: RecoveryEntry): RecoveryInfo {
  const { data, ...rest } = e;
  return { ...rest, bytes: data.byteLength };
}

/** This launch (page load). A renderer reload is a new launch: the previous page's entries are offered. */
const LAUNCH_ID = uid('run_');

/** Storage key of this launch's entry for a document. */
export function recoveryKey(docId: ID): string {
  return `${LAUNCH_ID}:${docId}`;
}

/** The id of the document an entry holds. */
export function entryDocId(e: RecoveryRef): ID {
  return e.docId ?? e.id;
}

/** True for entries written by this launch (they describe documents open right now). */
export function isOwnEntry(e: RecoveryRef): boolean {
  return e.launchId === LAUNCH_ID;
}

/* ---------------- project saves (stale entries) ---------------- */

/**
 * A project file was written (Save / Save As): mark the entries earlier launches left for that file,
 * written before `time`, as older than the file (`supersededAt`). Only saves count — opening a project
 * (Open Recent's `time`) doesn't make a crash entry older than the file. Never throws.
 */
export async function noteProjectSaved(path: string, time = Date.now()): Promise<void> {
  if (!path) return;
  try {
    await store.supersede((e) => !isOwnEntry(e) && typeof e.filePath === 'string' && samePath(e.filePath, path) && e.time < time, time);
  } catch (err) {
    console.warn('[io] could not mark autosaved copies older than the saved project', err);
  }
}

/**
 * When the entry's project file was saved after the entry was written (null when it wasn't, the entry
 * has no file, or it is this launch's own). Such an entry recovers as a separate unsaved copy.
 */
export function savedAfter(e: RecoveryRef): number | null {
  if (isOwnEntry(e) || typeof e.filePath !== 'string' || !e.filePath) return null;
  const t = e.supersededAt;
  return typeof t === 'number' && Number.isFinite(t) && t > e.time ? t : null;
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
  /** Every entry's info — never the .pgfx data (the start-up list must stay cheap). */
  list(): Promise<RecoveryInfo[]>;
  /** One entry with its data (undefined when it is gone). */
  get(key: string): Promise<RecoveryEntry | undefined>;
  /** Write an entry: its data and its info together. */
  put(e: RecoveryEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /** Set `supersededAt = time` on the info of every entry `match` accepts (a project file was saved). */
  supersede(match: (e: RecoveryInfo) => boolean, time: number): Promise<void>;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const t = req.transaction!;
      const docs = db.objectStoreNames.contains(STORE) ? t.objectStore(STORE) : db.createObjectStore(STORE, { keyPath: 'id' });
      if (db.objectStoreNames.contains(META)) return;
      const meta = db.createObjectStore(META, { keyPath: 'id' });
      // Entries written before the info store existed: index them once (same upgrade transaction).
      const cursor = docs.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        const e = c.value as RecoveryEntry;
        if (e && typeof e.id === 'string' && e.data instanceof ArrayBuffer) meta.put(recoveryInfo(e));
        c.continue();
      };
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version in another tab must not wait for this one.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

/**
 * Resolves once the transaction has COMMITTED, not when its request succeeded: a write is only safe
 * then. The window may close right after (a forced quit waits for flushRecovery, then closes), and a
 * transaction still open at that moment is lost. Writes ask for strict durability (flushed to disk, not
 * left in OS buffers), so a power cut or Windows ending the session can't lose an entry reported stored.
 */
function tx<T>(mode: IDBTransactionMode, fn: (t: IDBTransaction) => () => T): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        // Both stores in every transaction: an entry's data and info change together, and read-write
        // transactions with overlapping scopes run in the order they are created.
        const t = mode === 'readwrite' ? db.transaction([STORE, META], mode, { durability: 'strict' }) : db.transaction([STORE, META], mode);
        const result = fn(t);
        const fail = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
        t.oncomplete = () => resolve(result());
        t.onerror = fail;
        t.onabort = fail;
      }),
  );
}

// Read-write transactions on the stores run in the order they are created, so a delete issued after a
// put always wins (see discardRecoveryFor).
const idbStore: RecoveryStore = {
  list: () =>
    tx('readonly', (t) => {
      const r = t.objectStore(META).getAll();
      return () => r.result as RecoveryInfo[];
    }),
  get: (key) =>
    tx('readonly', (t) => {
      const r = t.objectStore(STORE).get(key);
      return () => r.result as RecoveryEntry | undefined;
    }),
  put: (e) =>
    tx('readwrite', (t) => {
      t.objectStore(STORE).put(e);
      t.objectStore(META).put(recoveryInfo(e));
      return () => undefined;
    }),
  delete: (key) =>
    tx('readwrite', (t) => {
      t.objectStore(STORE).delete(key);
      t.objectStore(META).delete(key);
      return () => undefined;
    }),
  supersede: (match, time) =>
    tx('readwrite', (t) => {
      const cursor = t.objectStore(META).openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        const info = c.value as RecoveryInfo;
        if (info && match(info) && !((info.supersededAt ?? -Infinity) >= time)) c.update({ ...info, supersededAt: time });
        c.continue();
      };
      return () => undefined;
    }),
};

let store: RecoveryStore = idbStore;

/** In-memory entry storage over `m` (unit tests; jsdom has no IndexedDB). `list` returns infos only, like IndexedDB's 'meta'. */
export function memoryRecoveryStore(m = new Map<string, RecoveryEntry>()): RecoveryStore {
  return {
    list: async () => [...m.values()].map(recoveryInfo),
    get: async (k) => m.get(k),
    put: async (e) => void m.set(e.id, e),
    delete: async (k) => void m.delete(k),
    supersede: async (match, time) => {
      for (const [k, e] of m) if (match(recoveryInfo(e)) && !((e.supersededAt ?? -Infinity) >= time)) m.set(k, { ...e, supersededAt: time });
    },
  };
}

/** Replace the entry storage (unit tests); null restores IndexedDB. */
export function setRecoveryStore(s: RecoveryStore | null) {
  store = s ?? idbStore;
}

/** Every stored entry's info (all launches), newest first. Reads no .pgfx data. */
export async function listRecovery(): Promise<RecoveryInfo[]> {
  try {
    const all = await store.list();
    return all.filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.time)).sort((a, b) => b.time - a.time);
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
/** The autosave run in progress, and the forced run queued behind it (one serves every caller). */
let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;
/** > 0 while a forced quit waits for the copies (flushRecovery): don't wait for idle time. */
let urgency = 0;

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

/** Write one document's recovery entry if it is due (`force`: now). */
async function autosaveDoc(id: ID, now: number, minutes: number, force: boolean) {
  const s = useEditor.getState().sessions[id];
  if (!s) return;
  if (!lastRun.has(id)) lastRun.set(id, now);
  if (!s.dirty) return;
  if (alreadyWritten(id, s) || isDiscardedState(id, s)) return;
  if (!force && now - (lastRun.get(id) ?? now) < minutes * 60000) return;
  if (!urgency) await idle(1000);
  // Re-read after yielding and snapshot synchronously: the recovery entry, its thumbnail and
  // its pixels all describe the same (committed) history step.
  const live = useEditor.getState().sessions[id];
  if (!live || !live.dirty || alreadyWritten(id, live) || isDiscardedState(id, live)) return;
  const snapAt = Date.now();
  const doc = live.history.entries[live.history.index]?.doc ?? live.doc;
  const written: SavedState = { entryId: currentEntryId(live), doc };
  const thumb = thumbnailOf(doc);
  const data = await encodeProject(doc, { background: true });
  // The document may have been saved or closed while encoding, or the user discarded its changes.
  const cur = useEditor.getState().sessions[id];
  if (!cur || !cur.dirty) return;
  if ((discarded.get(id)?.time ?? -Infinity) >= snapAt) return;
  // No await between the checks above and the put: a discard issued later deletes after it.
  await putRecovery({
    id: recoveryKey(id),
    docId: id,
    launchId: LAUNCH_ID,
    name: doc.name,
    // When the state was taken (not when the write ended): compared with project save times.
    time: snapAt,
    width: doc.width,
    height: doc.height,
    data,
    thumb,
    filePath: live.filePath,
  });
  lastRun.set(id, Date.now());
  lastEntry.set(id, written);
}

async function runTick(force: boolean) {
  const minutes = autosaveMinutes();
  if (!minutes && !force) return;
  const now = Date.now();
  for (const id of useEditor.getState().docOrder) {
    // One document that can't be written (e.g. storage full) doesn't keep the others from being kept.
    try {
      await autosaveDoc(id, now, minutes, force);
    } catch (e) {
      console.warn('[io] autosave failed', e);
    }
  }
}

/**
 * One autosave run at a time. A forced run asked for while one is in progress runs again right after
 * it — that one may have passed a document before its latest edit — so the caller gets the state as it
 * is now; every forced request made meanwhile shares that one queued run.
 */
function autosaveTick(force = false): Promise<void> {
  if (running) {
    if (!force) return running;
    return (queued ??= running.then(() => {
      queued = null;
      return autosaveTick(true);
    }));
  }
  const run: Promise<void> = runTick(force).finally(() => {
    if (running === run) running = null;
  });
  running = run;
  return run;
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

/** Dirty documents whose current state is in no recovery entry of this launch (and wasn't discarded). */
export function unprotectedCount(): number {
  const st = useEditor.getState();
  return Object.values(st.sessions).filter((s) => s.dirty && !alreadyWritten(s.doc.id, s) && !isDiscardedState(s.doc.id, s)).length;
}

/**
 * The window is about to close without the user's answer ("Quit Anyway" in a native prompt: the
 * in-app prompt is stuck, or the UI broke): write the recovery entries of all dirty documents now,
 * without waiting for idle time, and resolve once they are stored (also when an autosave was already
 * running). Resolves the number of dirty documents still without an up-to-date copy (0 = all kept).
 * Respects 'autosaveMinutes' = 0 (autosave off: nothing is written).
 */
export async function flushRecovery(): Promise<number> {
  if (autosaveMinutes() > 0 && unprotectedCount() > 0) {
    urgency++;
    try {
      await autosaveTick(true);
    } finally {
      urgency--;
    }
  }
  return unprotectedCount();
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
export function recoveryTarget(e: RecoveryRef, sessions: Record<ID, DocSession> = useEditor.getState().sessions): DocSession | null {
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
    await putRecovery({ ...e, id: recoveryKey(docId), docId, launchId: LAUNCH_ID, name: s.doc.name, filePath: s.filePath ?? null, supersededAt: undefined });
  } catch (err) {
    console.warn('[io] could not keep the recovered document for recovery', err);
    return false;
  }
  lastEntry.set(docId, { entryId: currentEntryId(s), doc: s.history.entries[s.history.index]?.doc ?? s.doc });
  lastRun.set(docId, Date.now());
  return true;
}

/** "Oct 6" — part of a separate copy's name (no characters a file name can't hold). */
function shortDate(t: number): string {
  try {
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return new Date(t).toDateString();
  }
}

export async function recoverEntries(entries: RecoveryRef[]) {
  let ok = 0;
  const applied: string[] = [];
  const copies: string[] = [];
  // Oldest first: when two entries belong to the same open project, the newest ends up on top.
  for (const ref of [...entries].sort((a, b) => a.time - b.time)) {
    try {
      // The list holds only the entries' info: read this one's data now.
      const e = await store.get(ref.id);
      if (!e || !(e.data instanceof ArrayBuffer)) throw new Error('the autosaved copy is no longer there');
      const decoded = await decodeProjectWithFonts(e.data);
      const embeddedFonts = decoded.embeddedFonts;
      let doc = decoded.doc;
      // Older than the last save of its file: never bound to that file (a Save would replace the newer
      // version), never applied to the open copy — a separate unsaved document instead. (The mark lives
      // on the info row the list gave us.)
      const older = savedAfter(ref) !== null || savedAfter(e) !== null;
      const target = older ? null : recoveryTarget(e);
      let docId: ID;
      if (target) {
        applyToOpen(target, doc);
        docId = target.doc.id;
        applied.push(target.doc.name);
      } else {
        if (older) {
          doc = { ...doc, name: `${doc.name} (autosaved ${shortDate(e.time)})` };
          copies.push(doc.name);
        }
        // decodeProject gave the document a fresh id if one with its id is open.
        useEditor.getState().openDocument(doc, { label: 'Recovered', filePath: !older && typeof e.filePath === 'string' ? e.filePath : null });
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
      toast(`Could not recover “${ref.name}”: ${(err as Error).message}`, 'error', 5000);
    }
  }
  if (!ok) return;
  const parts: string[] = [];
  if (applied.length)
    parts.push(`Recovered the autosaved changes to ${applied.map((n) => `“${n}”`).join(', ')} — Edit ▸ Undo goes back to the version you had open. Save to keep them.`);
  if (copies.length)
    parts.push(
      `Opened ${copies.map((n) => `“${n}”`).join(', ')} as ${copies.length > 1 ? 'separate unsaved copies' : 'a separate unsaved copy'} — the project was saved after that autosave, so its file is left as it is.`,
    );
  if (parts.length) toast(parts.join(' '), 'success', copies.length ? 7000 : 6000);
  else toast(`Recovered ${ok} document${ok > 1 ? 's' : ''} — save to keep your changes`, 'success', 4200);
}

/** Delete entries the user chose to discard in the recovery dialog. */
export async function discardEntries(entries: RecoveryRef[]) {
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

/**
 * Entries earlier launches left behind (minus those the browser marked as left without saving). The
 * desktop app ignores a marker an older version may have left: that one was also written by forced
 * quits ("Quit Anyway", Windows shutting down), so it can't tell a real Discard apart.
 */
export async function pendingRecovery(): Promise<RecoveryInfo[]> {
  const marker = isDesktop ? [] : readJSON<unknown>(CLOSED_KEY, []);
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
  running = null;
  queued = null;
  urgency = 0;
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
  // Desktop: the main process asks for the copies right before a forced quit ("Quit Anyway").
  desktop?.onFlushRecovery?.(() => {
    if (autosaveMinutes() > 0 && unprotectedCount() > 0) toast('Keeping an autosaved copy of your unsaved changes…', 'info', 4000);
    return flushRecovery();
  });
  if (!isDesktop) window.addEventListener('pagehide', markClosedWithoutSaving);
  window.setTimeout(() => void offerRecovery(), 1200);
}
