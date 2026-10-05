import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeRasterLayer } from '../core/document';
import type { DialogEntry } from './ui';
import { useUI } from './ui';
import {
  BITMAP_GC_GRACE_MS,
  HISTORY_LIMIT,
  cancelBitmapGc,
  gcBitmaps,
  referencedBitmaps,
  requestBitmapGc,
  savedIndexOf,
  useEditor,
} from './editor';

/** A bitmap without pixels (jsdom has no 2D context; the store only needs the canvas object). */
const newBitmap = () => bitmaps.add(document.createElement('canvas'));

function openDocWithLayer() {
  const doc = createDocument({ name: 'Doc', width: 8, height: 8, background: null });
  const bmp = newBitmap();
  const layer = makeRasterLayer({ name: 'Layer', bitmapId: bmp, width: 8, height: 8 });
  insertLayerDraft(doc, layer, {});
  useEditor.getState().openDocument(doc);
  return { docId: doc.id, layerId: layer.id, bmp };
}

function closeAll() {
  const st = useEditor.getState();
  for (const id of [...st.docOrder]) st.closeDocument(id);
}

describe('bitmap garbage collection', () => {
  beforeEach(() => {
    closeAll();
    cancelBitmapGc();
  });
  afterEach(() => {
    vi.useRealTimers();
    useUI.setState({ dialogs: [] });
    closeAll();
    cancelBitmapGc();
  });

  it('frees a closed document’s bitmaps immediately, even when they are young', () => {
    const a = openDocWithLayer();
    const b = openDocWithLayer();
    expect(bitmaps.has(a.bmp)).toBe(true);
    useEditor.getState().closeDocument(a.docId);
    expect(bitmaps.has(a.bmp)).toBe(false);
    // The other document's pixels stay.
    expect(bitmaps.has(b.bmp)).toBe(true);
  });

  it('keeps bitmaps still referenced by another open document', () => {
    const a = openDocWithLayer();
    const b = openDocWithLayer();
    // Document B also uses A's bitmap (e.g. a shared mask) through a committed step.
    useEditor.getState().setActiveDoc(b.docId);
    useEditor.getState().commit('Share', (d) => {
      const l = makeRasterLayer({ bitmapId: a.bmp, width: 8, height: 8 });
      insertLayerDraft(d, l, {});
    });
    useEditor.getState().closeDocument(a.docId);
    expect(bitmaps.has(a.bmp)).toBe(true);
  });

  it('frees pixels of a discarded redo branch on the next commit', () => {
    const a = openDocWithLayer();
    const resized = newBitmap();
    const st = useEditor.getState();
    st.commit('Image Size', (d) => {
      const l = d.layers[a.layerId];
      if (l.type === 'raster') l.bitmapId = resized;
    });
    st.undo();
    // Still reachable through redo.
    expect(bitmaps.has(resized)).toBe(true);
    useEditor.getState().updateLayer(a.layerId, { opacity: 0.5 }, 'Opacity');
    expect(bitmaps.has(resized)).toBe(false);
    expect(bitmaps.has(a.bmp)).toBe(true);
  });

  it('frees pixels of steps trimmed off the front of the history', () => {
    const a = openDocWithLayer();
    const st = useEditor.getState();
    const first = newBitmap();
    st.commit('Swap', (d) => {
      const l = d.layers[a.layerId];
      if (l.type === 'raster') l.bitmapId = first;
    });
    st.commit('Swap back', (d) => {
      const l = d.layers[a.layerId];
      if (l.type === 'raster') l.bitmapId = a.bmp;
    });
    for (let i = 0; i < HISTORY_LIMIT; i++) useEditor.getState().updateLayer(a.layerId, { opacity: (i % 10) / 10 + 0.05 }, `Step ${i}`);
    expect(bitmaps.has(first)).toBe(false);
    expect(bitmaps.has(a.bmp)).toBe(true);
  });

  it('never frees pinned bitmaps or young unreferenced ones immediately', () => {
    const a = openDocWithLayer();
    const pinned = newBitmap();
    bitmaps.pin(pinned);
    const toolOwned = newBitmap(); // created by a tool, not committed yet
    useEditor.getState().closeDocument(a.docId);
    expect(bitmaps.has(pinned)).toBe(true);
    expect(bitmaps.has(toolOwned)).toBe(true);
  });

  it('collects leftovers on the idle pass after the grace period, never pinned ones', () => {
    vi.useFakeTimers();
    const a = openDocWithLayer();
    const leftover = newBitmap(); // e.g. a cancelled preview's temporary bitmap
    const pinned = newBitmap();
    bitmaps.pin(pinned);
    cancelBitmapGc();
    useEditor.getState().updateLayer(a.layerId, { opacity: 0.4 }, 'Opacity'); // schedules a pass
    vi.advanceTimersByTime(BITMAP_GC_GRACE_MS + 1500);
    expect(bitmaps.has(leftover)).toBe(false);
    expect(bitmaps.has(pinned)).toBe(true);
    expect(bitmaps.has(a.bmp)).toBe(true);
  });

  it('postpones the idle pass while a dialog is open', () => {
    vi.useFakeTimers();
    openDocWithLayer();
    const held = newBitmap(); // e.g. a dialog's preview bitmap
    useUI.setState({ dialogs: [{ id: 'dlg' } as unknown as DialogEntry] });
    requestBitmapGc();
    vi.advanceTimersByTime(BITMAP_GC_GRACE_MS * 3);
    expect(bitmaps.has(held)).toBe(true);
    useUI.setState({ dialogs: [] });
    vi.advanceTimersByTime(6000);
    expect(bitmaps.has(held)).toBe(false);
  });

  it('keeps the pixels of a step replaced by coalescing while the gesture may still read them', () => {
    vi.useFakeTimers();
    const a = openDocWithLayer();
    const sel1 = newBitmap();
    const sel2 = newBitmap();
    const nudge = (id: string) =>
      useEditor.getState().commit(
        'Nudge Selection',
        (d) => {
          d.selection = { bitmapId: id, bounds: { x: 0, y: 0, width: 1, height: 1 } };
        },
        { coalesce: true },
      );
    cancelBitmapGc();
    vi.advanceTimersByTime(BITMAP_GC_GRACE_MS + 2000); // sel1 is old now
    useEditor.getState().commit('Nudge Selection', (d) => {
      d.selection = { bitmapId: sel1, bounds: { x: 0, y: 0, width: 1, height: 1 } };
    }); // a fresh step that the next press coalesces into
    nudge(sel2);
    expect(bitmaps.has(sel1)).toBe(true);
    gcBitmaps();
    expect(bitmaps.has(sel1)).toBe(true); // guarded for a few seconds
    vi.advanceTimersByTime(6000);
    cancelBitmapGc();
    gcBitmaps();
    expect(bitmaps.has(sel1)).toBe(false);
    expect(bitmaps.has(a.bmp)).toBe(true);
  });

  it('counts live previews as references', () => {
    const a = openDocWithLayer();
    const temp = newBitmap();
    useEditor.getState().preview((d) => {
      const l = d.layers[a.layerId];
      if (l.type === 'raster') l.bitmapId = temp;
    });
    expect(referencedBitmaps(useEditor.getState().sessions).has(temp)).toBe(true);
  });
});

