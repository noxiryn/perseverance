/**
 * Pure history surgery used when another module commits while a Free Transform preview is live.
 *
 * The editor store produces every commit from the session's current document — which, during a
 * Free Transform, carries the uncommitted transform preview. The transform therefore silently
 * becomes part of the unrelated step. `splitForeignCommit` rewrites the history so the transform
 * gets its own step right before the foreign one:
 *
 *   [… base, foreign(previewDoc + change)]  →  [… base, transform(previewDoc), foreign]
 *
 * It also handles a foreign commit that coalesced into the base step (same label, < 1 s old).
 * Unit-tested (no DOM).
 */
import type { Document, HistoryEntry, ID } from '../../core/types';

export interface HistoryState {
  entries: HistoryEntry[];
  index: number;
  savedIndex: number;
}

export interface SplitInput {
  /** History after the foreign commit. */
  history: HistoryState;
  /** Ids of all entries that existed before the foreign commit. */
  knownIds: ReadonlySet<ID>;
  baseEntryId: ID;
  /** Document of the base step when the transform session started. */
  baseDoc: Document;
  /** The previewed (transformed) document the foreign commit was produced from. */
  previewDoc: Document;
  label: string;
  newId: () => ID;
  limit: number;
}

/** The split history, or null when the change is not a plain commit on top of the preview. */
export function splitForeignCommit(inp: SplitInput): HistoryState | null {
  const { history, knownIds, baseEntryId } = inp;
  const { entries, index } = history;
  const cur = entries[index];
  if (!cur || index !== entries.length - 1) return null;
  let baseIdx: number;
  let base: HistoryEntry;
  let foreign: HistoryEntry;
  if (!knownIds.has(cur.id) && entries[index - 1]?.id === baseEntryId) {
    // A new step was pushed on top of the base step.
    baseIdx = index - 1;
    base = entries[baseIdx];
    foreign = cur;
  } else if (cur.id === baseEntryId && cur.doc !== inp.baseDoc) {
    // The commit coalesced into the base step (the store only coalesces patch-less steps):
    // restore the base and re-add the change as its own step.
    baseIdx = index;
    base = { ...cur, doc: inp.baseDoc };
    foreign = { ...cur, id: inp.newId() };
  } else return null;
  const transform: HistoryEntry = { id: inp.newId(), label: inp.label, doc: inp.previewDoc, timestamp: Math.min(foreign.timestamp, Date.now()) };
  let next = [...entries.slice(0, baseIdx), base, transform, foreign];
  let savedIndex = history.savedIndex > baseIdx ? history.savedIndex + 1 : history.savedIndex;
  if (next.length > inp.limit) {
    const drop = next.length - inp.limit;
    next = next.slice(drop);
    savedIndex -= drop;
  }
  return { entries: next, index: next.length - 1, savedIndex };
}
