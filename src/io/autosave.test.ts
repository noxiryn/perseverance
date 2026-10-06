/**
 * Crash recovery entries are keyed per app launch (app-logic-diff-1): a project reopened after a crash
 * (same document id, e.g. Explorer double-click) must never hide, overwrite or delete the entry the
 * crashed launch left; only the user's Recover / Discard removes it. And only an explicit Discard of
 * unsaved changes deletes this launch's entries (packaged-app-5 / electron-security-2 / app-logic-diff-2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Document } from '../core/types';
import { createDocument } from '../core/document';
import { useEditor } from '../state/editor';
import { unpackContainer } from './container';
import { encodeProject } from './project';
import {
  autosaveNow,
  discardEntries,
  discardRecoveryFor,
  entryDocId,
  flushRecovery,
  isOwnEntry,
  listRecovery,
  memoryRecoveryStore,
  noteProjectSaved,
  savedAfter,
  pendingRecovery,
  recoverEntries,
  recoveryKey,
  recoveryTarget,
  removeRecovery,
  resetAutosaveState,
  setRecoveryStore,
  startAutosave,
  watchSessions,
  type RecoveryEntry,
  type RecoveryStore,
} from './autosave';

/** In-memory stand-in for the IndexedDB store (jsdom has none); counts the data reads. */
function memStore() {
  const m = new Map<string, RecoveryEntry>();
  const base = memoryRecoveryStore(m);
  const reads: string[] = [];
  const store: RecoveryStore = {
    ...base,
    get: async (k) => {
      reads.push(k);
      return base.get(k);
    },
  };
  return { m, store, reads };
}

const PATH = '/art/Poster.pgfx';

function docWithGuides(id: string, n: number, name = 'Poster'): Document {
  const d = createDocument({ name, width: 40, height: 30, background: '#ffffff' });
  d.id = id;
  for (let i = 0; i < n; i++) d.guides.push({ id: `g${i}`, orientation: 'vertical', position: 10 + i });
  return d;
}

/** An entry a previous launch (crashed) left for the project: its unsaved state had `guides` guides. */
async function crashEntry(docId: string, guides: number, filePath: string | null = PATH): Promise<RecoveryEntry> {
  const doc = docWithGuides(docId, guides);
  return { id: `run_old:${docId}`, docId, launchId: 'run_old', name: doc.name, time: Date.now() - 60000, width: doc.width, height: doc.height, data: await encodeProject(doc, { background: true }), filePath };
}

const guidesIn = (e: RecoveryEntry) => (unpackContainer(e.data).header.document as Document).guides.length;
const session = (id: string) => useEditor.getState().sessions[id];
function edit(id: string, label = 'Add Guide') {
  useEditor.getState().setActiveDoc(id);
  useEditor.getState().commit(label, (d) => {
    d.guides.push({ id: `e${d.guides.length}`, orientation: 'horizontal', position: 5 });
  });
}

let mem: ReturnType<typeof memStore>;
let unwatch: () => void = () => {};

beforeEach(() => {
  mem = memStore();
  setRecoveryStore(mem.store);
  resetAutosaveState();
  useEditor.setState({ sessions: {}, docOrder: [], activeDocId: null });
  localStorage.clear();
  unwatch = watchSessions();
});

afterEach(() => {
  unwatch();
  setRecoveryStore(null);
});

