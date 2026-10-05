/**
 * Document lifecycle helpers used by the shell: close with unsaved-changes confirmation,
 * quick-create documents, templates, recent files.
 */
import { bitmaps } from '../../core/bitmaps';
import { createDocument, insertLayerDraft, makeRasterLayer } from '../../core/document';
import type { DocSession } from '../../core/types';
import { commands, docPresets, runCommand, type DocPresetDef, type TemplateDef } from '../../registry';
import { desktop, fileNameOf, type OpenedFile } from '../../platform';
import { useEditor } from '../../state/editor';
import { toast, useUI } from '../../state/ui';
import { openFile } from '../../io/open';
import { askChoice } from './dialogs/ChoiceDialog';
import { defaultBackgroundColor } from './prefs';

/* ------------------------------------------------------------------ */
/* Saving / closing                                                    */
/* ------------------------------------------------------------------ */

/** Save one session via the io module's file.save. Resolves true when it is no longer dirty. */
export async function saveSession(id: string): Promise<boolean> {
  const ed = useEditor.getState();
  if (!ed.sessions[id]) return true;
  if (!commands.has('file.save')) {
    toast('Saving is not available yet', 'warning');
    return false;
  }
  ed.setActiveDoc(id);
  try {
    await runCommand('file.save');
  } catch (e) {
    console.error(e);
    toast(`Could not save: ${(e as Error).message ?? e}`, 'error');
    return false;
  }
  const s = useEditor.getState().sessions[id];
  return !s || !s.dirty;
}

/**
 * Close a document, asking to save first when it has unsaved changes.
 * Resolves true when the document was closed.
 */
export async function requestCloseDocument(id: string): Promise<boolean> {
  const s = useEditor.getState().sessions[id];
  if (!s) return true;
  if (s.dirty) {
    const choice = await askChoice({
      title: 'Unsaved changes',
      message: `Save changes to “${s.doc.name}” before closing?`,
      detail: 'Your changes will be lost if you don’t save them.',
      choices: [
        { value: 'discard', label: 'Don’t Save', variant: 'ghost' },
        { value: 'cancel', label: 'Cancel' },
        { value: 'save', label: 'Save', variant: 'primary' },
      ],
    });
    if (!choice || choice === 'cancel') return false;
    if (choice === 'save' && !(await saveSession(id))) return false;
  }
  useEditor.getState().closeDocument(id);
  return true;
}

/** Close all documents except `keepId` (asking for each dirty one). Stops on Cancel. */
export async function closeOtherDocuments(keepId: string | null) {
  for (const id of [...useEditor.getState().docOrder]) {
    if (id === keepId) continue;
    if (!(await requestCloseDocument(id))) return;
  }
}

export function dirtySessions(): DocSession[] {
  const st = useEditor.getState();
  return st.docOrder.map((id) => st.sessions[id]).filter((s): s is DocSession => !!s && s.dirty);
}

/* ------------------------------------------------------------------ */
/* Creating documents                                                  */
/* ------------------------------------------------------------------ */

export interface QuickPreset {
  id: string;
  name: string;
  width: number;
  height: number;
  description: string;
}

export const BUILTIN_QUICK_PRESETS: QuickPreset[] = [
  { id: 'roblox-icon', name: 'Roblox Icon', width: 512, height: 512, description: 'Square experience icon' },
  { id: 'roblox-thumbnail', name: 'Roblox Thumbnail', width: 1920, height: 1080, description: '16:9 experience thumbnail' },
];

/** Find a matching registered doc preset (by size, preferring the Roblox category). */
export function findDocPreset(width: number, height: number): DocPresetDef | undefined {
  const all = docPresets.list().filter((p) => p.width === width && p.height === height);
  return all.find((p) => p.category === 'Roblox') ?? all[0];
}

/** Create and open a blank document with a Background layer (respects the default background pref). */
export function createBlankDocument(name: string, width: number, height: number) {
  const bg = defaultBackgroundColor();
  const doc = createDocument({ name, width, height, background: bg });
  const layer = makeRasterLayer({
    name: bg ? 'Background' : 'Layer 1',
    bitmapId: bitmaps.create(width, height, bg ?? undefined),
    width,
    height,
  });
  insertLayerDraft(doc, layer, {});
  useEditor.getState().openDocument(doc, { label: 'New Document', activeLayerId: layer.id });
  return doc.id;
}

export function quickCreate(p: { name: string; width: number; height: number }) {
  const preset = findDocPreset(p.width, p.height);
  return createBlankDocument(preset?.name ?? p.name, p.width, p.height);
}

export async function openTemplate(t: TemplateDef) {
  // The templates module opens the document with the placeholder character selected (so looks
  // target it) and loads the template's fonts.
  const { openTemplate: openFromTemplates } = await import('../../templates/open');
  await openFromTemplates(t.id);
}

/* ------------------------------------------------------------------ */
/* Opening files                                                       */
/* ------------------------------------------------------------------ */

export interface RecentEntry {
  path: string;
  name: string;
  time: number;
}

export const RECENT_KEY = 'perseverance.recent';

export function readRecent(): RecentEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((e): e is RecentEntry => !!e && typeof e === 'object' && typeof (e as RecentEntry).path === 'string')
      .map((e) => ({ path: e.path, name: typeof e.name === 'string' ? e.name : fileNameOf(e.path), time: Number(e.time) || 0 }));
  } catch {
    return [];
  }
}

export function removeRecent(path: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(readRecent().filter((e) => e.path !== path)));
  } catch {
    /* ignore */
  }
}

/** Open a file through the io module, reporting failures as toasts. */
export async function openFileWithIo(file: OpenedFile, opts: { asNewDocument?: boolean } = {}) {
  try {
    await openFile(file, opts);
  } catch (e) {
    console.error(e);
    toast(`Could not open ${file.name}: ${(e as Error).message ?? e}`, 'error');
  }
}

export async function openRecent(entry: RecentEntry) {
  if (!desktop) {
    toast('Recent files can only be reopened in the desktop app — use File ▸ Open', 'info');
    return;
  }
  try {
    const data = await desktop.readFile(entry.path);
    await openFileWithIo({ path: entry.path, name: entry.name || fileNameOf(entry.path), data }, { asNewDocument: true });
  } catch (e) {
    console.error(e);
    removeRecent(entry.path);
    toast(`“${entry.name}” could not be found. It was removed from recent files.`, 'error', 4000);
  }
}

/** Relative time label ('2 min ago', 'Yesterday', 'Mar 4'). */
export function timeAgo(t: number, now = Date.now()): string {
  if (!t) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'Yesterday';
  if (s < 604800) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Ensure the start screen is shown again after all documents are closed. */
export function showStartScreen() {
  useUI.getState().setShowStart(true);
}
