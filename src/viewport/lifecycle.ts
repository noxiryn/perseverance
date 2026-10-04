/**
 * Module-level store watchers (installed once on import):
 *  - tool lifecycle: calls onDeactivate/onActivate when the active tool changes and resets the
 *    cursor override;
 *  - free-transform watchdog: drops a session whose document/history moved underneath it
 *    (document switch, undo/redo, another command committing);
 *  - remembers the last selection per document for Select ▸ Reselect.
 */
import type { ID, Selection } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { tools } from '../registry';
import { viewport } from '../editor/viewport';
import { useEditor } from '../state/editor';
import { abandonTransform, activeTransform } from './transform/controller';
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
    if (ses) {
      const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
      if (!s || s.doc.id !== ses.docId) abandonTransform(ses.docId);
      else if (s.history.entries[s.history.index]?.id !== ses.baseEntryId) abandonTransform();
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