describe('recovery entries are keyed per launch', () => {
  it('autosave writes this launch’s key, never the bare document id', async () => {
    useEditor.getState().openDocument(docWithGuides('doc_a', 0), { filePath: PATH });
    edit('doc_a');
    await autosaveNow();
    const all = await listRecovery();
    expect(all.map((e) => e.id)).toEqual([recoveryKey('doc_a')]);
    expect(isOwnEntry(all[0]) && entryDocId(all[0])).toBe('doc_a');
  });

  it('a project reopened after a crash never hides, overwrites or deletes the crash entry', async () => {
    const old = await crashEntry('doc_p', 5);
    await mem.store.put(old);
    // Explorer double-click after the crash: the clean file opens with the same document id.
    useEditor.getState().openDocument(docWithGuides('doc_p', 0), { filePath: PATH });

    // Offered although a document with that id is open.
    expect((await pendingRecovery()).map((e) => e.id)).toEqual([old.id]);

    // Working on: the next autosave writes its own entry next to it.
    edit('doc_p');
    await autosaveNow();
    expect(mem.m.size).toBe(2);
    expect(guidesIn(mem.m.get(old.id)!)).toBe(5);
    expect(guidesIn(mem.m.get(recoveryKey('doc_p'))!)).toBe(1);

    // Save (the tab turns clean): only this launch's entry goes.
    useEditor.getState().markSaved('doc_p');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect([...mem.m.keys()]).toEqual([old.id]);

    // Save in place / Close call removeRecovery for the document: still only this launch's key.
    await removeRecovery('doc_p');
    useEditor.getState().closeDocument('doc_p');
    await new Promise((r) => setTimeout(r, 0));
    expect([...mem.m.keys()]).toEqual([old.id]);
    expect((await pendingRecovery()).map((e) => e.id)).toEqual([old.id]);
  });

  it('entries written by older versions (keyed by document id) are still offered', async () => {
    const legacy = { ...(await crashEntry('doc_l', 2)), id: 'doc_l', docId: undefined, launchId: undefined };
    await mem.store.put(legacy);
    useEditor.getState().openDocument(docWithGuides('doc_l', 0), { filePath: PATH });
    const pending = await pendingRecovery();
    expect(pending.map((e) => e.id)).toEqual(['doc_l']);
    expect(entryDocId(pending[0])).toBe('doc_l');
    await removeRecovery('doc_l');
    expect(mem.m.has('doc_l')).toBe(true);
  });
});

describe('recovering', () => {
  it('into the open copy of the same project: one undoable step, then kept under this launch', async () => {
    const old = await crashEntry('doc_p', 5);
    await mem.store.put(old);
    useEditor.getState().openDocument(docWithGuides('doc_p', 0), { filePath: PATH });
    expect(recoveryTarget(old)?.doc.id).toBe('doc_p');

    await recoverEntries([old]);
    const s = session('doc_p');
    expect(Object.keys(useEditor.getState().sessions)).toEqual(['doc_p']); // no second tab on the file
    expect(s.doc.guides.length).toBe(5);
    expect(s.dirty).toBe(true);
    expect(s.filePath).toBe(PATH);
    expect(s.history.entries.at(-1)?.label).toBe('Recover Autosaved Changes');
    // The recovered state is safe at once (this launch's key); the old entry is gone.
    expect([...mem.m.keys()]).toEqual([recoveryKey('doc_p')]);
    expect(guidesIn(mem.m.get(recoveryKey('doc_p'))!)).toBe(5);
    // Undo returns to the file's version.
    useEditor.getState().undo();
    expect(session('doc_p').doc.guides.length).toBe(0);
  });

  it('a project that is not open opens as a new document that saves back to its file', async () => {
    const old = await crashEntry('doc_q', 3);
    await mem.store.put(old);
    await recoverEntries([old]);
    const s = session('doc_q');
    expect(s.doc.guides.length).toBe(3);
    expect(s.dirty).toBe(true);
    expect(s.filePath).toBe(PATH);
    expect([...mem.m.keys()]).toEqual([recoveryKey('doc_q')]);
  });

  it('same id open as a different file: a separate document (fresh id), nothing replaced', async () => {
    const old = await crashEntry('doc_r', 4, '/art/A.pgfx');
    await mem.store.put(old);
    useEditor.getState().openDocument(docWithGuides('doc_r', 0), { filePath: '/art/B.pgfx' });
    expect(recoveryTarget(old)).toBeNull();
    await recoverEntries([old]);
    const sessions = Object.values(useEditor.getState().sessions);
    expect(sessions.length).toBe(2);
    expect(session('doc_r').doc.guides.length).toBe(0);
    const recovered = sessions.find((x) => x.doc.id !== 'doc_r')!;
    expect(recovered.doc.guides.length).toBe(4);
    expect(recovered.filePath).toBe('/art/A.pgfx');
  });

  it('discarding in the recovery dialog deletes only the chosen entries', async () => {
    const a = await crashEntry('doc_a', 1);
    const b = await crashEntry('doc_b', 2, null);
    await mem.store.put(a);
    await mem.store.put(b);
    await discardEntries([a]);
    expect([...mem.m.keys()]).toEqual([b.id]);
  });
});

