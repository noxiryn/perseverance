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
  answer: '/art/Poster.pgfx' as string | null,
}));

vi.mock('../platform', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../platform')>();
  return {
    ...orig,
    isDesktop: true,
    desktop: { platform: 'linux' } as unknown as typeof orig.desktop,
    saveFile: async (o: { defaultPath?: string; data: ArrayBuffer }) => {
      platform.dialogs.push(o.defaultPath);
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

const { saveDocument, defaultProjectSavePath } = await import('./save');
const { encodeProject, loadProject } = await import('./project');
const { setRecoveryStore } = await import('./autosave');

const nameIn = (data: ArrayBuffer) => (unpackContainer(data).header.document as Document).name;

beforeEach(() => {
  platform.writes.length = 0;
  platform.dialogs.length = 0;
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

  it('an edit made meanwhile is never mixed into the file (it keeps the old name instead)', async () => {
    const doc = createDocument({ name: 'Template Name', width: 20, height: 10 });
    useEditor.getState().openDocument(doc);
    const saving = saveDocument(doc.id, { saveAs: true });
    useEditor.getState().commit('Add Guide', (d) => {
      d.guides.push({ id: 'g', orientation: 'vertical', position: 2 });
    });
    expect(await saving).toBe(true);
    expect(platform.writes.length).toBe(1); // no rewrite with the new name: the tab is dirty
    expect((unpackContainer(platform.writes[0].data).header.document as Document).guides.length).toBe(0);
    expect(useEditor.getState().sessions[doc.id].dirty).toBe(true);
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
