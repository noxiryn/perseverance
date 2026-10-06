/**
 * Save / Save As for .pgfx projects. Desktop writes to the session's path; the browser downloads.
 */
import type { ID } from '../core/types';
import { fileNameOf, isAccessDenied, isDesktop, samePath, saveFile, writeFile } from '../platform';
import { useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { safeFileName } from './math';
import { encodeProjectSnapshot } from './project';
import { addRecentFile, readRecentFiles } from './recent';
import { noteProjectSaved, removeRecovery } from './autosave';
import { baseName, currentEntryId, markDirty, markSavedAt, renameDocSilently } from './util';

export const PROJECT_FILTERS = [{ name: 'Perseverance Project', extensions: ['pgfx'] }];

/**
 * Why a desktop write to the document's own path failed, when choosing another place helps: the file
 * (or its drive) is read-only or held by another app, its folder or drive is gone (USB stick removed,
 * folder deleted or renamed), or the disk is full. Null for anything else.
 */
export function saveInPlaceProblem(e: unknown): 'read-only' | 'missing' | 'full' | null {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (/\b(EACCES|EPERM|EROFS|EBUSY)\b/.test(msg)) return 'read-only';
  if (/\b(ENOENT|ENOTDIR|ENODEV|ENXIO)\b/.test(msg)) return 'missing';
  if (/\b(ENOSPC|EDQUOT)\b/.test(msg)) return 'full';
  return null;
}

const PROBLEM_TEXT = {
  'read-only': "can't be changed (read-only or in use)",
  missing: "can't be saved where it was — its folder or drive is no longer available",
  full: "can't be saved — the disk is full",
} as const;

/**
 * Where Save As starts for a document that has no file yet (new, from a template, or a project dropped
 * from somewhere without a path): the folder of the most recent project in Open Recent, so the dialog
 * doesn't open in an unrelated folder. A name whose file is open in another tab (`busy`) gets " copy"
 * (" copy 2", …): the dialog never proposes replacing a project that is open. Pure: `recent` is newest
 * first.
 */
export function defaultProjectSavePath(name: string, recent: readonly { path: string }[], busy: readonly string[] = []): string {
  const base = safeFileName(name);
  const last = recent.find((r) => /\.pgfx$/i.test(r.path) && /[\\/]/.test(r.path));
  // Keep the folder with its own trailing separator ("C:\Art\" or "/home/me/art/").
  const dir = last ? last.path.replace(/[^\\/]+$/, '') : '';
  for (let i = 0; i < 100; i++) {
    const p = `${dir}${base}${i === 0 ? '' : i === 1 ? ' copy' : ` copy ${i}`}.pgfx`;
    // Without a folder the dialog picks one: only a folder we know can be compared.
    if (!dir || !busy.some((b) => samePath(b, p))) return p;
  }
  return `${dir}${base}.pgfx`;
}

/** Files of the projects open in the other tabs. Save As never writes over one of them. */
export function openProjectPaths(exceptId?: ID): string[] {
  return Object.values(useEditor.getState().sessions)
    .filter((s) => s.doc.id !== exceptId && !!s.filePath)
    .map((s) => s.filePath as string);
}

/**
 * Another tab shows the project just written over (the main process refuses Save As onto a project open
 * in another tab, but a tab opened while the Save dialog was up isn't in that list): its content is no
 * longer on disk, so it becomes an unsaved document again — closing it asks first, and Save asks where.
 */
function detachOverwritten(savedId: ID, path: string) {
  const st = useEditor.getState();
  for (const other of Object.values(st.sessions)) {
    if (other.doc.id === savedId || !samePath(other.filePath, path)) continue;
    st.setFilePath(other.doc.id, null, false);
    markDirty(other.doc.id);
    toast(`“${other.doc.name}” was replaced on disk by another tab — it is now an unsaved document. Save it under another name to keep it.`, 'warning', 7000);
  }
}

let saving = false;

/**
 * This launch's autosaved copy of a saved document is no longer needed — unless the tab is dirty again
 * (an edit made while saving): then the copy still protects that edit until the next autosave.
 */
function dropRecoveryIfClean(id: ID) {
  if (!useEditor.getState().sessions[id]?.dirty) void removeRecovery(id);
}

/**
 * Save a document (default: active). Resolves true when the document was written.
 * `saveAs` forces the file dialog.
 */
export async function saveDocument(docId?: ID, opts: { saveAs?: boolean } = {}): Promise<boolean> {
  const st = useEditor.getState();
  const id = docId ?? st.activeDocId;
  const s = id ? st.sessions[id] : null;
  if (!id || !s) {
    toast('There is no document to save.', 'info');
    return false;
  }
  if (saving) {
    toast('A save is already in progress…', 'info');
    return false;
  }
  saving = true;
  // Save exactly the state that will be marked as saved: the current history step. (A live
  // preview — a drag or Free Transform not committed yet — is not part of it.) encodeProjectSnapshot
  // snapshots its pixels synchronously, so undo/redo or edits during the encode can't mix states.
  // The step is identified by its id AND its document: an edit coalesced into the same step during
  // the encode (slider scrub, nudge) changes the document but not the id — then the tab stays dirty.
  const committed = s.history.entries[s.history.index]?.doc ?? s.doc;
  const saved = { entryId: currentEntryId(s), doc: committed };
  try {
    const snapshot = await encodeProjectSnapshot(committed);
    const data = snapshot.pack();
    if (!opts.saveAs && s.filePath && isDesktop) {
      let written = true;
      try {
        await writeFile(s.filePath, data);
      } catch (e) {
        // The desktop app only writes to paths the user chose (dialogs / opened projects); a path it
        // doesn't know goes through Save As instead. So does a read-only or locked file (the main
        // process refuses to replace it), a folder/drive that is gone, and a full disk.
        const problem = saveInPlaceProblem(e);
        if (problem) toast(`“${fileNameOf(s.filePath)}” ${PROBLEM_TEXT[problem]} — choose where to save it.`, problem === 'read-only' ? 'info' : 'warning', 5000);
        else if (!isAccessDenied(e)) throw e;
        written = false;
      }
      if (written) {
        // Autosaved copies an earlier launch left for this file are now older than it (savedAfter).
        void noteProjectSaved(s.filePath);
        markSavedAt(id, saved);
        addRecentFile(s.filePath);
        dropRecoveryIfClean(id);
        toast(`Saved “${fileNameOf(s.filePath)}”`, 'success');
        return true;
      }
    }
    const busyPaths = isDesktop ? openProjectPaths(id) : [];
    const defaultPath = !isDesktop ? `${safeFileName(committed.name)}.pgfx` : (s.filePath ?? defaultProjectSavePath(committed.name, readRecentFiles(), busyPaths));
    const result = await saveFile({ title: 'Save As', defaultPath, filters: PROJECT_FILTERS, data, busyPaths });
    if (!result) return false; // cancelled
    if (isDesktop) {
      void noteProjectSaved(result);
      detachOverwritten(id, result);
      useEditor.getState().setFilePath(id, result, false);
    }
    // Before the silent rename: it gives every step a renamed copy of its document.
    markSavedAt(id, saved);
    if (isDesktop) {
      // The document takes the file's name (like Photoshop), and so does the copy inside the file: it
      // was packed before the dialog, under the old name (e.g. the template's). The same snapshot is
      // packed again under the new name — exactly the saved step, whatever happened since.
      const name = baseName(fileNameOf(result));
      renameDocSilently(id, name);
      if (name && name !== committed.name) {
        try {
          await writeFile(result, snapshot.pack(name));
        } catch (e) {
          // The file is complete under the old name; opening it names the document after the file anyway.
          console.warn('[io] could not store the new name in the project file', e);
        }
      }
      addRecentFile(result);
    }
    dropRecoveryIfClean(id);
    toast(isDesktop ? `Saved “${fileNameOf(result)}”` : `Downloaded “${result}”`, 'success');
    return true;
  } catch (e) {
    console.error('[io] save failed', e);
    toast(`Could not save “${s.doc.name}”: ${(e as Error)?.message ?? e}`, 'error', 5000);
    return false;
  } finally {
    saving = false;
  }
}
