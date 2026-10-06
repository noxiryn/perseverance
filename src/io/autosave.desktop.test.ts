/**
 * Desktop app: closing the window normally never counts as "Don't Save". The main process' "Quit
 * Anyway" (stuck or missing prompt), Windows session end and every other forced close unload the page
 * normally; the autosaved copies must survive them, as the native prompts promise ("autosave may offer
 * to recover them on the next launch"). Only the in-app Discard deletes them (discardRecoveryFor).
 * (packaged-app-5, electron-security-2, app-logic-diff-2)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../core/document';
import { useEditor } from '../state/editor';

vi.mock('../platform', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../platform')>();
  return { ...orig, isDesktop: true };
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
});
