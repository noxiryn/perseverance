/**
 * Save / Save As for .pgfx projects. Desktop writes to the session's path; the browser downloads.
 */
import type { ID } from '../core/types';
import { fileNameOf, isDesktop, saveFile, writeFile } from '../platform';
import { useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { safeFileName } from './math';
import { encodeProject } from './project';
import { addRecentFile } from './recent';
import { removeRecovery } from './autosave';
import { baseName, currentEntryId, markSavedAt, renameDocSilently } from './util';

export const PROJECT_FILTERS = [{ name: 'Perseverance Project', extensions: ['pgfx'] }];

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
  const entryId = currentEntryId(s);
  try {
    const data = await encodeProject(s.doc);
    if (!opts.saveAs && s.filePath && isDesktop) {
      await writeFile(s.filePath, data);
      markSavedAt(id, entryId);
      addRecentFile(s.filePath);
      void removeRecovery(id);
      toast(`Saved “${fileNameOf(s.filePath)}”`, 'success');
      return true;
    }
    const defaultPath = s.filePath && isDesktop ? s.filePath : `${safeFileName(s.doc.name)}.pgfx`;
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