describe('discarding unsaved changes on quit', () => {
  it('deletes this launch’s entries, also when an autosave is writing at that moment', async () => {
    useEditor.getState().openDocument(docWithGuides('doc_d', 0), { filePath: PATH });
    edit('doc_d');
    await autosaveNow();
    expect(mem.m.has(recoveryKey('doc_d'))).toBe(true);
    edit('doc_d');
    const inFlight = autosaveNow(); // encoding the new state while the user clicks Discard
    await discardRecoveryFor(['doc_d']);
    await inFlight;
    expect(mem.m.size).toBe(0);
    // The discarded state is never written again…
    await autosaveNow();
    expect(mem.m.size).toBe(0);
    // …but if the window stays open and the user keeps working, autosave protects the new work.
    edit('doc_d');
    await autosaveNow();
    expect(mem.m.has(recoveryKey('doc_d'))).toBe(true);
  });

  it('whichever stage the autosave is at when Discard is clicked (yield, encode, write)', async () => {
    const macrotask = () => new Promise((r) => setTimeout(r, 0));
    for (let k = 0; k < 8; k++) {
      const id = `doc_k${k}`;
      useEditor.getState().openDocument(docWithGuides(id, 0), { filePath: `/art/K${k}.pgfx` });
      edit(id);
      await autosaveNow();
      edit(id);
      const inFlight = autosaveNow();
      for (let i = 0; i < k; i++) await macrotask();
      await discardRecoveryFor([id]);
      await inFlight;
      expect(mem.m.has(recoveryKey(id)), `discard after ${k} macrotasks`).toBe(false);
    }
  });

  it('never touches entries of earlier launches', async () => {
    const old = await crashEntry('doc_e', 2);
    await mem.store.put(old);
    useEditor.getState().openDocument(docWithGuides('doc_e', 0), { filePath: PATH });
    edit('doc_e');
    await autosaveNow();
    await discardRecoveryFor(['doc_e']);
    expect([...mem.m.keys()]).toEqual([old.id]);
  });
});

describe('browser build: leaving the page through "Leave page?"', () => {
  it('marks this launch’s entries on pagehide; the next start drops them, a crash leftover is kept', async () => {
    startAutosave(); // registers the pagehide marker (not in the desktop app, see autosave.desktop.test.ts)
    const crashed = await crashEntry('doc_c', 3);
    await mem.store.put(crashed);
    useEditor.getState().openDocument(docWithGuides('doc_b', 0), { filePath: null });
    edit('doc_b');
    await autosaveNow();
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem('perseverance.recovery.closedDirty') ?? '[]')).toEqual([recoveryKey('doc_b')]);
    // Next start (simulated): this launch's entry is now an earlier launch's.
    const own = mem.m.get(recoveryKey('doc_b'))!;
    mem.m.set(own.id, { ...own, launchId: 'run_prev' });
    const pending = await pendingRecovery();
    expect(pending.map((e) => e.id)).toEqual([crashed.id]);
    expect(mem.m.has(own.id)).toBe(false);
  });
});

/**
 * Before a forced quit ("Quit Anyway" in a native prompt — the in-app prompt is stuck or the UI broke)
 * the main process asks the page to write its copies now (preload 'desktop:flush-recovery'): the
 * native prompt promises that the next start offers them, so the latest edit must be in them, not only
 * what the last 2-minute tick wrote.
 */
