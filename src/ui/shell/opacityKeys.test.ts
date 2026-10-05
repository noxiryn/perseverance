import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, makeGroupLayer, makeRasterLayer } from '../../core/document';
import type { Document, ID } from '../../core/types';
import { useEditor } from '../../state/editor';
import { applyOpacityDigit, DIGIT_CHAIN_MS, digitOf, digitOpacity, opacityTargets, resetOpacityDigits } from './opacityKeys';

const raster = (name: string) => makeRasterLayer({ name, bitmapId: `bmp_${name}`, width: 8, height: 8 });

function makeDoc() {
  const doc: Document = createDocument({ width: 8, height: 8 });
  const a = raster('A');
  const b = raster('B');
  const inner = raster('Inner');
  const group = makeGroupLayer({ name: 'Locked group', childIds: [inner.id] });
  group.locks = { ...group.locks, all: true };
  for (const l of [a, b, inner, group]) doc.layers[l.id] = l;
  doc.rootIds.push(a.id, b.id, group.id);
  return { doc, a, b, inner, group };
}

function open(doc: Document, activeLayerId: ID) {
  for (const id of Object.keys(useEditor.getState().sessions)) useEditor.getState().closeDocument(id);
  useEditor.getState().openDocument(doc, { activeLayerId });
}

const session = () => {
  const st = useEditor.getState();
  return st.sessions[st.activeDocId!];
};

describe('digitOf', () => {
  it('reads main-row and numpad digits, including with Shift', () => {
    expect(digitOf({ code: 'Digit3', key: '3' })).toBe('3');
    expect(digitOf({ code: 'Digit3', key: '#' })).toBe('3');
    expect(digitOf({ code: 'Numpad0', key: '0' })).toBe('0');
    expect(digitOf({ code: 'KeyA', key: 'a' })).toBeNull();
    expect(digitOf({ code: '', key: '7' })).toBe('7');
  });
});

describe('digitOpacity', () => {
  it('maps single digits like Photoshop (0 = 100%)', () => {
    expect(digitOpacity(null, '3', 's', 0).value).toBeCloseTo(0.3);
    expect(digitOpacity(null, '0', 's', 0).value).toBe(1);
    expect(digitOpacity(null, '9', 's', 0).pair).toBe(false);
  });

  it('combines two quick digits into an exact percentage', () => {
    const first = digitOpacity(null, '4', 's', 1000);
    const second = digitOpacity(first.next, '5', 's', 1000 + DIGIT_CHAIN_MS - 1);
    expect(second.value).toBeCloseTo(0.45);
    expect(second.pair).toBe(true);
    expect(digitOpacity(digitOpacity(null, '0', 's', 0).next, '0', 's', 10).value).toBe(0);
    expect(digitOpacity(digitOpacity(null, '0', 's', 0).next, '5', 's', 10).value).toBeCloseTo(0.05);
    // A third digit starts over.
    expect(digitOpacity(second.next, '7', 's', 1100).value).toBeCloseTo(0.7);
  });

  it('does not chain across slow presses or a different scope', () => {
    const first = digitOpacity(null, '4', 's', 0);
    expect(digitOpacity(first.next, '5', 's', DIGIT_CHAIN_MS + 1).value).toBeCloseTo(0.5);
    expect(digitOpacity(first.next, '5', 'other', 10).value).toBeCloseTo(0.5);
  });
});

describe('opacityTargets', () => {
  it('skips locked layers and layers inside locked groups', () => {
    const { doc, a, inner, group } = makeDoc();
    expect(opacityTargets(doc, [a.id, inner.id], null)).toEqual({ ids: [a.id], locked: inner.id });
    expect(opacityTargets(doc, [group.id], null)).toEqual({ ids: [], locked: group.id });
    expect(opacityTargets(doc, [], a.id).ids).toEqual([a.id]);
  });
});

describe('applyOpacityDigit', () => {
  beforeEach(() => resetOpacityDigits());

  it('sets the opacity of the selected layers in one undoable step per value', () => {
    const { doc, a, b } = makeDoc();
    open(doc, a.id);
    useEditor.getState().setSelectedLayers([a.id, b.id]);
    const before = session().history.entries.length;
    expect(applyOpacityDigit('3', false, 10_000)).toBe(true);
    expect(session().doc.layers[a.id].opacity).toBeCloseTo(0.3);
    expect(session().doc.layers[b.id].opacity).toBeCloseTo(0.3);
    expect(session().history.entries.length).toBe(before + 1);
    // Second digit within the window: 35%, merged into the same history step.
    applyOpacityDigit('5', false, 10_200);
    expect(session().doc.layers[a.id].opacity).toBeCloseTo(0.35);
    expect(session().history.entries.length).toBe(before + 1);
    useEditor.getState().undo();
    expect(session().doc.layers[a.id].opacity).toBe(1);
  });

  it('sets fill with Shift and leaves opacity alone', () => {
    const { doc, a } = makeDoc();
    open(doc, a.id);
    applyOpacityDigit('6', true, 50_000);
    expect(session().doc.layers[a.id].fillOpacity).toBeCloseTo(0.6);
    expect(session().doc.layers[a.id].opacity).toBe(1);
  });

  it('does nothing without a document', () => {
    for (const id of Object.keys(useEditor.getState().sessions)) useEditor.getState().closeDocument(id);
    expect(applyOpacityDigit('3', false)).toBe(false);
  });
});
