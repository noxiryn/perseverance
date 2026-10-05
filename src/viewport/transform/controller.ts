/**
 * Free Transform / Transform Selection controller: owns the active (session-mode) transform and
 * exposes it reactively for the move tool's options bar.
 */
import { create } from 'zustand';
import { uid } from '../../core/ids';
import { HISTORY_LIMIT, activeSession, useEditor, type EditorState } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { TransformSession, lastTransformDelta } from './session';
import { splitForeignCommit } from './historySplit';
import { requireDoc } from '../state';

interface TransformStoreState {
  session: TransformSession | null;
  /** Bumped on every geometry change so the options bar re-renders. */
  rev: number;
  /** Tool to restore after the session ends (free transform temporarily activates the move tool). */
  prevTool: string | null;
}

export const useTransformStore = create<TransformStoreState>()(() => ({ session: null, rev: 0, prevTool: null }));

export function activeTransform(): TransformSession | null {
  return useTransformStore.getState().session;
}

function install(ses: TransformSession) {
  ses.onChange = () => useTransformStore.setState((s) => ({ rev: s.rev + 1 }));
  const st = useEditor.getState();
  const prevTool = st.activeTool !== 'move' ? st.activeTool : null;
  useTransformStore.setState({ session: ses, prevTool, rev: useTransformStore.getState().rev + 1 });
  if (prevTool) st.setTool('move');
  viewport.requestOverlay();
}

function uninstall(): { ses: TransformSession | null; prevTool: string | null } {
  const { session, prevTool } = useTransformStore.getState();
  if (session) session.onChange = null;
  useTransformStore.setState({ session: null, prevTool: null });
  viewport.requestOverlay();
  return { ses: session, prevTool };
}

function restoreTool(prevTool: string | null) {
  if (prevTool && useEditor.getState().activeTool === 'move') useEditor.getState().setTool(prevTool);
}

/** Edit ▸ Free Transform (and Transform ▸ Scale/Rotate/Skew). */
export function startFreeTransform(opts: { skew?: boolean } = {}) {
  const doc = requireDoc('Free Transform');
  if (!doc) return;
  const cur = activeTransform();
  if (cur) {
    if (opts.skew) cur.skewMode = true;
    viewport.requestOverlay();
    return;
  }
  const s = activeSession()!;
  const ids = s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
  if (!ids.length) {
    toast('Select a layer to transform.', 'info');
    return;
  }
  const res = TransformSession.forLayers(doc, ids, 'session');
  if (typeof res === 'string') {
    toast(res, 'warning');
    return;
  }
  res.skewMode = !!opts.skew;
  install(res);
}

/** Select ▸ Transform Selection. */
export function startSelectionTransform() {
  const doc = requireDoc('Transform Selection');
  if (!doc) return;
  if (activeTransform()) commitTransform();
  const res = TransformSession.forSelection(doc);
  if (typeof res === 'string') {
    toast(res, 'info');
    return;
  }
  install(res);
}

export function commitTransform() {
  const { ses, prevTool } = uninstall();
  if (ses) ses.commit();
  restoreTool(prevTool);
}

export function cancelTransform() {
  const { ses, prevTool } = uninstall();
  if (ses) ses.cancel();
  restoreTool(prevTool);
}

/**
 * Commit a running Free Transform / Transform Selection (if any) as its own history step. Call
 * before a command changes the document so the transform is not swallowed by that step.
 */
export function settleTransform() {
  if (activeTransform()) commitTransform();
}

let rebasing = false;

/** True while commitBesideTransform runs (the lifecycle watchdog then leaves the session alone). */
export function isTransformRebasing(): boolean {
  return rebasing;
}

/**
 * Run a document commit (e.g. adding a guide) WITHOUT ending a running transform session: the
 * live preview is lifted, `commit` runs on the clean document, and the session continues on top
 * of the new history step.
 */
export function commitBesideTransform(commit: () => void) {
  const ses = activeTransform();
  const s = activeSession();
  if (!ses || !s || s.doc.id !== ses.docId) {
    commit();
    return;
  }
  rebasing = true;
  try {
    if (ses.previewed) useEditor.getState().cancelPreview();
    commit();
  } finally {
    rebasing = false;
  }
  const after = activeSession();
  if (!after || after.doc.id !== ses.docId || activeTransform() !== ses) return;
  ses.rebase(after.history.entries[after.history.index]);
  if (ses.previewed) ses.applyPreview();
  viewport.requestOverlay();
}

/**
 * Another module committed a history step while a Free Transform preview was live. The store
 * produced that step from the previewed document, so the transform is already inside it: split it
 * into its own "Free Transform" step right before the foreign one, end the session and tell the
 * user. Returns false when the change is not a plain commit on top of the preview (the caller then
 * just drops the session).
 */
export function absorbForeignCommit(prev: EditorState): boolean {
  const ses = activeTransform();
  if (!ses || ses.kind !== 'layers' || !ses.previewed) return false;
  const a = useEditor.getState().sessions[ses.docId];
  const b = prev.sessions[ses.docId];
  if (!a || !b) return false;
  const before = b.history.entries[b.history.index];
  // The preview must have been live on top of the base step right before this change.
  if (!before || before.id !== ses.baseEntryId || b.doc === before.doc) return false;
  const split = splitForeignCommit({
    history: { entries: a.history.entries, index: a.history.index, savedIndex: a.savedIndex },
    knownIds: new Set(b.history.entries.map((e) => e.id)),
    baseEntryId: ses.baseEntryId,
    baseDoc: ses.baseDoc,
    previewDoc: b.doc,
    label: ses.label,
    newId: () => uid('h_'),
    limit: HISTORY_LIMIT,
  });
  if (!split) return false;
  const foreignLabel = split.entries[split.index].label;
  const { prevTool } = uninstall();
  ses.recordDelta();
  ses.previewed = false;
  useEditor.setState((cur) => ({
    sessions: {
      ...cur.sessions,
      [ses.docId]: { ...a, history: { entries: split.entries, index: split.index }, savedIndex: split.savedIndex, dirty: split.index !== split.savedIndex },
    },
  }));
  restoreTool(prevTool);
  toast(`${ses.label} was applied before “${foreignLabel}”.`, 'info');
  return true;
}

/**
 * Drop the session without touching the document (the history moved underneath it, e.g. undo,
 * or the user switched documents). If the doc still carries the live preview, revert it.
 */
export function abandonTransform(revertDocId?: string) {
  const { ses } = uninstall();
  if (!ses || !revertDocId) return;
  const st = useEditor.getState();
  const s = st.sessions[revertDocId];
  if (!s) return;
  const base = s.history.entries[s.history.index].doc;
  if (s.doc !== base) useEditor.setState({ sessions: { ...st.sessions, [revertDocId]: { ...s, doc: base } } });
}

/** Edit ▸ Transform ▸ Again: re-apply the last transform to the current layer(s). */
export function transformAgain() {
  const doc = requireDoc('Transform Again');
  if (!doc) return;
  const L = lastTransformDelta();
  if (!L) {
    toast('No previous transform to repeat.', 'info');
    return;
  }
  if (activeTransform()) commitTransform();
  const s = activeSession()!;
  const ids = s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
  const res = TransformSession.forLayers(doc, ids, 'immediate', 'Transform Again');
  if (typeof res === 'string') {
    toast(res, 'warning');
    return;
  }
  res.applyLocal(L);
  res.commit();
}
