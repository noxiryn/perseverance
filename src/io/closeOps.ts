/**
 * File ▸ Close / Close All / Exit with unsaved-changes confirmation.
 */
import type { ID } from '../core/types';
import { desktop } from '../platform';
import { useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { askChoice } from './dialogs/ChoiceDialog';
import { saveDocument } from './save';
import { removeRecovery } from './autosave';

/** Close a document, asking Save / Don't Save / Cancel when dirty. Resolves true when closed. */
export async function closeDocumentWithPrompt(id: ID): Promise<boolean> {
  const s = useEditor.getState().sessions[id];
  if (!s) return true;
  if (s.dirty) {
    useEditor.getState().setActiveDoc(id);
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
    if (choice === 'save' && !(await saveDocument(id))) return false;
  }
  useEditor.getState().closeDocument(id);
  void removeRecovery(id);
  return true;
}

export async function closeActive() {
  const id = useEditor.getState().activeDocId;
  if (!id) {
    toast('There is no document to close.', 'info');
    return;
  }
  await closeDocumentWithPrompt(id);
}

/** Close every document (stops at the first Cancel). Resolves true when all were closed. */
export async function closeAll(): Promise<boolean> {
  for (const id of [...useEditor.getState().docOrder]) {
    if (!(await closeDocumentWithPrompt(id))) return false;
  }
  return true;
}

export function exitApp() {
  if (desktop) {
    // The main process asks the shell to confirm unsaved documents before quitting.
    desktop.close();
    return;
  }
  toast('Close the browser tab to exit Perseverance.', 'info');
}
