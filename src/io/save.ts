/**
 * Save / Save As for .pgfx projects. Desktop writes to the session's path; the browser downloads.
 */
import type { ID } from '../core/types';
import { fileNameOf, isAccessDenied, isDesktop, saveFile, writeFile } from '../platform';
import { useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { safeFileName } from './math';
import { encodeProject } from './project';
import { addRecentFile } from './recent';
import { removeRecovery } from './autosave';
import { baseName, currentEntryId, markSavedAt, renameDocSilently } from './util';

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

let saving = false;

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
  // preview — a drag or Free Transform not committed yet — is not part of it.) encodeProject
  // snapshots its pixels synchronously, so undo/redo or edits during the encode can't mix states.
  // The step is identified by its id AND its document: an edit coalesced into the same step during
  // the encode (slider scrub, nudge) changes the document but not the id — then the tab stays dirty.
  const committed = s.history.entries[s.history.index]?.doc ?? s.doc;
  const saved = { entryId: currentEntryId(s), doc: committed };
  try {
    const data = await encodeProject(committed);
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
        markSavedAt(id, saved);
        addRecentFile(s.filePath);
        void removeRecovery(id);
        toast(`Saved “${fileNameOf(s.filePath)}”`, 'success');
        return true;
      }
    }
    const defaultPath = s.filePath && isDesktop ? s.filePath : `${safeFileName(committed.name)}.pgfx`;
    const result = await saveFile({ title: 'Save As', defaultPath, filters: PROJECT_FILTERS, data });
    if (!result) return false; // cancelled
    if (isDesktop) useEditor.getState().setFilePath(id, result, false);
    // Before the silent rename: it gives every step a renamed copy of its document.
    markSavedAt(id, saved);
    if (isDesktop) {
      renameDocSilently(id, baseName(fileNameOf(result)));
      addRecentFile(result);
    }
    void removeRecovery(id);
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