describe('writing the copies right before a forced quit (flushRecovery)', () => {
  it('writes an edit the regular autosave has not reached yet', async () => {
    useEditor.getState().openDocument(docWithGuides('doc_f', 0), { filePath: PATH });
    edit('doc_f');
    edit('doc_f');
    expect(await flushRecovery()).toBe(0);
    expect(guidesIn(mem.m.get(recoveryKey('doc_f'))!)).toBe(2);
  });

  it('waits for an autosave that is writing, then writes the edit made meanwhile', async () => {
    useEditor.getState().openDocument(docWithGuides('doc_g', 0), { filePath: PATH });
    edit('doc_g');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const put = mem.store.put;
    let first = true;
    mem.store.put = async (e) => {
      if (first) {
        first = false;
        await gate; // the regular tick is stuck writing the 1-guide state
      }
      await put(e);
    };
    const tick = autosaveNow();
    for (let i = 0; i < 20 && first; i++) await new Promise((r) => setTimeout(r, 0));
    expect(first).toBe(false);
    edit('doc_g'); // after that tick took its snapshot
    let done = false;
    const flushing = flushRecovery().then((n) => ((done = true), n));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false); // not before the copy is really there
    release();
    expect(await flushing).toBe(0);
    await tick;
    expect(guidesIn(mem.m.get(recoveryKey('doc_g'))!)).toBe(2);
  });

  it('one document that can’t be written doesn’t keep the others from being kept', async () => {
    useEditor.getState().openDocument(docWithGuides('doc_bad', 0), { filePath: '/art/Bad.pgfx' });
    useEditor.getState().openDocument(docWithGuides('doc_ok', 0), { filePath: PATH });
    edit('doc_bad');
    edit('doc_ok');
    const put = mem.store.put;
    mem.store.put = async (e) => {
      if (e.docId === 'doc_bad') throw new Error('QuotaExceededError');
      await put(e);
    };
    expect(await flushRecovery()).toBe(1);
    expect([...mem.m.keys()]).toEqual([recoveryKey('doc_ok')]);
  });

  it('autosave turned off: nothing is written', async () => {
    localStorage.setItem('perseverance.prefs', JSON.stringify({ autosaveMinutes: 0 }));
    useEditor.getState().openDocument(docWithGuides('doc_off', 0), { filePath: PATH });
    edit('doc_off');
    expect(await flushRecovery()).toBe(1);
    expect(mem.m.size).toBe(0);
  });

  it('a discarded state is not written again', async () => {
    useEditor.getState().openDocument(docWithGuides('doc_x', 0), { filePath: PATH });
    edit('doc_x');
    await discardRecoveryFor(['doc_x']);
    expect(await flushRecovery()).toBe(0);
    expect(mem.m.size).toBe(0);
  });
});

/**
 * gate-fix-diff-review-1: a crash entry kept with "Later" outlives the reopened project being edited
 * and saved. Offered later, it must never be bound to the file again (a Save would quietly replace the
 * newer saved work with the stale copy, and Undo couldn't bring it back).
 */
