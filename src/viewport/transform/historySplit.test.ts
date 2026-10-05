import { describe, expect, it } from 'vitest';
import type { Document, HistoryEntry } from '../../core/types';
import { splitForeignCommit } from './historySplit';

// Documents are only compared by identity here.
const doc = (name: string) => ({ name }) as unknown as Document;
const entry = (id: string, label: string, d: Document, timestamp = 1000): HistoryEntry => ({ id, label, doc: d, timestamp });

let n = 0;
const newId = () => `new${++n}`;

describe('splitForeignCommit (Free Transform + foreign commit)', () => {
  const open = doc('open');
  const base = doc('base');
  const preview = doc('preview'); // base + live transform
  const foreignDoc = doc('foreign'); // preview + "New Layer"

  it('inserts the transform as its own step before a pushed foreign step', () => {
    const before = [entry('h0', 'Open', open), entry('h1', 'Brush', base)];
    const after = [...before, entry('h2', 'New Layer', foreignDoc, 5000)];
    const r = splitForeignCommit({
      history: { entries: after, index: 2, savedIndex: 0 },
      knownIds: new Set(before.map((e) => e.id)),
      baseEntryId: 'h1',
      baseDoc: base,
      previewDoc: preview,
      label: 'Free Transform',
      newId,
      limit: 80,
    });
    expect(r).not.toBeNull();
    expect(r!.entries.map((e) => e.label)).toEqual(['Open', 'Brush', 'Free Transform', 'New Layer']);
    expect(r!.entries[2].doc).toBe(preview);
    expect(r!.entries[3].doc).toBe(foreignDoc);
    expect(r!.entries[1].doc).toBe(base);
    expect(r!.index).toBe(3);
    expect(r!.savedIndex).toBe(0);
  });

  it('undoes a coalesce into the base step', () => {
    const before = [entry('h0', 'Open', open), entry('h1', 'Nudge', base)];
    const after = [before[0], { ...before[1], doc: foreignDoc, timestamp: 1500 }];
    const r = splitForeignCommit({
      history: { entries: after, index: 1, savedIndex: 1 },
      knownIds: new Set(before.map((e) => e.id)),
      baseEntryId: 'h1',
      baseDoc: base,
      previewDoc: preview,
      label: 'Free Transform',
      newId,
      limit: 80,
    });
    expect(r!.entries.map((e) => [e.label, (e.doc as unknown as { name: string }).name])).toEqual([
      ['Open', 'open'],
      ['Nudge', 'base'],
      ['Free Transform', 'preview'],
      ['Nudge', 'foreign'],
    ]);
    expect(r!.entries[1].id).toBe('h1');
    expect(r!.entries[3].id).not.toBe('h1');
    expect(r!.savedIndex).toBe(1);
  });

  it('ignores redo and unrelated history moves', () => {
    const entries = [entry('h0', 'Open', open), entry('h1', 'Brush', base), entry('h2', 'Old step', foreignDoc)];
    // redo: the entry after the base already existed
    expect(
      splitForeignCommit({
        history: { entries, index: 2, savedIndex: 0 },
        knownIds: new Set(entries.map((e) => e.id)),
        baseEntryId: 'h1',
        baseDoc: base,
        previewDoc: preview,
        label: 'Free Transform',
        newId,
        limit: 80,
      }),
    ).toBeNull();
    // undo below the base
    expect(
      splitForeignCommit({
        history: { entries, index: 0, savedIndex: 0 },
        knownIds: new Set(entries.map((e) => e.id)),
        baseEntryId: 'h1',
        baseDoc: base,
        previewDoc: preview,
        label: 'Free Transform',
        newId,
        limit: 80,
      }),
    ).toBeNull();
  });

  it('respects the history limit', () => {
    const before = [entry('h0', 'Open', open), entry('h1', 'A', base)];
    const after = [...before, entry('h2', 'B', foreignDoc)];
    const r = splitForeignCommit({
      history: { entries: after, index: 2, savedIndex: 1 },
      knownIds: new Set(before.map((e) => e.id)),
      baseEntryId: 'h1',
      baseDoc: base,
      previewDoc: preview,
      label: 'Free Transform',
      newId,
      limit: 3,
    });
    expect(r!.entries.map((e) => e.label)).toEqual(['A', 'Free Transform', 'B']);
    expect(r!.index).toBe(2);
    expect(r!.savedIndex).toBe(0);
  });
});
