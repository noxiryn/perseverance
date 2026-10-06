/**
 * Desktop (Electron) integration: window title + edited state, files opened from the OS,
 * close guard for unsaved documents. Also keeps document.title in sync in the browser.
 */
import { desktop, setWindowTitle, type OpenedFile } from '../../platform';
import { useEditor } from '../../state/editor';
import { autosaveBeforeClose, discardRecoveryFor, flushRecovery } from '../../io/autosave';
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
  if (choice === 'discard') {
    // The user threw the changes away: their autosaved copies go too, before the window closes. Every
    // other way out (Quit Anyway, a crash, Windows shutting down) keeps them for recovery next time.
    await discardRecoveryFor(dirty.map((s) => s.doc.id));
    return true;
  }
  for (const s of dirty) {
    if (!(await saveSession(s.doc.id))) return false;
  }
  return true;
}

/**
 * A file handed over by the OS (Explorer/Finder double-click, a second instance, the command line).
 * A project that is already open switches to its tab instead of opening a second copy (io openFile →
 * focusOpenProject, the same rule as File ▸ Open and Open Recent).
 */
export async function openFromOS(file: OpenedFile): Promise<void> {
  await openFileWithIo(file, { asNewDocument: true });
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
    unsubs.push(desktop.onOpenFile((file) => void openFromOS(file)));
    unsubs.push(
      desktop.onCloseRequested(async () => {
        if (closing) return;
        closing = true;
        // While the prompt is open, bring the autosaved copies up to date: if the user ends up forcing
        // the quit ("Quit Anyway" from the main process), the next start offers the latest state.
        if (dirtySessions().length) autosaveBeforeClose();
        let ok = false;
        try {
          ok = await confirmQuit();
        } catch (e) {
          // Always answer the main process: a broken prompt must not leave the window unclosable.
          console.error('[shell] close prompt failed', e);
          // Not the user's Discard: the autosaved copies are brought up to date first, kept, and offered
          // the next time.
          ok = window.confirm(
            'Perseverance could not show the unsaved-changes prompt. Quit anyway? Unsaved changes are not saved to their files. Perseverance first tries to autosave them, and the next start offers to recover the autosaved copy (if autosave is on).',
          );
          if (ok) await flushRecovery().catch(() => undefined);
        } finally {
          closing = false;
          desktop!.confirmClose(ok);
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