describe('an entry older than the last save of its project file', () => {
  it('recovers as a separate unsaved copy: the file is never bound to it', async () => {
    const old = await crashEntry('doc_p', 5); // autosaved a minute ago
    await mem.store.put(old);
    // "Later"; Open Recent → Poster, 12 guides, Save (the project file is newer now), Close.
    useEditor.getState().openDocument(docWithGuides('doc_p', 12), { filePath: PATH });
    await noteProjectSaved(PATH);
    useEditor.getState().closeDocument('doc_p');

    // Next start: still offered, but known to be older than the file (the mark is on its info row).
    const pending = await pendingRecovery();
    expect(pending.map((e) => e.id)).toEqual([old.id]);
    expect(savedAfter(pending[0])).not.toBeNull();

    await recoverEntries(pending);
    const all = Object.values(useEditor.getState().sessions);
    expect(all.length).toBe(1);
    const copy = all[0];
    expect(copy.doc.guides.length).toBe(5);
    expect(copy.dirty).toBe(true);
    expect(copy.filePath).toBeNull(); // Save goes through Save As, never over Poster.pgfx
    expect(copy.doc.name).toMatch(/^Poster \(autosaved .+\)$/);
    // Kept under this launch's key, without the file and without the mark.
    const kept = mem.m.get(recoveryKey(copy.doc.id))!;
    expect([...mem.m.keys()]).toEqual([kept.id]);
    expect(kept.filePath ?? null).toBeNull();
    expect(kept.supersededAt).toBeUndefined();
    expect(guidesIn(kept)).toBe(5);
  });

  it('with the newer project open: a separate tab, the open copy is left alone', async () => {
    const old = await crashEntry('doc_p', 5);
    await mem.store.put(old);
    useEditor.getState().openDocument(docWithGuides('doc_p', 12), { filePath: PATH });
    await noteProjectSaved(PATH);
    const before = session('doc_p');
    await recoverEntries(await pendingRecovery());
    const open = session('doc_p');
    expect(open).toBe(before); // not even an undoable step on the saved copy
    expect(open.doc.guides.length).toBe(12);
    expect(open.dirty).toBe(false);
    const copy = Object.values(useEditor.getState().sessions).find((s) => s.doc.id !== 'doc_p')!;
    expect(copy.doc.guides.length).toBe(5);
    expect(copy.filePath).toBeNull();
  });

  it('an entry written after the last save still saves back to its file; opening alone changes nothing', async () => {
    const old = await crashEntry('doc_q', 3); // a minute ago
    await mem.store.put(old);
    await noteProjectSaved(PATH, Date.now() - 120000); // that save came before the crash entry
    const { addRecentFile } = await import('./recent');
    addRecentFile(PATH); // reopening (Open Recent updates its time) is not a save
    const [info] = await pendingRecovery();
    expect(savedAfter(info)).toBeNull();
    await recoverEntries([info]);
    expect(session('doc_q').filePath).toBe(PATH);
  });

  it('a save marks only earlier launches’ entries for that file; never this launch’s own', async () => {
    await mem.store.put(await crashEntry('doc_a', 1, PATH));
    await mem.store.put(await crashEntry('doc_b', 2, '/art/Other.pgfx'));
    await mem.store.put(await crashEntry('doc_n', 2, null));
    useEditor.getState().openDocument(docWithGuides('doc_o', 0), { filePath: PATH });
    edit('doc_o');
    await autosaveNow();
    await noteProjectSaved(PATH, Date.now() + 1000);
    const byDoc = Object.fromEntries((await listRecovery()).map((e) => [e.docId, savedAfter(e) !== null]));
    expect(byDoc).toEqual({ doc_a: true, doc_b: false, doc_n: false, doc_o: false });
  });
});

/** gate-fix-diff-review-2: the start-up list must not load every entry's .pgfx data. */
describe('the recovery list reads no project data', () => {
  it('pendingRecovery lists infos only; recovering reads just the chosen entries', async () => {
    const a = await crashEntry('doc_a', 1);
    const b = await crashEntry('doc_b', 2, '/art/B.pgfx');
    await mem.store.put(a);
    await mem.store.put(b);
    const pending = await pendingRecovery();
    expect(pending.length).toBe(2);
    for (const e of pending) {
      expect('data' in e).toBe(false);
      expect(e.bytes).toBe(mem.m.get(e.id)!.data.byteLength);
    }
    expect(mem.reads).toEqual([]);
    await recoverEntries(pending.filter((e) => e.id === b.id));
    expect(mem.reads).toEqual([b.id]);
    expect(Object.values(useEditor.getState().sessions).map((s) => s.doc.guides.length)).toEqual([2]);
  });

  it('an entry deleted meanwhile is reported, the others are recovered', async () => {
    const a = await crashEntry('doc_a', 1, '/art/A.pgfx');
    const b = await crashEntry('doc_b', 2, '/art/B.pgfx');
    await mem.store.put(a);
    await mem.store.put(b);
    const pending = await pendingRecovery();
    mem.m.delete(a.id);
    await recoverEntries(pending);
    expect(Object.values(useEditor.getState().sessions).map((s) => s.filePath)).toEqual(['/art/B.pgfx']);
  });
});
