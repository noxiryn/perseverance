/**
 * "<label> completed." toasts whenever a NEW history entry is committed in the active document.
 * Skips coalesced updates (same entry id), undo/redo, document switches, continuous painting
 * strokes (throttled), and respects the 'toasts' preference.
 */
import { useEditor, type EditorState } from '../../state/editor';
import { toast, useUI } from '../../state/ui';
import { getPref } from './prefs';

export interface HistorySnapshot {
  docId: string | null;
  entryId: string | null;
  label: string;
  index: number;
  length: number;
}

export function snapshotOf(st: Pick<EditorState, 'activeDocId' | 'sessions'>): HistorySnapshot {
  const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
  if (!s) return { docId: null, entryId: null, label: '', index: -1, length: 0 };
  const e = s.history.entries[s.history.index];
  return { docId: st.activeDocId, entryId: e?.id ?? null, label: e?.label ?? '', index: s.history.index, length: s.history.entries.length };
}

/** Labels produced by continuous interactions that should not toast every time. */
const CONTINUOUS = /^(brush|pencil|eraser|erase|smudge|dodge|burn|sponge|clone|blur brush|sharpen brush|blur tool|sharpen tool|paint|stroke|nudge|move|scrub|draw)\b/i;

export interface ToastDecisionState {
  seen: Set<string>;
  lastToastAt: number;
  lastLabel: string;
  lastLabelAt: number;
}

/**
 * Decide whether the transition prev → next is a fresh commit that deserves a toast.
 * Returns the label to announce, or null. Mutates `state.seen`.
 */
export function decideHistoryToast(prev: HistorySnapshot, next: HistorySnapshot, state: ToastDecisionState, now: number): string | null {
  if (!next.docId || !next.entryId) return null;
  const isNewId = !state.seen.has(next.entryId);
  state.seen.add(next.entryId);
  if (state.seen.size > 2000) {
    // Bound memory: keep the most recent half.
    const keep = [...state.seen].slice(-1000);
    state.seen.clear();
    keep.forEach((id) => state.seen.add(id));
  }
  if (prev.docId !== next.docId) return null; // switched / opened a document
  if (prev.entryId === next.entryId) return null; // coalesced or unrelated change
  if (!isNewId) return null; // undo/redo to an existing entry
  if (next.index !== next.length - 1) return null;
  if (next.index <= 0) return null;
  const label = next.label.trim();
  if (!label) return null;
  if (CONTINUOUS.test(label)) {
    // Continuous edits: at most one toast per 6s per label.
    if (label === state.lastLabel && now - state.lastLabelAt < 6000) return null;
  } else if (label === state.lastLabel && now - state.lastLabelAt < 1200) return null;
  if (now - state.lastToastAt < 350) return null;
  state.lastToastAt = now;
  state.lastLabel = label;
  state.lastLabelAt = now;
  return label;
}

/** Message for a label: 'Delete Layer' → 'Delete Layer completed.' */
export function completedMessage(label: string): string {
  const clean = label.replace(/[.…]+$/, '');
  return `${clean} completed.`;
}

let installed = false;

/** Start watching the editor store. Idempotent. */
export function installHistoryToasts() {
  if (installed) return;
  installed = true;
  const state: ToastDecisionState = { seen: new Set(), lastToastAt: 0, lastLabel: '', lastLabelAt: 0 };
  // Mark all existing entries as seen.
  const markAll = (st: EditorState) => {
    for (const s of Object.values(st.sessions)) for (const e of s.history.entries) state.seen.add(e.id);
  };
  markAll(useEditor.getState());
  let prevSnap = snapshotOf(useEditor.getState());
  let prevSessions = useEditor.getState().sessions;

  // Track when other modules show their own toasts so we do not double-announce.
  let lastForeignToastAt = 0;
  let ownToast = false;
  useUI.subscribe((s, p) => {
    if (s.toasts.length > p.toasts.length && !ownToast) lastForeignToastAt = Date.now();
  });

  useEditor.subscribe((st) => {
    if (st.sessions !== prevSessions) {
      // Newly opened documents: their initial entries are not commits.
      for (const [id, s] of Object.entries(st.sessions)) {
        if (!prevSessions[id]) s.history.entries.forEach((e) => state.seen.add(e.id));
      }
      prevSessions = st.sessions;
    }
    const next = snapshotOf(st);
    const prev = prevSnap;
    prevSnap = next;
    if (next.entryId === prev.entryId && next.docId === prev.docId) return;
    const label = decideHistoryToast(prev, next, state, Date.now());
    if (!label || !getPref('toasts', true)) return;
    // Let the committing code show its own toast first; skip ours if it did.
    window.setTimeout(() => {
      if (Date.now() - lastForeignToastAt < 600) return;
      ownToast = true;
      try {
        toast(completedMessage(label), 'success', 2200);
      } finally {
        ownToast = false;
      }
    }, 60);
  });
}
