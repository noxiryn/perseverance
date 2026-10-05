import { describe, expect, it } from 'vitest';
import type { BitmapPatch, HistoryEntry } from '../../../core/types';
import { historyDiff, patchesForBitmap } from './guard';

const fakeImage = (tag: string) => ({ tag }) as unknown as ImageData;

function patch(bitmapId: string, tag: string): BitmapPatch {
  return { bitmapId, x: 0, y: 0, before: fakeImage(`${tag}-before`), after: fakeImage(`${tag}-after`) };
}

function entry(id: string, patches?: BitmapPatch[]): HistoryEntry {
  return { id, label: id, doc: {} as HistoryEntry['doc'], patches, timestamp: 0 };
}

const tags = (list: { patch: BitmapPatch; side: 'before' | 'after' }[]) => list.map(({ patch, side }) => (side === 'before' ? patch.before : patch.after) as unknown as { tag: string }).map((t) => t.tag);

describe('historyDiff', () => {
  const e = [entry('h0'), entry('h1', [patch('A', 'p1')]), entry('h2', [patch('A', 'p2a'), patch('B', 'p2b'), patch('A', 'p2c')]), entry('h3')];

  it('undo: entries reverted newest first, nothing applied', () => {
    const d = historyDiff(e, 3, e, 1)!;
    expect(d.undone.map((x) => x.id)).toEqual(['h3', 'h2']);
    expect(d.applied).toEqual([]);
  });

  it('redo: entries applied oldest first', () => {
    const d = historyDiff(e, 1, e, 3)!;
    expect(d.undone).toEqual([]);
    expect(d.applied.map((x) => x.id)).toEqual(['h2', 'h3']);
  });

  it('new commit after an undo (branch replaced)', () => {
    const next = [e[0], e[1], entry('h9')];
    const d = historyDiff(e, 3, next, 2)!;
    expect(d.undone.map((x) => x.id)).toEqual(['h3', 'h2']);
    expect(d.applied.map((x) => x.id)).toEqual(['h9']);
  });

  it('survives front trimming (ids, not indices)', () => {
    const trimmed = [e[1], e[2], e[3], entry('h4')];
    const d = historyDiff(e, 3, trimmed, 3)!;
    expect(d.undone).toEqual([]);
    expect(d.applied.map((x) => x.id)).toEqual(['h4']);
  });

  it('returns null without a common entry', () => {
    expect(historyDiff(e, 3, [entry('x')], 0)).toBeNull();
  });
});

describe('patchesForBitmap', () => {
  it('replays one bitmap exactly like undo/redo do (reverse order + before side when undoing)', () => {
    const e2 = entry('h2', [patch('A', 'p2a'), patch('B', 'p2b'), patch('A', 'p2c')]);
    const e3 = entry('h3', [patch('A', 'p3')]);
    expect(tags(patchesForBitmap({ undone: [e3, e2], applied: [] }, 'A'))).toEqual(['p3-before', 'p2c-before', 'p2a-before']);
    expect(tags(patchesForBitmap({ undone: [], applied: [e2, e3] }, 'A'))).toEqual(['p2a-after', 'p2c-after', 'p3-after']);
    expect(tags(patchesForBitmap({ undone: [e2], applied: [] }, 'B'))).toEqual(['p2b-before']);
  });
});
