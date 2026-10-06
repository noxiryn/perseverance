/**
 * Save As stores the chosen file name as the document name — in the tab and inside the file — and
 * opening a project names it after its file, like Photoshop (packaged-app-1). Before, a project made
 * from a template reopened under the template's name whatever the file was called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from '../core/types';
import { createDocument } from '../core/document';
import { useEditor } from '../state/editor';
import { unpackContainer } from './container';

const platform = vi.hoisted(() => ({
  writes: [] as { path: string; data: ArrayBuffer }[],
  dialogs: [] as (string | undefined)[],
  busy: [] as (string[] | undefined)[],
  answer: '/art/Poster.pgfx' as string | null,
}));

vi.mock('../platform', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../platform')>();
  return {
    ...orig,
    isDesktop: true,
    desktop: { platform: 'linux' } as unknown as typeof orig.desktop,
    saveFile: async (o: { defaultPath?: string; data: ArrayBuffer; busyPaths?: string[] }) => {
      platform.dialogs.push(o.defaultPath);
      platform.busy.push(o.busyPaths);
      if (!platform.answer) return null;
      platform.writes.push({ path: platform.answer, data: o.data });
      return platform.answer;
    },
    writeFile: async (path: string, data: ArrayBuffer) => {
      platform.writes.push({ path, data });
      return true;
    },
  };
});

const { saveDocument, defaultProjectSavePath, openProjectPaths } = await import('./save');
const { encodeProject, loadProject } = await import('./project');
const { autosaveNow, recoveryKey, resetAutosaveState, setRecoveryStore } = await import('./autosave');

const nameIn = (data: ArrayBuffer) => (unpackContainer(data).header.document as Document).name;

beforeEach(() => {
  platform.writes.length = 0;
  platform.dialogs.length = 0;
  platform.busy.length = 0;
  platform.answer = '/art/Poster.pgfx';
  useEditor.setState({ sessions: {}, docOrder: [], activeDocId: null });
  localStorage.clear();
  setRecoveryStore({ getAll: async () => [], put: async () => undefined, delete: async () => undefined });
});

describe('Save As names the document after the file', () => {
  it('the tab and the file both get the chosen name; the tab stays clean', async () => {
    const doc = createDocument({ name: 'Crimson Film Thumbnail', width: 20, height: 10 });
    useEditor.getState().openDocument(doc);
    expect(await saveDocument(doc.id, { saveAs: true })).toBe(true);
    const s = useEditor.getState().sessions[doc.id];
    expect(s.doc.name).toBe('Poster');
    expect(s.filePath).toBe('/art/Poster.pgfx');
    expect(s.dirty).toBe(false);
    const last = platform.writes.at(-1)!;
    expect(last.path).toBe('/art/Poster.pgfx');
    expect(nameIn(last.data)).toBe('Poster');
  });

  it('an edit made meanwhile is never mixed into the file; the file still gets the new name', async () => {
    const doc = createDocument({ name: 'Template Name', width: 20, height: 10 });
    useEditor.getState().openDocument(doc);
    const saving = saveDocument(doc.id, { saveAs: true });
    useEditor.getState().commit('Add Guide', (d) => {
      d.guides.push({ id: 'g', orientation: 'vertical', position: 2 });
    });
    expect(await saving).toBe(true);
    // The saved step's snapshot, packed again under the chosen name (no re-snapshot of the edited state).
    for (const w of platform.writes) expect((unpackContainer(w.data).header.document as Document).guides.length).toBe(0);
    expect(nameIn(platform.writes.at(-1)!.data)).toBe('Poster');
    const s = useEditor.getState().sessions[doc.id];
    expect(s.dirty).toBe(true);
    expect(s.doc.name).toBe('Poster');
    expect(s.doc.guides.length).toBe(1);
  });

  it('a file already named like the document is written once', async () => {
    const doc = createDocument({ name: 'Poster', width: 20, height: 10 });
    useEditor.getState().openDocument(doc);
    expect(await saveDocument(doc.id, { saveAs: true })).toBe(true);
    expect(platform.writes.length).toBe(1);
    expect(nameIn(platform.writes[0].data)).toBe('Poster');
  });

  it('a document without a file starts Save As in the folder of the last project', () => {
    expect(defaultProjectSavePath('Poster', [])).toBe('Poster.pgfx');
    expect(defaultProjectSavePath('Poster', [{ path: 'C:\\Art\\Old.pgfx' }])).toBe('C:\\Art\\Poster.pgfx');
    expect(defaultProjectSavePath('Poster', [{ path: '/home/me/pic.png' }, { path: '/home/me/art/Old.pgfx' }])).toBe('/home/me/art/Poster.pgfx');
  });
});

describe('opening a project', () => {
  it('names it after its file, whatever name the file stores', async () => {
    const data = await encodeProject(createDocument({ name: 'Crimson Film Thumbnail', width: 20, height: 10 }));
    const a = await loadProject({ path: '/x/Poster.pgfx', name: 'Poster.pgfx', data });
    expect(a.name).toBe('Poster');
    // A drop from Explorer may come without a path: the file name still counts.
    const b = await loadProject({ path: null, name: 'Thumb 2.pgfx', data });
    expect(b.name).toBe('Thumb 2');
  });
});

describe('saving and this launch’s autosaved copy', () => {
  it('goes when the tab ends up clean, stays while an edit made during the save is unsaved', async () => {
    const m = new Map<string, unknown>();
    setRecoveryStore({ getAll: async () => [], put: async (e) => void m.set(e.id, e), delete: async (k) => void m.delete(k) });
    resetAutosaveState();
    const doc = createDocument({ name: 'Poster', width: 20, height: 10 });
    useEditor.getState().openDocument(doc, { filePath: '/art/Poster.pgfx' });
    const guide = () =>
      useEditor.getState().commit('Add Guide', (d) => {
        d.guides.push({ id: `g${d.guides.length}`, orientation: 'vertical', position: 2 });
      });
    guide();
    await autosaveNow();
    expect([...m.keys()]).toEqual([recoveryKey(doc.id)]);
    const saving = saveDocument(doc.id);
    guide(); // edited while the save is encoding: the tab stays dirty
    expect(await saving).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(useEditor.getState().sessions[doc.id].dirty).toBe(true);
    expect(m.size).toBe(1);
    expect(await saveDocument(doc.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.size).toBe(0);
  });
});

/**
 * Save As never binds two tabs to one file (verifier of the save-recovery fixes): the main process
 * refuses a target open in another tab (`busyPaths`, electron/main.cjs desktop:save-file), the proposed
 * name skips such files, and a tab whose file was replaced anyway becomes an unsaved document.
 */
