/**
 * Desktop (Electron) integration: window title + edited state, files opened from the OS,
 * close guard for unsaved documents. Also keeps document.title in sync in the browser.
 */
import { desktop, setWindowTitle } from '../../platform';
import { useEditor } from '../../state/editor';
import { askChoice } from './dialogs/ChoiceDialog';
import { dirtySessions, openFileWithIo, saveSession } from './documents';
import { windowTitle } from './docInfo';

let installed = false;
let closing = false;

function syncTitle() {
  const st = useEditor.getState();
  const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
  const title = windowTitle(s?.doc.name ?? null, !!s?.dirty);
  if (document.title !== title) setWindowTitle(title);
  const anyDirty = Object.values(st.sessions).some((x) => x.dirty);
  desktop?.setDocumentEdited(anyDirty);
}

/** Ask what to do with unsaved documents before quitting. Resolves true when it is OK to close. */
export async function confirmQuit(): Promise<boolean> {
  const dirty = dirtySessions();
  if (!dirty.length) return true;
  const names = dirty.map((s) => `“${s.doc.name}”`);
  const choice = await askChoice({
    title: 'Quit Perseverance',
    message: 'Save changes before closing?',
    detail:
      dirty.length === 1
        ? `${names[0]} has unsaved changes.`
        : `${dirty.length} documents have unsaved changes: ${names.slice(0, 4).join(', ')}${dirty.length > 4 ? '…' : ''}`,
    choices: [
      { value: 'discard', label: 'Discard', variant: 'ghost' },
      { value: 'cancel', label: 'Cancel' },
      { value: 'save', label: dirty.length > 1 ? 'Save All' : 'Save', variant: 'primary' },
    ],
  });
  if (!choice || choice === 'cancel') return false;
  if (choice === 'discard') return true;
  for (const s of dirty) {
    if (!(await saveSession(s.doc.id))) return false;
  }
  return true;
}

export function installDesktopIntegration(): () => void {
  if (installed) return () => {};
  installed = true;
  syncTitle();
  const unsubs: (() => void)[] = [];
  let last = '';
  unsubs.push(
    useEditor.subscribe((st) => {
      const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
      const key = `${st.activeDocId}|${s?.doc.name}|${s?.dirty}|${Object.values(st.sessions).some((x) => x.dirty)}`;
      if (key !== last) {
        last = key;
        syncTitle();
      }
    }),
  );

  if (desktop) {
    unsubs.push(desktop.onOpenFile((file) => void openFileWithIo(file, { asNewDocument: true })));
    unsubs.push(
      desktop.onCloseRequested(async () => {
        if (closing) return;
        closing = true;
        try {
          const ok = await confirmQuit();
          desktop!.confirmClose(ok);
        } finally {
          closing = false;
        }
      }),
    );
  } else if (import.meta.env.PROD) {
    // Browser build: native "leave page?" prompt when there are unsaved changes.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtySessions().length) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    unsubs.push(() => window.removeEventListener('beforeunload', beforeUnload));
  }

  return () => {
    unsubs.forEach((u) => u());
    installed = false;
  };
}