describe('saved state (dirty flag)', () => {
  beforeEach(() => {
    closeAll();
    cancelBitmapGc();
  });
  afterEach(() => {
    closeAll();
    cancelBitmapGc();
  });

  const session = (id: string) => useEditor.getState().sessions[id];
  const current = (id: string) => {
    const s = session(id);
    return { entryId: s.history.entries[s.history.index].id, doc: s.history.entries[s.history.index].doc };
  };
  const setOpacity = (layerId: string, v: number, coalesce = true) =>
    useEditor.getState().commit(
      'Opacity',
      (d) => {
        d.layers[layerId].opacity = v;
      },
      coalesce ? { coalesce: true } : undefined,
    );

  it('coalesces repeated edits into one step while unsaved', () => {
    const a = openDocWithLayer();
    setOpacity(a.layerId, 0.9);
    setOpacity(a.layerId, 0.8);
    expect(session(a.docId).history.entries.map((e) => e.label)).toEqual(['Open', 'Opacity']);
  });

  it('never coalesces into the saved step: the edit gets its own step and the tab turns dirty', () => {
    const a = openDocWithLayer();
    setOpacity(a.layerId, 0.9);
    useEditor.getState().markSaved(a.docId);
    expect(session(a.docId).dirty).toBe(false);
    setOpacity(a.layerId, 0.8); // e.g. the next arrow-key nudge within the coalescing window
    const s = session(a.docId);
    expect(s.dirty).toBe(true);
    expect(s.history.entries).toHaveLength(3);
    expect(s.history.entries[s.savedIndex].doc.layers[a.layerId].opacity).toBe(0.9);
    // Undo returns to exactly the saved state.
    useEditor.getState().undo();
    expect(session(a.docId).dirty).toBe(false);
    // Further edits coalesce again (into the new, unsaved step).
    useEditor.getState().redo();
    setOpacity(a.layerId, 0.7);
    expect(session(a.docId).history.entries).toHaveLength(3);
  });

  it('marks a save done only if the step still holds the document that was written', () => {
    const a = openDocWithLayer();
    setOpacity(a.layerId, 0.9);
    const written = current(a.docId); // what an async save encoded
    setOpacity(a.layerId, 0.3); // coalesced into the same step during the encode
    expect(current(a.docId).entryId).toBe(written.entryId);
    useEditor.getState().markSaved(a.docId, written);
    expect(session(a.docId).dirty).toBe(true);
    expect(session(a.docId).savedIndex).toBe(-1);
    // Without a concurrent edit the same call marks the tab clean.
    useEditor.getState().markSaved(a.docId, current(a.docId));
    expect(session(a.docId).dirty).toBe(false);
  });

  it('keeps the tab dirty when the saved step was undone during the save', () => {
    const a = openDocWithLayer();
    setOpacity(a.layerId, 0.9, false);
    const written = current(a.docId);
    useEditor.getState().undo();
    useEditor.getState().markSaved(a.docId, written);
    expect(session(a.docId).savedIndex).toBe(1);
    expect(session(a.docId).dirty).toBe(true);
    useEditor.getState().redo();
    expect(session(a.docId).dirty).toBe(false);
  });

  it('forgets a saved step in a discarded redo branch', () => {
    const a = openDocWithLayer();
    setOpacity(a.layerId, 0.9, false);
    useEditor.getState().markSaved(a.docId); // saved at index 1
    useEditor.getState().undo();
    // A different edit lands at the saved step's old index — it is not the saved state.
    useEditor.getState().updateLayer(a.layerId, { visible: false }, 'Hide');
    const s = session(a.docId);
    expect(s.history.index).toBe(1);
    expect(s.savedIndex).toBe(-1);
    expect(s.dirty).toBe(true);
  });

  it('stays dirty when the saved step is trimmed off the front of the history', () => {
    const a = openDocWithLayer();
    useEditor.getState().markSaved(a.docId); // saved at index 0
    for (let i = 0; i <= HISTORY_LIMIT; i++) setOpacity(a.layerId, (i % 50) / 100, false);
    const s = session(a.docId);
    expect(s.history.entries).toHaveLength(HISTORY_LIMIT);
    expect(s.savedIndex).toBe(-1);
    expect(s.dirty).toBe(true);
    // Undoing all the way back never reaches a "clean" state.
    useEditor.getState().jumpToHistory(0);
    expect(session(a.docId).dirty).toBe(true);
  });

  it('savedIndexOf matches step id and document identity', () => {
    const a = openDocWithLayer();
    setOpacity(a.layerId, 0.9, false);
    const entries = session(a.docId).history.entries;
    expect(savedIndexOf(entries, { entryId: entries[1].id, doc: entries[1].doc })).toBe(1);
    expect(savedIndexOf(entries, { entryId: entries[1].id, doc: entries[0].doc })).toBe(-1);
    expect(savedIndexOf(entries, { entryId: 'h_gone', doc: entries[1].doc })).toBe(-1);
  });
});
