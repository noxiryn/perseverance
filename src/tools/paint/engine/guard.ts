/**
 * Stroke guard: protects history while a stroke is live.
 *
 * A live stroke paints straight into the layer bitmap and records its patch on release. If the
 * history moves underneath it (undo/redo/another commit) or the active document changes, the
 * stroke's before-image is stale and committing it would corrupt history. The guard watches
 * the editor store for exactly those changes; when one happens it kills the session, puts the
 * stroke-start pixels back and replays the bitmap patches the history change applied (so the
 * bitmap ends up exactly in the new history state), then tells the tool to drop the stroke.
 *
 * Tools also commit their stroke before letting a non-modifier key through to the shell (see
 * stampTool/retouch/gradient onKeyDown), so this is the safety net, not the common path.
 */
import type { BitmapPatch, HistoryEntry, ID } from '../../../core/types';
import { bitmaps } from '../../../core/bitmaps';
import { ctx2d } from '../../../core/canvas';
import { viewport } from '../../../editor/viewport';
import { useEditor } from '../../../state/editor';
import type { PaintTarget } from './target';

/** Minimal session surface the guard needs. */
export interface GuardedSession {
  readonly target: PaintTarget;
  /** Stop live updates (cancel the pending frame) without touching pixels or history. */
  kill(): void;
  /** Put the stroke-start pixels back over everything the session touched (no history). */
  restoreBefore(): void;
}

export interface HistoryDiff {
  /** Entries undone, in the order they must be reverted (newest first). */
  undone: HistoryEntry[];
  /** Entries applied, in order (oldest first). */
  applied: HistoryEntry[];
}

/**
 * What changed between two history states of one document: the entries reverted since the
 * latest common entry (matched by id, robust to front trimming) and the entries applied after
 * it. Returns null when the two states share no entry.
 */
export function historyDiff(oldEntries: HistoryEntry[], oldIndex: number, newEntries: HistoryEntry[], newIndex: number): HistoryDiff | null {
  const pos = new Map<ID, number>();
  for (let j = 0; j <= Math.min(newIndex, newEntries.length - 1); j++) pos.set(newEntries[j].id, j);
  for (let k = Math.min(oldIndex, oldEntries.length - 1); k >= 0; k--) {
    const j = pos.get(oldEntries[k].id);
    if (j === undefined) continue;
    const undone: HistoryEntry[] = [];
    for (let i = Math.min(oldIndex, oldEntries.length - 1); i > k; i--) undone.push(oldEntries[i]);
    const applied: HistoryEntry[] = [];
    for (let i = j + 1; i <= Math.min(newIndex, newEntries.length - 1); i++) applied.push(newEntries[i]);
    return { undone, applied };
  }
  return null;
}

/** The patch sides (in application order) that a history diff applied to one bitmap. */
export function patchesForBitmap(diff: HistoryDiff, bitmapId: ID): { patch: BitmapPatch; side: 'before' | 'after' }[] {
  const out: { patch: BitmapPatch; side: 'before' | 'after' }[] = [];
  for (const e of diff.undone) {
    const ps = e.patches ?? [];
    for (let i = ps.length - 1; i >= 0; i--) if (ps[i].bitmapId === bitmapId) out.push({ patch: ps[i], side: 'before' });
  }
  for (const e of diff.applied) for (const p of e.patches ?? []) if (p.bitmapId === bitmapId) out.push({ patch: p, side: 'after' });
  return out;
}

/** Restore a session's before-image when its target bitmap still exists. Returns true if pixels changed. */
export function restoreIfAlive(session: GuardedSession): boolean {
  const t = session.target;
  if (bitmaps.tryGet(t.bitmapId) !== t.canvas) return false;
  session.restoreBefore();
  bitmaps.touch(t.bitmapId);
  viewport.requestRender();
  return true;
}

/**
 * Watch the editor store while a stroke is live. `onAbort(message)` runs (once) after the
 * session was killed and the bitmap repaired. Returns the disposer — call it before the
 * session commits or cancels.
 */
export function watchStroke(session: GuardedSession, onAbort: (message: string) => void): () => void {
  const t = session.target;
  const start = useEditor.getState().sessions[t.docId];
  if (!start) return () => {};
  const hist0 = start.history;
  const entries0 = hist0.entries;
  const index0 = hist0.index;
  let done = false;

  const unsub = useEditor.subscribe((st) => {
    if (done) return;
    const s = st.sessions[t.docId];
    const docSwitched = st.activeDocId !== t.docId;
    const historyMoved = !s || s.history !== hist0;
    if (!docSwitched && !historyMoved) return;
    done = true;
    unsub();
    session.kill();
    const canvas = bitmaps.tryGet(t.bitmapId);
    if (canvas === t.canvas) {
      session.restoreBefore();
      if (s && historyMoved) {
        // Re-apply what the history change did to this bitmap on top of the stroke-start pixels.
        const diff = historyDiff(entries0, index0, s.history.entries, s.history.index);
        if (diff) {
          const ctx = ctx2d(canvas);
          for (const { patch, side } of patchesForBitmap(diff, t.bitmapId)) {
            ctx.putImageData(side === 'before' ? patch.before : patch.after, patch.x, patch.y);
          }
        }
      }
      bitmaps.touch(t.bitmapId);
      viewport.requestRender();
    }
    onAbort(!s ? 'Stroke discarded — the document was closed' : docSwitched ? 'Stroke discarded — the document changed' : 'Stroke discarded — history changed while painting');
  });

  return () => {
    done = true;
    unsub();
  };
}

/** Modifier-only keys never interrupt a stroke (Shift = axis lock, Alt = clone source…). */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);

export function isModifierKey(e: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(e.key);
}