describe('Save As onto a project open in another tab', () => {
  it('passes the other tabs’ files to the Save dialog (not the tab’s own)', async () => {
    const a = createDocument({ name: 'A', width: 20, height: 10 });
    const b = createDocument({ name: 'B', width: 20, height: 10 });
    useEditor.getState().openDocument(a, { filePath: '/art/A.pgfx' });
    useEditor.getState().openDocument(b, { filePath: '/art/B.pgfx' });
    expect(openProjectPaths(b.id)).toEqual(['/art/A.pgfx']);
    platform.answer = '/art/B2.pgfx';
    expect(await saveDocument(b.id, { saveAs: true })).toBe(true);
    expect(platform.busy.at(-1)).toEqual(['/art/A.pgfx']);
  });

  it('the proposed name skips files open in other tabs', () => {
    const recent = [{ path: '/art/Old.pgfx' }];
    expect(defaultProjectSavePath('A', recent, ['/art/A.pgfx'])).toBe('/art/A copy.pgfx');
    expect(defaultProjectSavePath('A', recent, ['/art/A.pgfx', '/art/A copy.pgfx'])).toBe('/art/A copy 2.pgfx');
    expect(defaultProjectSavePath('A', recent, ['/other/A.pgfx'])).toBe('/art/A.pgfx');
    expect(defaultProjectSavePath('A', [{ path: 'C:\\Art\\Old.pgfx' }], ['c:/art/a.PGFX'])).toBe('C:\\Art\\A copy.pgfx');
  });

  it('a document without a file proposes a free name next to the last project', async () => {
    const a = createDocument({ name: 'Poster', width: 20, height: 10 });
    useEditor.getState().openDocument(a, { filePath: '/art/Poster.pgfx' });
    localStorage.setItem('perseverance.recent', JSON.stringify([{ path: '/art/Poster.pgfx', name: 'Poster.pgfx', time: Date.now() }]));
    const b = createDocument({ name: 'Poster', width: 20, height: 10 });
    useEditor.getState().openDocument(b);
    platform.answer = null; // cancelled: only the proposal matters here
    expect(await saveDocument(b.id, { saveAs: true })).toBe(false);
    expect(platform.dialogs.at(-1)).toMatch(/Poster copy\.pgfx$/);
  });

  it('a tab whose file was replaced anyway becomes an unsaved document (closing asks, Save asks where)', async () => {
    const a = createDocument({ name: 'A', width: 20, height: 10 });
    const b = createDocument({ name: 'B', width: 20, height: 10 });
    useEditor.getState().openDocument(a, { filePath: '/art/A.pgfx' });
    useEditor.getState().openDocument(b);
    platform.answer = '/art/A.pgfx'; // e.g. A was opened while the Save dialog was up
    expect(await saveDocument(b.id, { saveAs: true })).toBe(true);
    const sa = useEditor.getState().sessions[a.id];
    const sb = useEditor.getState().sessions[b.id];
    expect(sb.filePath).toBe('/art/A.pgfx');
    expect(sb.dirty).toBe(false);
    expect(sa.filePath).toBeNull();
    expect(sa.dirty).toBe(true);
  });
});
