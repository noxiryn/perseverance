/**
 * Desktop app: closing the window normally never counts as "Don't Save". The main process' "Quit
 * Anyway" (stuck or missing prompt), Windows session end and every other forced close unload the page
 * normally; the autosaved copies must survive them, as the native prompts say ("the next start offers
 * to recover the autosaved copy"), and before such a quit the main process has the page write them
 * (onFlushRecovery). Only the in-app Discard deletes them (discardRecoveryFor).
 * (packaged-app-5, electron-security-2, app-logic-diff-2)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../core/document';
import { useEditor } from '../state/editor';

const bridge = vi.hoisted(() => ({ flush: null as null | (() => Promise<unknown>) }));

vi.mock('../platform', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../platform')>();
  const desktop = {
    onFlushRecovery: (cb: () => Promise<unknown>) => {
      bridge.flush = cb;
      return () => (bridge.flush = null);
    },
  } as unknown as typeof orig.desktop;
  return { ...orig, isDesktop: true, desktop };
});

const { autosaveNow, pendingRecovery, recoveryKey, resetAutosaveState, setRecoveryStore, startAutosave } = await import('./autosave');

afterEach(() => setRecoveryStore(null));

describe('desktop: a normal page unload keeps the recovery entries', () => {
  it('pagehide (Quit Anyway / session end) writes no discard marker; the next start offers the entry', async () => {
    const m = new Map<string, import('./autosave').RecoveryEntry>();
    setRecoveryStore({ getAll: async () => [...m.values()], put: async (e) => void m.set(e.id, e), delete: async (k) => void m.delete(k) });
    resetAutosaveState();
    localStorage.clear();
    startAutosave();
    const doc = createDocument({ name: 'Poster', width: 20, height: 20 });
    useEditor.getState().openDocument(doc, { filePath: '/art/Poster.pgfx' });
    useEditor.getState().commit('Add Guide', (d) => {
      d.guides.push({ id: 'g', orientation: 'vertical', position: 3 });
    });
    await autosaveNow();
    expect(m.has(recoveryKey(doc.id))).toBe(true);

    window.dispatchEvent(new Event('pagehide')); // the window closes without the user's Discard
    expect(localStorage.getItem('perseverance.recovery.closedDirty')).toBeNull();

    // Next launch: the entry belongs to an earlier launch and is offered.
    const e = m.get(recoveryKey(doc.id))!;
    m.set(e.id, { ...e, launchId: 'run_prev' });
    expect((await pendingRecovery()).map((x) => x.id)).toEqual([e.id]);
  });

  it('a discard marker an older version left (also written by forced quits) never deletes an entry', async () => {
    const m = new Map<string, import('./autosave').RecoveryEntry>();
    setRecoveryStore({ getAll: async () => [...m.values()], put: async (e) => void m.set(e.id, e), delete: async (k) => void m.delete(k) });
    resetAutosaveState();
    // An entry of the old format (keyed by document id) plus the old build's marker naming it.
    m.set('doc_old', { id: 'doc_old', name: 'Poster', time: Date.now() - 1000, width: 1, height: 1, data: new ArrayBuffer(8), filePath: '/art/Poster.pgfx' });
    localStorage.setItem('perseverance.recovery.closedDirty', JSON.stringify(['doc_old']));
    expect((await pendingRecovery()).map((x) => x.id)).toEqual(['doc_old']);
    expect(m.has('doc_old')).toBe(true);
    expect(localStorage.getItem('perseverance.recovery.closedDirty')).toBeNull();
  });
});

describe('desktop: the main process asks for the copies before a forced quit', () => {
  it('startAutosave answers desktop:flush-recovery by writing the latest state', async () => {
    const m = new Map<string, import('./autosave').RecoveryEntry>();
    setRecoveryStore({ getAll: async () => [...m.values()], put: async (e) => void m.set(e.id, e), delete: async (k) => void m.delete(k) });
    resetAutosaveState();
    localStorage.clear();
    startAutosave(); // no-op if an earlier test started it: the listener is registered once per page
    expect(bridge.flush).toBeTypeOf('function');
    const doc = createDocument({ name: 'Flyer', width: 20, height: 20 });
    useEditor.getState().openDocument(doc, { filePath: '/art/Flyer.pgfx' });
    useEditor.getState().commit('Add Guide', (d) => {
      d.guides.push({ id: 'g', orientation: 'vertical', position: 3 });
    });
    expect(m.size).toBe(0); // the 2-minute tick hasn't run
    expect(await bridge.flush!()).toBe(0);
    expect(m.has(recoveryKey(doc.id))).toBe(true);
  });
});
