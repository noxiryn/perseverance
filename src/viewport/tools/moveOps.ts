/** Move-tool operations: nudge, align, distribute (undoable). */
import type { Document, ID, Rect } from '../../core/types';
import { isTransformable } from '../../core/document';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { safeBounds, topLevelIds, transformableLeaves } from '../layers';
import { MaskFollower } from '../maskFollow';
import { translate } from '../math/affine';
import { requireDoc, toastOnce } from '../state';

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type DistributeKind = 'horizontal' | 'vertical';

function selectedIds(): ID[] {
  const s = activeSession();
  if (!s) return [];
  return s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
}

/** Offset the transformable leaves of `ids` by (dx, dy) inside a draft. */
export function offsetLayersDraft(d: Document, leafIds: ID[], dx: number, dy: number) {
  for (const id of leafIds) {
    const l = d.layers[id];
    if (!l || !isTransformable(l)) continue;
    l.transform.x += dx;
    l.transform.y += dy;
  }
}

function explainUnmovable(doc: Document, ids: ID[]): string {
  const { locked, other } = transformableLeaves(doc, ids);
  if (locked.length) return 'The selected layer is locked. Unlock its position to move it.';
  if (other.length) return 'Fill and adjustment layers cover the whole canvas and cannot be moved.';
  return 'Select a layer to move.';
}

/** Arrow-key nudge (coalesced into one history step while repeating). */
export function nudgeLayers(dx: number, dy: number) {
  const doc = requireDoc('the Move tool');
  if (!doc) return;
  const ids = selectedIds();
  const { movable } = transformableLeaves(doc, ids);
  if (!movable.length) {
    toastOnce(explainUnmovable(doc, ids));
    return;
  }
  // Linked masks follow the nudge; consecutive presses reuse one mask copy (coalesced history step).
  const s = activeSession()!;
  const entryId = s.history.entries[s.history.index]?.id;
  const key = movable.join(',');
  const now = Date.now();
  let st = nudgeState;
  if (!st || st.docId !== doc.id || st.entryId !== entryId || st.key !== key || now - st.time > 900) {
    st = { docId: doc.id, entryId: '', key, follower: MaskFollower.forLayers(doc, topLevelIds(doc, ids)), tx: 0, ty: 0, time: now };
  }
  st.tx += dx;
  st.ty += dy;
  st.time = now;
  const masks = st.follower ? st.follower.update(translate(st.tx, st.ty)) : null;
  useEditor.getState().commit(
    'Nudge',
    (d) => {
      offsetLayersDraft(d, movable, dx, dy);
      masks?.(d);
    },
    { coalesce: true },
  );
  const after = activeSession();
  st.entryId = after?.history.entries[after.history.index]?.id ?? '';
  nudgeState = st;
}

let nudgeState: {
  docId: ID;
  entryId: ID;
  key: string;
  follower: MaskFollower | null;
  tx: number;
  ty: number;
  time: number;
} | null = null;

/** Align the selected layers (to each other, or to the selection / canvas when only one). */
export function alignLayers(kind: AlignKind) {
  const doc = requireDoc('Align');
  if (!doc) return;
  const ids = topLevelIds(doc, selectedIds());
  if (!ids.length) {
    toast('Select a layer to align.', 'info');
    return;
  }
  const boxes = new Map<ID, Rect>();
  for (const id of ids) {
    const b = safeBounds(doc, id);
    const { movable } = transformableLeaves(doc, [id]);
    if (b && movable.length) boxes.set(id, b);
  }
  if (!boxes.size) {
    toast(explainUnmovable(doc, ids), 'warning');
    return;
  }
  let ref: Rect;
  let label = 'Align Layers';
  if (boxes.size === 1 || ids.length === 1) {
    ref = doc.selection ? doc.selection.bounds : { x: 0, y: 0, width: doc.width, height: doc.height };
    label = doc.selection ? 'Align to Selection' : 'Align to Canvas';
  } else {
    const all = [...boxes.values()];
    const x = Math.min(...all.map((b) => b.x));
    const y = Math.min(...all.map((b) => b.y));
    ref = {
      x,
      y,
      width: Math.max(...all.map((b) => b.x + b.width)) - x,
      height: Math.max(...all.map((b) => b.y + b.height)) - y,
    };
  }
  const moves: { leaves: ID[]; dx: number; dy: number }[] = [];
  for (const [id, b] of boxes) {
    let dx = 0;
    let dy = 0;
    switch (kind) {
      case 'left':
        dx = ref.x - b.x;
        break;
      case 'hcenter':
        dx = ref.x + ref.width / 2 - (b.x + b.width / 2);
        break;
      case 'right':
        dx = ref.x + ref.width - (b.x + b.width);
        break;
      case 'top':
        dy = ref.y - b.y;
        break;
      case 'vcenter':
        dy = ref.y + ref.height / 2 - (b.y + b.height / 2);
        break;
      case 'bottom':
        dy = ref.y + ref.height - (b.y + b.height);
        break;
    }
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) continue;
    moves.push({ leaves: transformableLeaves(doc, [id]).movable, dx: round2(dx), dy: round2(dy) });
  }
  if (!moves.length) return;
  useEditor.getState().commit(label, (d) => {
    for (const m of moves) offsetLayersDraft(d, m.leaves, m.dx, m.dy);
  });
}

/** Distribute the centers of 3+ selected layers evenly. */
export function distributeLayers(kind: DistributeKind) {
  const doc = requireDoc('Distribute');
  if (!doc) return;
  const ids = topLevelIds(doc, selectedIds());
  const items: { id: ID; c: number; leaves: ID[] }[] = [];
  for (const id of ids) {
    const b = safeBounds(doc, id);
    const leaves = transformableLeaves(doc, [id]).movable;
    if (!b || !leaves.length) continue;
    items.push({ id, c: kind === 'horizontal' ? b.x + b.width / 2 : b.y + b.height / 2, leaves });
  }
  if (items.length < 3) {
    toast('Select at least 3 movable layers to distribute.', 'info');
    return;
  }
  items.sort((a, b) => a.c - b.c);
  const first = items[0].c;
  const last = items[items.length - 1].c;
  const step = (last - first) / (items.length - 1);
  useEditor.getState().commit('Distribute Layers', (d) => {
    items.forEach((it, i) => {
      const delta = round2(first + step * i - it.c);
      if (Math.abs(delta) < 1e-6) return;
      offsetLayersDraft(d, it.leaves, kind === 'horizontal' ? delta : 0, kind === 'vertical' ? delta : 0);
    });
  });
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
