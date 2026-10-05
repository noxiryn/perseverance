import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeRasterLayer } from '../core/document';
import type { DialogEntry } from './ui';
import { useUI } from './ui';
import { BITMAP_GC_GRACE_MS, HISTORY_LIMIT, cancelBitmapGc, gcBitmaps, referencedBitmaps, requestBitmapGc, useEditor } from './editor';

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
