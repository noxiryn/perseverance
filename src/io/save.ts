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

/** A desktop write refused by the OS: the file (or its drive) is read-only, or another app holds it. */
function isReadOnlyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /\b(EACCES|EPERM|EROFS|EBUSY)\b/.test(msg);
}

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
  const entryId = currentEntryId(s);
  const committed = s.history.entries[s.history.index]?.doc ?? s.doc;
  try {
    const data = await encodeProject(committed);
    if (!opts.saveAs && s.filePath && isDesktop) {
      let written = true;
      try {
        await writeFile(s.filePath, data);
      } catch (e) {
        // The desktop app only writes to paths the user chose (dialogs / opened projects); a path it
        // doesn't know (e.g. from an older recent-files list) goes through Save As instead. So does a
        // read-only or locked file (the main process refuses to replace it).
        if (isReadOnlyError(e)) toast(`“${fileNameOf(s.filePath)}” can't be changed (read-only or in use) — choose where to save it.`, 'info', 4200);
        else if (!isAccessDenied(e)) throw e;
        written = false;
      }
      if (written) {
        markSavedAt(id, entryId);
        addRecentFile(s.filePath);
        void removeRecovery(id);
        toast(`Saved “${fileNameOf(s.filePath)}”`, 'success');
        return true;
      }
    }
    const defaultPath = s.filePath && isDesktop ? s.filePath : `${safeFileName(committed.name)}.pgfx`;
    const result = await saveFile({ title: 'Save As', defaultPath, filters: PROJECT_FILTERS, data });
    if (!result) return false; // cancelled
    if (isDesktop) {
      useEditor.getState().setFilePath(id, result, false);
      renameDocSilently(id, baseName(fileNameOf(result)));
      addRecentFile(result);
    }
    markSavedAt(id, entryId);
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
