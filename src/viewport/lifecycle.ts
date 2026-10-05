/**
 * Module-level store watchers (installed once on import):
 *  - tool lifecycle: calls onDeactivate/onActivate when the active tool changes and resets the
 *    cursor override;
 *  - free-transform watchdog: a command committing on top of a live Free Transform preview gets
 *    the transform split into its own history step first; switching to another document applies
 *    the transform to its own document (like the type tool commits text); a session whose
 *    history moved underneath it otherwise (undo/redo, its document closed) is dropped;
 *  - remembers the last selection per document for Select ▸ Reselect.
 */
import type { ID, Selection } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { tools } from '../registry';
import { viewport } from '../editor/viewport';
import { useEditor } from '../state/editor';
import { abandonTransform, absorbForeignCommit, activeTransform, commitTransformInOwnDoc, isTransformRebasing } from './transform/controller';
import { clearSmartGuides } from './snap';
import { vpState } from './state';

const lastSelection = new Map<ID, Selection>();

/** The selection a document had before it was last deselected (null if none / bitmap gone). */
export function lastSelectionFor(docId: ID): Selection | null {
  const s = lastSelection.get(docId);
  if (!s || !bitmaps.has(s.bitmapId)) return null;
  return s;
}

let installed = false;
let pendingOwnDocCommit = false;

function install() {
  if (installed) return;
  installed = true;
  useEditor.subscribe((st, prev) => {
    /* tool lifecycle */
    if (st.activeTool !== prev.activeTool) {
      const before = tools.get(prev.activeTool);
      const after = tools.get(st.activeTool);
      try {
        before?.onDeactivate?.();
      } catch (err) {
        console.error(`[viewport] ${prev.activeTool}.onDeactivate failed`, err);
      }
      vpState.hoverLayerId = null;
      vpState.suppressAnts = false;
      clearSmartGuides();
      viewport.setCursor(null);
      try {
        after?.onActivate?.();
      } catch (err) {
        console.error(`[viewport] ${st.activeTool}.onActivate failed`, err);
      }
      viewport.requestOverlay();
    }

    /* free transform watchdog */
    const ses = activeTransform();
    if (ses && !isTransformRebasing()) {
      const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
      if (!s || s.doc.id !== ses.docId) {
        if (!st.sessions[ses.docId]) abandonTransform();
        else if (!pendingOwnDocCommit) {
          // Document switch: apply the transform in its own document. Deferred to a microtask so
          // the commit (and the temporary document hop it needs) doesn't run inside this store
          // notification; nothing renders before microtasks run.
          pendingOwnDocCommit = true;
          queueMicrotask(() => {
            pendingOwnDocCommit = false;
            // (Still away from its document — a synchronous switch back just keeps transforming.)
            if (activeTransform() === ses && useEditor.getState().activeDocId !== ses.docId) commitTransformInOwnDoc();
          });
        }
      } else {
        const cur = s.history.entries[s.history.index];
        if (cur?.id !== ses.baseEntryId || cur.doc !== ses.baseDoc) {
          // Another command committed on top of the live preview → give the transform its own
          // step first; anything else (undo/redo/history jump) simply ends the session.
          if (!absorbForeignCommit(prev)) abandonTransform();
        }
      }
    }

    /* reselect memory */
    if (st.sessions !== prev.sessions) {
      for (const id of Object.keys(st.sessions)) {
        const a = st.sessions[id];
        const b = prev.sessions[id];
        if (!a || !b || a.doc === b.doc) continue;
        const was = b.history.entries[b.history.index]?.doc.selection;
        const now = a.history.entries[a.history.index]?.doc.selection;
        if (was && !now) lastSelection.set(id, was);
      }
      for (const id of [...lastSelection.keys()]) if (!st.sessions[id]) lastSelection.delete(id);
    }
  });
}

install();
