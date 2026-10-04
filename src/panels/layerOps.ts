/**
 * Layer operations — the logic behind the Layer menu, the Layers panel and the Properties /
 * Effects panels. Every document change is ONE undoable commit with a clear label.
 * Functions show a helpful toast (and return null/false) when there is no document or the
 * active layer does not support the operation.
 */
import { create } from 'zustand';
import type {
  BlendMode,
  DocSession,
  Document,
  FillContent,
  FilterInstance,
  GroupLayer,
  ID,
  Layer,
  LayerEffect,
  LayerMask,
  ParamValues,
  RasterLayer,
  Rect,
  Transform,
} from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { cloneCanvas, createCanvas, ctx2d, ctxRead } from '../core/canvas';
import { uid } from '../core/ids';
import { identityTransform, transformMatrix } from '../core/geometry';
import {
  displayList,
  insertLayerDraft,
  isTransformable,
  makeAdjustmentLayer,
  makeFillLayer,
  makeGroupLayer,
  makeRasterLayer,
  nextLayerName,
  parentOf,
  removeLayerDraft,
  siblingsOf,
} from '../core/document';
import { activeSession, useEditor } from '../state/editor';
import { toast, useUI } from '../state/ui';
import { effects, filters } from '../registry';
import { defaultParams } from '../filters/engine';
import { getLayerBounds, renderDocument, renderLayerContent, renderLayerToDoc } from '../render/compositor';
import { selectionFromCanvas, setSelection, combine, type SelectionMode } from '../editor/selection';
import { viewport } from '../editor/viewport';
import {
  ancestorsOf,
  arrangeDraft,
  cloneLayerTree,
  layerBelow,
  moveLayersDraft,
  orderedTopLevel,
  soloVisibility,
  type ArrangeOp,
} from './treeOps';
import { alignDelta, distributeDeltas, unionRects, type AlignMode, type DistributeMode } from './geometryMath';
import { effectName, type StylePreset } from './effectPresets';

/* ------------------------------------------------------------------ */
/* Guards & accessors                                                  */
/* ------------------------------------------------------------------ */

const ed = () => useEditor.getState();

/** Active session, or null after a "no document" toast. */
export function needDoc(): DocSession | null {
  const s = activeSession();
  if (!s) toast('Open or create a document first', 'info');
  return s;
}

/** Active session + active layer, or null after a helpful toast. */
export function needLayer(action: string): { s: DocSession; layer: Layer } | null {
  const s = needDoc();
  if (!s) return null;
  const layer = s.activeLayerId ? s.doc.layers[s.activeLayerId] : undefined;
  if (!layer) {
    toast(`Select a layer to ${action}`, 'info');
    return null;
  }
  return { s, layer };
}

/** Selected layer ids (falls back to the active layer). */
export function selectedIds(s: DocSession | null = activeSession()): ID[] {
  if (!s) return [];
  const ids = s.selectedLayerIds.filter((id) => s.doc.layers[id]);
  if (ids.length) return ids;
  return s.activeLayerId && s.doc.layers[s.activeLayerId] ? [s.activeLayerId] : [];
}

/** Selected layers without nested duplicates, bottom → top. */
export function selectedTopLevel(s: DocSession | null = activeSession()): ID[] {
  return s ? orderedTopLevel(s.doc, selectedIds(s)) : [];
}

export function hasDoc(): boolean {
  return !!activeSession();
}

export function hasLayer(): boolean {
  const s = activeSession();
  return !!(s && s.activeLayerId && s.doc.layers[s.activeLayerId]);
}

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

function showPanel(id: string) {
  useUI.getState().showPanel(id);
}

/* ------------------------------------------------------------------ */
/* Generic live editing (preview while dragging, coalesced commit)     */
/* ------------------------------------------------------------------ */

export type Phase = 'preview' | 'commit';

/** Apply `fn` to the given layers: live preview, or a (coalesced) history commit. */
export function editLayers(ids: ID[], label: string, fn: (l: Layer) => void, phase: Phase = 'commit') {
  if (!activeSession() || !ids.length) return;
  const recipe = (d: Document) => {
    for (const id of ids) {
      const l = d.layers[id];
      if (l) fn(l);
    }
  };
  if (phase === 'preview') ed().preview(recipe);
  else ed().commit(label, recipe, { coalesce: true });
}

/** Same as editLayers for the current selection. */
export function editSelected(label: string, fn: (l: Layer) => void, phase: Phase = 'commit') {
  editLayers(selectedIds(), label, fn, phase);
}

/** Generic document change, live or committed. */
export function editDoc(label: string, recipe: (d: Document) => void, phase: Phase = 'commit') {
  if (!activeSession()) return;
  if (phase === 'preview') ed().preview(recipe);
  else ed().commit(label, recipe, { coalesce: true });
}

/**
 * Change the document WITHOUT creating a history step (UI-ish state stored in the document,
 * such as a group's collapsed flag). The current history entry is updated too so undo/redo and
 * cancelPreview keep the change.
 */
export function editDocSilently(transform: (doc: Document) => Document) {
  const st = useEditor.getState();
  const id = st.activeDocId;
  const s = id ? st.sessions[id] : null;
  if (!id || !s) return;
  const entry = s.history.entries[s.history.index];
  const entryDoc = transform(entry.doc);
  const doc = s.doc === entry.doc ? entryDoc : transform(s.doc);
  const entries = s.history.entries.slice();
  entries[s.history.index] = { ...entry, doc: entryDoc };
  useEditor.setState({ sessions: { ...st.sessions, [id]: { ...s, doc, history: { ...s.history, entries } } } });
}

/** Collapse / expand a group (not recorded in history). */
export function setGroupCollapsed(id: ID, collapsed: boolean) {
  editDocSilently((doc) => {
    const g = doc.layers[id];
    if (!g || g.type !== 'group' || g.collapsed === collapsed) return doc;
    return { ...doc, layers: { ...doc.layers, [id]: { ...g, collapsed } } };
  });
}

/* ------------------------------------------------------------------ */
/* Creating layers                                                     */
/* ------------------------------------------------------------------ */

/** Where a new layer goes: above the active layer, or at the top of an expanded active group. */
function insertionPoint(s: DocSession): { aboveId?: ID | null; parentId?: ID | null; index?: number } {
  const active = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!active) return { parentId: null, index: s.doc.rootIds.length };
  if (active.type === 'group' && !active.collapsed) return { parentId: active.id, index: active.childIds.length };
  return { aboveId: active.id };
}

/** Insert a new layer at the standard insertion point (one commit) and make it active. */
export function insertNewLayer(layer: Layer, label: string) {
  const s = activeSession();
  if (!s) return;
  const at = insertionPoint(s);
  // A layer created above a clipped layer joins the same clipping group (like Photoshop).
  const above = at.aboveId ? s.doc.layers[at.aboveId] : null;
  if (above?.clipped && layer.type !== 'group') layer = { ...layer, clipped: true } as Layer;
  ed().commit(label, (d) => insertLayerDraft(d, layer, at), { activeLayerId: layer.id });
}

/** Insert a layer as a live preview (for dialogs). Idempotent. Commit with commitPreview(). */
export function previewInsertLayer(layer: Layer) {
  const s = activeSession();
  if (!s) return;
  const at = insertionPoint(s);
  ed().preview((d) => {
    if (!d.layers[layer.id]) insertLayerDraft(d, layer, at);
  });
}

export function commitPreview(label: string, activeLayerId?: ID) {
  ed().commit(label, undefined, activeLayerId ? { activeLayerId } : {});
}

export function cancelPreview() {
  ed().cancelPreview();
}

/** Layer ▸ New ▸ Layer: empty document-sized raster layer. */
export function newLayer(name?: string): ID | null {
  const s = needDoc();
  if (!s) return null;
  const bitmapId = bitmaps.create(s.doc.width, s.doc.height);
  const layer = makeRasterLayer({ name: name ?? nextLayerName(s.doc), bitmapId, width: s.doc.width, height: s.doc.height });
  insertNewLayer(layer, 'New Layer');
  return layer.id;
}

/** Layer ▸ New ▸ Group (empty). */
export function newGroup(): ID | null {
  const s = needDoc();
  if (!s) return null;
  const g = makeGroupLayer({ name: nextLayerName(s.doc, 'Group') });
  insertNewLayer(g, 'New Group');
  return g.id;
}

export function newFillLayer(fill: FillContent, name?: string): ID | null {
  const s = needDoc();
  if (!s) return null;
  const l = makeFillLayer({ fill, name });
  if (!name) l.name = nextLayerName(s.doc, l.name);
  insertNewLayer(l, 'New Fill Layer');
  return l.id;
}

/** New adjustment layer above the active layer (used by the panel footer / adjustments menu). */
export function newAdjustmentLayer(filterId: string, params?: ParamValues): ID | null {
  const s = needDoc();
  if (!s) return null;
  const def = filters.get(filterId);
  if (!def) {
    toast(`Adjustment “${filterId}” is not available`, 'warning');
    return null;
  }
  const l = makeAdjustmentLayer({ name: def.name, filterId, params: { ...defaultParams(def.params), ...params } });
  insertNewLayer(l, `New ${def.name} Layer`);
  showPanel('properties');
  return l.id;
}

/* ------------------------------------------------------------------ */
/* Duplicate / delete                                                  */
/* ------------------------------------------------------------------ */

const newId = (prefix: string) => uid(prefix);

/** Layer ▸ Duplicate (Ctrl+J). With an active pixel selection on a raster layer: Layer via Copy. */
export function duplicateLayers(): ID[] {
  const s = needDoc();
  if (!s) return [];
  const ids = selectedTopLevel(s);
  if (!ids.length) {
    toast('Select a layer to duplicate', 'info');
    return [];
  }
  const active = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (s.doc.selection && ids.length === 1 && active?.type === 'raster') return [layerViaCopy(s, active)].filter(Boolean) as ID[];

  const clones = ids.map((id) => ({ id, ...cloneLayerTree(s.doc, id, { newId, dupBitmap: (b) => (bitmaps.has(b) ? bitmaps.duplicate(b) : b) }) }));
  const roots = clones.map((c) => c.rootId);
  ed().commit(
    plural(ids.length, 'Duplicate Layer', 'Duplicate Layers'),
    (d) => {
      for (const c of clones) {
        for (const l of c.layers) d.layers[l.id] = l;
        const list = siblingsOf(d, c.id);
        list.splice(list.indexOf(c.id) + 1, 0, c.rootId);
      }
    },
    { activeLayerId: roots[roots.length - 1], selectedLayerIds: roots },
  );
  return roots;
}

function layerViaCopy(s: DocSession, layer: RasterLayer): ID | null {
  const doc = s.doc;
  const content = renderLayerToDoc(doc, { ...layer, filters: [], effects: [], mask: null }, { effects: false, mask: false });
  const mask = doc.selection ? bitmaps.tryGet(doc.selection.bitmapId) : null;
  if (!content || !mask) return null;
  const out = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(out);
  ctx.drawImage(content, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  const l = makeRasterLayer({ name: nextLayerName(doc), bitmapId: bitmaps.add(out), width: doc.width, height: doc.height });
  l.blendMode = layer.blendMode;
  l.opacity = layer.opacity;
  l.fillOpacity = layer.fillOpacity;
  l.effects = layer.effects.map((e) => ({ ...structuredClone(e), id: newId('ef_') }));
  l.filters = layer.filters.map((f) => ({ ...structuredClone(f), id: newId('fx_') }));
  l.clipped = layer.clipped;
  ed().commit('Layer via Copy', (d) => insertLayerDraft(d, l, { aboveId: layer.id }), { activeLayerId: l.id });
  return l.id;
}

/** Layer ▸ Delete. The layer below becomes active (like Photoshop). */
export function deleteLayers(ids?: ID[]): boolean {
  const s = needDoc();
  if (!s) return false;
  const del = orderedTopLevel(s.doc, ids ?? selectedIds(s));
  if (!del.length) {
    toast('Select a layer to delete', 'info');
    return false;
  }
  const gone = new Set<ID>();
  for (const id of del) {
    gone.add(id);
    const walk = (x: ID) => {
      const l = s.doc.layers[x];
      if (l?.type === 'group') l.childIds.forEach((c) => (gone.add(c), walk(c)));
    };
    walk(id);
  }
  const rows = displayList(s.doc).map((r) => r.id);
  let lastIdx = -1;
  rows.forEach((r, i) => gone.has(r) && (lastIdx = i));
  const next = rows.slice(lastIdx + 1).find((r) => !gone.has(r)) ?? [...rows].reverse().find((r) => !gone.has(r)) ?? null;
  ed().commit(plural(del.length, 'Delete Layer', 'Delete Layers'), (d) => del.forEach((id) => removeLayerDraft(d, id)), {
    activeLayerId: next,
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Basic properties                                                    */
/* ------------------------------------------------------------------ */

export function renameLayer(id: ID, name: string) {
  const s = activeSession();
  const l = s?.doc.layers[id];
  const n = name.trim();
  if (!l || !n || n === l.name) return;
  ed().commit('Rename Layer', (d) => {
    d.layers[id].name = n;
  });
}

export function toggleVisibility(id: ID) {
  const l = activeSession()?.doc.layers[id];
  if (!l) return;
  ed().commit(l.visible ? 'Hide Layer' : 'Show Layer', (d) => {
    d.layers[id].visible = !l.visible;
  });
}

let soloState: { docId: ID; layerId: ID; restore: Record<ID, boolean> } | null = null;

/** Alt-click on an eye: show only this layer; Alt-click again restores the previous visibility. */
export function soloLayer(id: ID) {
  const s = activeSession();
  if (!s || !s.doc.layers[id]) return;
  if (soloState && soloState.docId === s.doc.id && soloState.layerId === id) {
    const restore = soloState.restore;
    soloState = null;
    ed().commit('Show/Hide Layers', (d) => {
      for (const [k, v] of Object.entries(restore)) if (d.layers[k]) d.layers[k].visible = v;
    });
    return;
  }
  const change = soloVisibility(s.doc, id);
  if (!Object.keys(change).length) return;
  const restore: Record<ID, boolean> = {};
  for (const k of Object.keys(change)) restore[k] = s.doc.layers[k].visible;
  soloState = { docId: s.doc.id, layerId: id, restore };
  ed().commit('Show/Hide Layers', (d) => {
    for (const [k, v] of Object.entries(change)) d.layers[k].visible = v;
  });
}

/** Layer ▸ Hide Layers (Ctrl+,): toggles the selection. */
export function toggleHideSelected() {
  const s = needDoc();
  if (!s) return;
  const ids = selectedIds(s);
  if (!ids.length) return void toast('Select a layer to hide or show', 'info');
  const hide = ids.some((id) => s.doc.layers[id].visible);
  editLayers(ids, hide ? plural(ids.length, 'Hide Layer', 'Hide Layers') : plural(ids.length, 'Show Layer', 'Show Layers'), (l) => {
    l.visible = !hide;
  });
}

/** Layer ▸ Lock Layers (Ctrl+/): toggles "lock all" on the selection. */
export function toggleLockSelected() {
  const s = needDoc();
  if (!s) return;
  const ids = selectedIds(s);
  if (!ids.length) return void toast('Select a layer to lock', 'info');
  const lock = !ids.every((id) => s.doc.layers[id].locks.all);
  editLayers(ids, lock ? plural(ids.length, 'Lock Layer', 'Lock Layers') : plural(ids.length, 'Unlock Layer', 'Unlock Layers'), (l) => {
    l.locks = { ...l.locks, all: lock };
  });
}

export type LockKey = 'transparency' | 'pixels' | 'position' | 'all';

/** Toggle one lock on the selection (based on the active layer's state). */
export function toggleLock(key: LockKey) {
  const s = activeSession();
  if (!s) return;
  const ids = selectedIds(s);
  const active = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!active || !ids.length) return;
  const on = !active.locks[key];
  const names: Record<LockKey, string> = { transparency: 'Transparency', pixels: 'Pixels', position: 'Position', all: 'All' };
  editLayers(ids, `${on ? 'Lock' : 'Unlock'} ${names[key]}`, (l) => {
    l.locks = { ...l.locks, [key]: on };
  });
}

export function setLabelColor(ids: ID[], label: Layer['label']) {
  editLayers(ids, 'Layer Color', (l) => {
    l.label = label;
  });
}

/* ------------------------------------------------------------------ */
/* Selection of layers                                                 */
/* ------------------------------------------------------------------ */

/** Alt+] / Alt+[ : select the layer above / below in the panel. */
export function selectAdjacent(dir: 1 | -1) {
  const s = needDoc();
  if (!s) return;
  const rows = displayList(s.doc).map((r) => r.id);
  if (!rows.length) return;
  const i = s.activeLayerId ? rows.indexOf(s.activeLayerId) : -1;
  const j = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i - dir));
  ed().setActiveLayer(rows[j]);
}

/** Ctrl+click on a layer thumbnail: load the layer's opaque pixels as a selection. */
export function loadSelectionFromLayer(id: ID, mode: SelectionMode = 'new') {
  const s = needDoc();
  const l = s?.doc.layers[id];
  if (!s || !l) return;
  if (l.type === 'adjustment') return void toast('Adjustment layers have no pixels to select — Ctrl+click its mask instead', 'info');
  const c = renderLayerToDoc(s.doc, l, { effects: false, mask: true });
  if (!c) return void toast('This layer has no pixels to select', 'info');
  applyAlphaAsSelection(s.doc, c, mode);
}

/** Ctrl+click on a mask thumbnail: load the mask as a selection. */
export function loadSelectionFromMask(id: ID, mode: SelectionMode = 'new') {
  const s = needDoc();
  const l = s?.doc.layers[id];
  if (!s || !l?.mask) return;
  applyAlphaAsSelection(s.doc, effectiveMaskAlpha(s.doc, l.mask, false), mode);
}

function applyAlphaAsSelection(doc: Document, alphaCanvas: HTMLCanvasElement, mode: SelectionMode) {
  const m = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(m);
  ctx.drawImage(alphaCanvas, 0, 0, doc.width, doc.height);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, m.width, m.height);
  const sel = mode === 'new' ? selectionFromCanvas(m) : combine(doc, m, mode);
  if (!sel && mode === 'new') return void toast('The layer is empty — nothing to select', 'info');
  setSelection(sel, 'Load Selection');
}

/* ------------------------------------------------------------------ */
/* Moving / arranging                                                  */
/* ------------------------------------------------------------------ */

/** Move layers (any selection) into parentId at index (index before the move). One commit. */
export function moveLayers(ids: ID[], parentId: ID | null, index: number) {
  const s = activeSession();
  if (!s) return;
  const moving = orderedTopLevel(s.doc, ids);
  if (!moving.length) return;
  ed().commit(plural(moving.length, 'Move Layer', 'Move Layers'), (d) => {
    moveLayersDraft(d, moving, parentId, index);
  });
}

const ARRANGE_LABELS: Record<ArrangeOp, string> = {
  front: 'Bring to Front',
  forward: 'Bring Forward',
  backward: 'Send Backward',
  back: 'Send to Back',
};

export function arrangeSelected(op: ArrangeOp) {
  const s = needDoc();
  if (!s) return;
  const ids = selectedTopLevel(s);
  if (!ids.length) return void toast('Select a layer to arrange', 'info');
  ed().commit(ARRANGE_LABELS[op], (d) => {
    arrangeDraft(d, ids, op);
  });
}

/** Translate a layer (recursively for groups) in a draft. Fill/adjustment layers don't move. */
function translateDraft(d: Document, id: ID, dx: number, dy: number) {
  const l = d.layers[id];
  if (!l || l.locks.position || l.locks.all) return;
  if (isTransformable(l)) {
    l.transform.x += dx;
    l.transform.y += dy;
  } else if (l.type === 'group') {
    for (const c of l.childIds) translateDraft(d, c, dx, dy);
  }
}

function movableWithBounds(s: DocSession): { id: ID; b: Rect }[] {
  const out: { id: ID; b: Rect }[] = [];
  for (const id of selectedTopLevel(s)) {
    const l = s.doc.layers[id];
    if (!l || l.type === 'fill' || l.type === 'adjustment' || l.locks.position || l.locks.all) continue;
    const b = getLayerBounds(s.doc, id);
    if (b && b.width > 0 && b.height > 0) out.push({ id, b });
  }
  return out;
}

const ALIGN_LABELS: Record<AlignMode, string> = {
  left: 'Align Left Edges',
  hcenter: 'Align Horizontal Centers',
  right: 'Align Right Edges',
  top: 'Align Top Edges',
  vcenter: 'Align Vertical Centers',
  bottom: 'Align Bottom Edges',
};

/** Align to the pixel selection, else to the selected layers' bounds (2+), else to the canvas. */
export function alignSelected(mode: AlignMode) {
  const s = needDoc();
  if (!s) return;
  const items = movableWithBounds(s);
  if (!items.length) return void toast('Select an unlocked text, shape, pixel layer or group to align', 'info');
  const canvas = { x: 0, y: 0, width: s.doc.width, height: s.doc.height };
  const target = s.doc.selection?.bounds ?? (items.length > 1 ? unionRects(items.map((i) => i.b)) : canvas) ?? canvas;
  ed().commit(ALIGN_LABELS[mode], (d) => {
    for (const it of items) {
      const { dx, dy } = alignDelta(it.b, target, mode);
      if (dx || dy) translateDraft(d, it.id, dx, dy);
    }
  });
}

export function distributeSelected(axis: 'h' | 'v', mode: DistributeMode = 'centers') {
  const s = needDoc();
  if (!s) return;
  const items = movableWithBounds(s);
  if (items.length < 3) return void toast('Select at least three unlocked layers to distribute', 'info');
  const deltas = distributeDeltas(
    items.map((i) => i.b),
    axis,
    mode,
  );
  const label = `Distribute ${axis === 'h' ? 'Horizontal' : 'Vertical'} ${mode === 'centers' ? 'Centers' : 'Spacing'}`;
  ed().commit(label, (d) => items.forEach((it, k) => translateDraft(d, it.id, deltas[k].dx, deltas[k].dy)));
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

/** Layer ▸ Group Layers (Ctrl+G): wraps the selection in a new group at the topmost position. */
export function groupSelected(): ID | null {
  const s = needDoc();
  if (!s) return null;
  const ids = selectedTopLevel(s);
  if (!ids.length) {
    toast('Select the layers to group', 'info');
    return null;
  }
  const g = makeGroupLayer({ name: nextLayerName(s.doc, 'Group') });
  const top = ids[ids.length - 1];
  ed().commit(
    'Group Layers',
    (d) => {
      insertLayerDraft(d, g, { aboveId: top });
      moveLayersDraft(d, ids, g.id, 0);
    },
    { activeLayerId: g.id },
  );
  return g.id;
}

/** Layer ▸ Ungroup Layers (Shift+Ctrl+G). */
export function ungroupSelected() {
  const s = needDoc();
  if (!s) return;
  const groups = selectedTopLevel(s).filter((id) => s.doc.layers[id]?.type === 'group');
  if (!groups.length) return void toast('Select a group to ungroup', 'info');
  const children: ID[] = [];
  for (const g of groups) children.push(...(s.doc.layers[g] as GroupLayer).childIds);
  ed().commit(
    'Ungroup Layers',
    (d) => {
      for (const id of groups) {
        const g = d.layers[id] as GroupLayer;
        const list = siblingsOf(d, id);
        list.splice(list.indexOf(id), 1, ...g.childIds);
        delete d.layers[id];
      }
    },
    { activeLayerId: children[children.length - 1] ?? null, selectedLayerIds: children },
  );
}

/* ------------------------------------------------------------------ */
/* Clipping masks                                                      */
/* ------------------------------------------------------------------ */

export function setClipped(on: boolean) {
  const s = needDoc();
  if (!s) return;
  let ids = selectedTopLevel(s);
  if (!ids.length) return void toast('Select a layer first', 'info');
  if (on) {
    ids = ids.filter((id) => layerBelow(s.doc, id));
    if (!ids.length) return void toast('A clipping mask needs a layer below it in the same group', 'info');
  } else {
    ids = ids.filter((id) => s.doc.layers[id].clipped);
    if (!ids.length) return void toast('The selected layer is not clipped', 'info');
  }
  editLayers(ids, on ? 'Create Clipping Mask' : 'Release Clipping Mask', (l) => {
    l.clipped = on;
  });
}

/** Alt+Ctrl+G: create a clipping mask, or release it when the selection is already clipped. */
export function toggleClip() {
  const s = activeSession();
  if (!s) return void needDoc();
  const ids = selectedTopLevel(s);
  setClipped(!(ids.length > 0 && ids.every((id) => s.doc.layers[id].clipped)));
}

/* ------------------------------------------------------------------ */
/* Layer masks                                                         */
/* ------------------------------------------------------------------ */

export type MaskMode = 'reveal' | 'hide' | 'revealSelection' | 'hideSelection';

function makeMaskCanvas(doc: Document, mode: MaskMode): HTMLCanvasElement | null {
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  const selMask = doc.selection ? bitmaps.tryGet(doc.selection.bitmapId) : null;
  if (mode === 'reveal' || mode === 'hide') {
    ctx.fillStyle = mode === 'reveal' ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }
  if (!selMask) return null;
  // White where selected (reveal) — the selection's alpha becomes mask luminance.
  const sel = createCanvas(doc.width, doc.height);
  const sctx = ctx2d(sel);
  sctx.drawImage(selMask, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = mode === 'revealSelection' ? '#ffffff' : '#000000';
  sctx.fillRect(0, 0, sel.width, sel.height);
  ctx.fillStyle = mode === 'revealSelection' ? '#000000' : '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(sel, 0, 0);
  return c;
}

const MASK_LABELS: Record<MaskMode, string> = {
  reveal: 'Add Layer Mask',
  hide: 'Add Layer Mask',
  revealSelection: 'Add Layer Mask',
  hideSelection: 'Add Layer Mask',
};

/** Add a layer mask to the active layer and switch painting to the mask. */
export function addMask(mode: MaskMode): boolean {
  const ctx = needLayer('add a mask to');
  if (!ctx) return false;
  const { s, layer } = ctx;
  if (layer.mask) {
    toast(`“${layer.name}” already has a layer mask`, 'info');
    return false;
  }
  if ((mode === 'revealSelection' || mode === 'hideSelection') && !s.doc.selection) {
    toast('Make a selection first to create a mask from it', 'info');
    return false;
  }
  const c = makeMaskCanvas(s.doc, mode);
  if (!c) return false;
  const mask: LayerMask = { bitmapId: bitmaps.add(c), enabled: true, density: 1, feather: 0, inverted: false };
  ed().commit(MASK_LABELS[mode], (d) => {
    d.layers[layer.id].mask = mask;
  });
  ed().setEditTarget('mask');
  return true;
}

/** Panel footer button: from the selection if there is one, else reveal all (Alt = hide). */
export function addMaskAuto(alt: boolean) {
  const s = activeSession();
  if (s?.doc.selection) addMask(alt ? 'hideSelection' : 'revealSelection');
  else addMask(alt ? 'hide' : 'reveal');
}

/** Layer ▸ Layer Mask ▸ From Selection: new mask (or replace the existing one) revealing the selection. */
export function maskFromSelection() {
  const ctx = needLayer('mask');
  if (!ctx) return;
  const { s, layer } = ctx;
  if (!s.doc.selection) return void toast('Make a selection first to create a mask from it', 'info');
  if (!layer.mask) return void addMask('revealSelection');
  const c = makeMaskCanvas(s.doc, 'revealSelection');
  if (!c) return;
  const bitmapId = bitmaps.add(c);
  ed().commit('Mask from Selection', (d) => {
    const m = d.layers[layer.id].mask;
    if (m) m.bitmapId = bitmapId;
  });
  ed().setEditTarget('mask');
}

/**
 * Doc-sized canvas whose ALPHA is the effective mask (luminance → alpha, density, invert and
 * optionally feather applied).
 */
export function effectiveMaskAlpha(doc: Document, mask: LayerMask, withFeather = true): HTMLCanvasElement {
  const src = bitmaps.tryGet(mask.bitmapId);
  const c = createCanvas(doc.width, doc.height);
  if (!src) {
    const ctx = ctx2d(c);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }
  const rctx = ctxRead(c);
  rctx.drawImage(src, 0, 0, doc.width, doc.height);
  const img = rctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const density = Math.max(0, Math.min(1, mask.density));
  const inv = mask.inverted;
  for (let i = 0; i < d.length; i += 4) {
    // Mask pixels may themselves be partly transparent: treat missing coverage as black.
    let v = (d[i] * d[i + 3]) / 65025;
    if (inv) v = 1 - v;
    v = 1 - density * (1 - v);
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = v * 255;
  }
  rctx.putImageData(img, 0, 0);
  if (!withFeather || mask.feather <= 0) return c;
  const f = createCanvas(doc.width, doc.height);
  const fctx = ctx2d(f);
  fctx.filter = `blur(${mask.feather / 2}px)`;
  fctx.drawImage(c, 0, 0);
  return f;
}

/** Layer ▸ Layer Mask ▸ Apply: bake the mask into the layer's pixels. */
export function applyMask() {
  const ctx = needLayer('apply a mask on');
  if (!ctx) return;
  const { s, layer } = ctx;
  if (!layer.mask) return void toast(`“${layer.name}” has no layer mask`, 'info');
  if (layer.type === 'group' || layer.type === 'adjustment') {
    return void toast('Masks on groups and adjustment layers stay live — merge or rasterize the content instead', 'info');
  }
  const doc = s.doc;
  const mask = layer.mask;
  if (!mask.enabled) return void toast('Enable the mask before applying it (Shift-click the mask thumbnail)', 'info');
  if (layer.type === 'raster') {
    const alpha = effectiveMaskAlpha(doc, mask);
    const m = transformMatrix(layer.transform, layer.width, layer.height).inverse();
    // Build the mask in the layer's local space; pixels outside the canvas stay untouched.
    const local = createCanvas(layer.width, layer.height);
    const lctx = ctx2d(local);
    lctx.fillStyle = '#000';
    lctx.fillRect(0, 0, local.width, local.height);
    lctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    lctx.clearRect(0, 0, doc.width, doc.height);
    lctx.drawImage(alpha, 0, 0);
    if (!bitmaps.has(layer.bitmapId)) return void toast('Layer pixels are missing', 'error');
    const patch = bitmaps.edit(layer.bitmapId, (bctx) => {
      bctx.globalCompositeOperation = 'destination-in';
      bctx.drawImage(local, 0, 0);
    });
    ed().commit(
      'Apply Layer Mask',
      (d) => {
        d.layers[layer.id].mask = null;
      },
      { patches: [patch] },
    );
  } else {
    const canvas = renderLayerToDoc(doc, { ...layer, effects: [], filters: [] } as Layer, { effects: false, mask: true });
    if (!canvas) return void toast('Nothing to apply — the layer is empty', 'info');
    const r = toRaster(layer, bitmaps.add(canvas), doc.width, doc.height, identityTransform());
    r.mask = null;
    ed().commit('Apply Layer Mask', (d) => {
      d.layers[layer.id] = r;
    });
  }
  ed().setEditTarget('content');
}

export function deleteMask() {
  const ctx = needLayer('delete a mask from');
  if (!ctx) return;
  if (!ctx.layer.mask) return void toast(`“${ctx.layer.name}” has no layer mask`, 'info');
  ed().commit('Delete Layer Mask', (d) => {
    d.layers[ctx.layer.id].mask = null;
  });
  ed().setEditTarget('content');
}

export function toggleMaskEnabled(id?: ID) {
  const s = needDoc();
  if (!s) return;
  const l = s.doc.layers[id ?? s.activeLayerId ?? ''];
  if (!l?.mask) return void toast('The layer has no layer mask', 'info');
  const on = !l.mask.enabled;
  ed().commit(on ? 'Enable Layer Mask' : 'Disable Layer Mask', (d) => {
    const m = d.layers[l.id].mask;
    if (m) m.enabled = on;
  });
}

export function setMaskProps(id: ID, change: Partial<Omit<LayerMask, 'bitmapId'>>, phase: Phase, label = 'Mask Properties') {
  editLayers([id], label, (l) => {
    if (l.mask) Object.assign(l.mask, change);
  }, phase);
}

/** Invert the mask pixels (Ctrl+I on a mask in Photoshop) — toggles the non-destructive invert flag. */
export function invertMask(id: ID) {
  const l = activeSession()?.doc.layers[id];
  if (!l?.mask) return;
  setMaskProps(id, { inverted: !l.mask.inverted }, 'commit', 'Invert Mask');
}

/* ------------------------------------------------------------------ */
/* Rasterize                                                           */
/* ------------------------------------------------------------------ */

/** A raster layer that keeps the base properties (id, name, mask, effects, filters…) of `old`. */
function toRaster(old: Layer, bitmapId: ID, width: number, height: number, transform: Transform): RasterLayer {
  return {
    id: old.id,
    name: old.name,
    type: 'raster',
    visible: old.visible,
    locks: { ...old.locks },
    opacity: old.opacity,
    fillOpacity: old.fillOpacity,
    blendMode: old.blendMode === 'pass-through' ? 'normal' : (old.blendMode as BlendMode),
    clipped: old.clipped,
    mask: old.mask,
    effects: old.effects,
    filters: old.filters,
    label: old.label,
    ...(old.meta ? { meta: old.meta } : {}),
    bitmapId,
    width,
    height,
    transform: { ...transform },
    generator: null,
  };
}

/** Rasterize one layer's content (no effects / smart filters baked). Null when unsupported. */
function rasterizeContent(doc: Document, l: Layer): RasterLayer | null {
  if (l.type === 'text' || l.type === 'shape') {
    const c = renderLayerContent(doc, { ...l, filters: [] });
    return toRaster(l, bitmaps.add(c), c.width, c.height, l.transform);
  }
  if (l.type === 'fill') {
    const c =
      renderLayerToDoc(doc, { ...l, filters: [], effects: [], mask: null }, { effects: false, mask: false }) ?? createCanvas(doc.width, doc.height);
    return toRaster(l, bitmaps.add(c), doc.width, doc.height, identityTransform());
  }
  if (l.type === 'raster' && l.generator) return { ...l, generator: null };
  return null;
}

/** Layer ▸ Rasterize: text / shape / fill (and generated asset layers) → pixels, keeping styles. */
export function rasterizeSelected() {
  const s = needDoc();
  if (!s) return;
  const ids = selectedTopLevel(s);
  if (!ids.length) return void toast('Select a text, shape or fill layer to rasterize', 'info');
  const out: RasterLayer[] = [];
  for (const id of ids) {
    const r = rasterizeContent(s.doc, s.doc.layers[id]);
    if (r) out.push(r);
  }
  if (!out.length) {
    const t = s.doc.layers[ids[0]].type;
    return void toast(
      t === 'raster' ? 'This is already a pixel layer' : t === 'group' ? 'Use Merge Group (Ctrl+E) to rasterize a group' : 'Adjustment layers cannot be rasterized',
      'info',
    );
  }
  ed().commit(plural(out.length, 'Rasterize Layer', 'Rasterize Layers'), (d) => {
    for (const r of out) d.layers[r.id] = r;
  });
}

/** Layer ▸ Rasterize Layer Style: bake effects (and smart filters) into pixels. */
export function rasterizeStyleSelected() {
  const s = needDoc();
  if (!s) return;
  const ids = selectedTopLevel(s).filter((id) => {
    const l = s.doc.layers[id];
    return l.type !== 'group' && l.type !== 'adjustment' && (l.effects.length > 0 || l.filters.length > 0);
  });
  if (!ids.length) return void toast('Select a layer with a layer style to rasterize it', 'info');
  const out: RasterLayer[] = [];
  for (const id of ids) {
    const l = s.doc.layers[id];
    const c = renderLayerToDoc(s.doc, { ...l, mask: null } as Layer, { effects: true, mask: false });
    if (!c) continue;
    const r = toRaster(l, bitmaps.add(c), s.doc.width, s.doc.height, identityTransform());
    r.effects = [];
    r.filters = [];
    r.fillOpacity = 1;
    out.push(r);
  }
  if (!out.length) return void toast('Nothing to rasterize — the layer is empty', 'info');
  ed().commit('Rasterize Layer Style', (d) => {
    for (const r of out) d.layers[r.id] = r;
  });
}

/* ------------------------------------------------------------------ */
/* Merge / flatten                                                     */
/* ------------------------------------------------------------------ */

/** Render a subset of layers (top-level ids, bottom → top) composited on transparency. */
function renderSubset(doc: Document, ids: ID[], overrides: Record<ID, Layer> = {}): HTMLCanvasElement {
  const temp: Document = { ...doc, background: null, selection: null, rootIds: ids, layers: { ...doc.layers, ...overrides } };
  // renderDocument returns a shared cached canvas: copy it before it becomes a bitmap.
  return cloneCanvas(renderDocument(temp, { background: false }));
}

function mergedRaster(base: Layer, canvas: HTMLCanvasElement, doc: Document): RasterLayer {
  const r = toRaster(base, bitmaps.add(canvas), doc.width, doc.height, identityTransform());
  r.effects = [];
  r.filters = [];
  r.mask = null;
  r.fillOpacity = 1;
  r.locks = { pixels: false, position: false, transparency: false, all: false };
  return r;
}

/** Layer ▸ Merge Down (Ctrl+E). Merges the selection when several layers are selected, a group when a group is active. */
export function mergeDown() {
  const ctx = needLayer('merge');
  if (!ctx) return;
  const { s, layer } = ctx;
  const doc = s.doc;
  const sel = selectedTopLevel(s);
  if (sel.length > 1) return mergeLayers(sel);
  if (layer.type === 'group') return mergeGroup(layer);
  const belowId = layerBelow(doc, layer.id);
  if (!belowId) return void toast('There is no layer below to merge into', 'info');
  const below = doc.layers[belowId];
  if (below.type === 'adjustment') return void toast('Cannot merge into an adjustment layer — select the layers to merge instead', 'info');
  if (below.type === 'group') return void toast('Cannot merge down into a group — use Merge Group instead', 'info');
  const canvas = renderSubset(doc, [belowId, layer.id], {
    [belowId]: { ...below, opacity: 1, blendMode: 'normal', clipped: false, visible: true } as Layer,
    [layer.id]: { ...layer, visible: true } as Layer,
  });
  const r = mergedRaster(below, canvas, doc);
  r.opacity = below.opacity;
  r.blendMode = below.blendMode as BlendMode;
  r.clipped = below.clipped;
  r.visible = true;
  ed().commit(
    'Merge Down',
    (d) => {
      removeLayerDraft(d, layer.id);
      d.layers[belowId] = r;
    },
    { activeLayerId: belowId },
  );
}

/** Merge several layers into one (placed at the topmost one). Hidden layers are discarded. */
export function mergeLayers(ids: ID[]) {
  const s = needDoc();
  if (!s) return;
  const doc = s.doc;
  const list = orderedTopLevel(doc, ids);
  if (list.length < 2) return void toast('Select at least two layers to merge', 'info');
  const visible = list.filter((id) => doc.layers[id].visible);
  const top = doc.layers[list[list.length - 1]];
  const canvas = renderSubset(doc, visible);
  const r = mergedRaster(top, canvas, doc);
  r.id = uid('ly_');
  r.opacity = 1;
  r.blendMode = 'normal';
  r.clipped = false;
  r.visible = true;
  ed().commit(
    'Merge Layers',
    (d) => {
      insertLayerDraft(d, r, { aboveId: top.id });
      for (const id of list) removeLayerDraft(d, id);
    },
    { activeLayerId: r.id },
  );
}

/** Merge a group (children, group style and mask) into a single pixel layer. */
export function mergeGroup(g: GroupLayer) {
  const s = activeSession();
  if (!s) return;
  if (!g.childIds.length) return void toast('The group is empty', 'info');
  const canvas = renderLayerToDoc(s.doc, { ...g, visible: true }, { effects: true, mask: true }) ?? createCanvas(s.doc.width, s.doc.height);
  const r = mergedRaster(g, canvas, s.doc);
  r.opacity = g.opacity;
  r.blendMode = g.blendMode === 'pass-through' ? 'normal' : g.blendMode;
  ed().commit(
    'Merge Group',
    (d) => {
      for (const c of [...(d.layers[g.id] as GroupLayer).childIds]) removeLayerDraft(d, c);
      d.layers[g.id] = r;
    },
    { activeLayerId: g.id },
  );
}

/** Layer ▸ Merge Visible (Shift+Ctrl+E). Hidden top-level layers are kept. */
export function mergeVisible() {
  const s = needDoc();
  if (!s) return;
  const doc = s.doc;
  const visible = doc.rootIds.filter((id) => doc.layers[id]?.visible);
  if (visible.length < 1) return void toast('There are no visible layers to merge', 'info');
  if (visible.length === 1 && doc.layers[visible[0]].type === 'raster') return void toast('Only one visible layer — nothing to merge', 'info');
  const canvas = renderSubset(doc, visible);
  const activeRoot = s.activeLayerId ? [s.activeLayerId, ...ancestorsOf(doc, s.activeLayerId)].find((id) => visible.includes(id)) : undefined;
  const top = doc.layers[visible[visible.length - 1]];
  const base = doc.layers[activeRoot ?? top.id];
  const r = mergedRaster(base, canvas, doc);
  r.id = uid('ly_');
  r.opacity = 1;
  r.blendMode = 'normal';
  r.clipped = false;
  r.visible = true;
  ed().commit(
    'Merge Visible',
    (d) => {
      insertLayerDraft(d, r, { aboveId: top.id });
      for (const id of visible) removeLayerDraft(d, id);
    },
    { activeLayerId: r.id },
  );
}

/** Layer ▸ Flatten Image: everything (incl. background color) into one layer; hidden layers are discarded. */
export function flattenImage() {
  const s = needDoc();
  if (!s) return;
  const doc = s.doc;
  if (!doc.rootIds.length) return void toast('The document has no layers to flatten', 'info');
  const canvas = cloneCanvas(renderDocument(doc, { background: true }));
  const r = makeRasterLayer({ name: 'Background', bitmapId: bitmaps.add(canvas), width: doc.width, height: doc.height });
  ed().commit(
    'Flatten Image',
    (d) => {
      for (const id of [...d.rootIds]) removeLayerDraft(d, id);
      d.layers = {};
      insertLayerDraft(d, r, { parentId: null });
    },
    { activeLayerId: r.id },
  );
}

/* ------------------------------------------------------------------ */
/* Layer effects (styles)                                              */
/* ------------------------------------------------------------------ */

export function makeEffect(effectId: string, params?: ParamValues): LayerEffect {
  const def = effects.get(effectId);
  return { id: uid('ef_'), effectId, enabled: true, params: { ...(def ? defaultParams(def.params) : {}), ...structuredClone(params ?? {}) } };
}

function styleTarget(action: string): { s: DocSession; layer: Layer } | null {
  const ctx = needLayer(action);
  if (!ctx) return null;
  if (ctx.layer.type === 'adjustment') {
    toast('Adjustment layers cannot have layer styles', 'info');
    return null;
  }
  return ctx;
}

/** Add an effect to the active layer and show the Effects panel. Returns the new effect id. */
export function addEffect(effectId: string, params?: ParamValues, opts: { showPanel?: boolean } = {}): ID | null {
  const ctx = styleTarget('add a layer style to');
  if (!ctx) return null;
  const e = makeEffect(effectId, params);
  ed().commit(`Add ${effectName(effectId)}`, (d) => {
    d.layers[ctx.layer.id].effects.push(e);
  });
  if (opts.showPanel !== false) showPanel('effects');
  useLayersUI.getState().setExpandedEffect(e.id);
  return e.id;
}

export function applyStylePreset(preset: StylePreset, replace = false) {
  const ctx = styleTarget('apply a style to');
  if (!ctx) return;
  const list = preset.effects.map((e) => makeEffect(e.effectId, e.params));
  ed().commit(`Style: ${preset.name}`, (d) => {
    const l = d.layers[ctx.layer.id];
    l.effects = replace ? list : [...l.effects, ...list];
  });
}

export function updateEffect(layerId: ID, effectInstId: ID, change: (e: LayerEffect) => void, phase: Phase, label?: string) {
  const l = activeSession()?.doc.layers[layerId];
  const e = l?.effects.find((x) => x.id === effectInstId);
  if (!e) return;
  editLayers([layerId], label ?? `Edit ${effectName(e.effectId)}`, (dl) => {
    const de = dl.effects.find((x) => x.id === effectInstId);
    if (de) change(de);
  }, phase);
}

export function toggleEffect(layerId: ID, effectInstId: ID) {
  const e = activeSession()?.doc.layers[layerId]?.effects.find((x) => x.id === effectInstId);
  if (!e) return;
  updateEffect(layerId, effectInstId, (de) => (de.enabled = !e.enabled), 'commit', `${e.enabled ? 'Hide' : 'Show'} ${effectName(e.effectId)}`);
}

/** Toggle all effects of a layer (eye on the "Effects" row). */
export function toggleAllEffects(layerId: ID) {
  const l = activeSession()?.doc.layers[layerId];
  if (!l?.effects.length) return;
  const on = !l.effects.some((e) => e.enabled);
  ed().commit(on ? 'Show Layer Effects' : 'Hide Layer Effects', (d) => {
    d.layers[layerId].effects.forEach((e) => (e.enabled = on));
  });
}

export function removeEffect(layerId: ID, effectInstId: ID) {
  const e = activeSession()?.doc.layers[layerId]?.effects.find((x) => x.id === effectInstId);
  if (!e) return;
  ed().commit(`Delete ${effectName(e.effectId)}`, (d) => {
    const l = d.layers[layerId];
    l.effects = l.effects.filter((x) => x.id !== effectInstId);
  });
}

export function duplicateEffect(layerId: ID, effectInstId: ID) {
  const l = activeSession()?.doc.layers[layerId];
  const i = l?.effects.findIndex((x) => x.id === effectInstId) ?? -1;
  if (!l || i < 0) return;
  const copy: LayerEffect = { ...structuredClone(l.effects[i]), id: uid('ef_') };
  ed().commit(`Duplicate ${effectName(copy.effectId)}`, (d) => {
    d.layers[layerId].effects.splice(i + 1, 0, copy);
  });
}

export function moveEffect(layerId: ID, from: number, to: number) {
  const l = activeSession()?.doc.layers[layerId];
  if (!l || from === to || from < 0 || from >= l.effects.length) return;
  const t = Math.max(0, Math.min(l.effects.length - 1, to));
  ed().commit('Reorder Effects', (d) => {
    const list = d.layers[layerId].effects;
    const [e] = list.splice(from, 1);
    list.splice(t, 0, e);
  });
}

/* ---- style clipboard ---- */

interface LayersUIState {
  /** Copied layer style (effects). */
  styleClipboard: LayerEffect[] | null;
  /** Effect instance expanded in the Effects panel. */
  expandedEffect: ID | null;
  setStyleClipboard(fx: LayerEffect[] | null): void;
  setExpandedEffect(id: ID | null): void;
}

export const useLayersUI = create<LayersUIState>()((set) => ({
  styleClipboard: null,
  expandedEffect: null,
  setStyleClipboard: (fx) => set({ styleClipboard: fx }),
  setExpandedEffect: (id) => set({ expandedEffect: id }),
}));

export function copyStyle() {
  const ctx = needLayer('copy its layer style');
  if (!ctx) return;
  if (!ctx.layer.effects.length) return void toast(`“${ctx.layer.name}” has no layer style to copy`, 'info');
  useLayersUI.getState().setStyleClipboard(structuredClone(ctx.layer.effects));
  toast(`Copied layer style (${ctx.layer.effects.length} ${plural(ctx.layer.effects.length, 'effect', 'effects')})`, 'info', 1800);
}

export function pasteStyle() {
  const s = needDoc();
  if (!s) return;
  const clip = useLayersUI.getState().styleClipboard;
  if (!clip) return void toast('Copy a layer style first (Layer ▸ Layer Style ▸ Copy Layer Style)', 'info');
  const ids = selectedIds(s).filter((id) => s.doc.layers[id].type !== 'adjustment');
  if (!ids.length) return void toast('Select a layer to paste the style onto', 'info');
  ed().commit('Paste Layer Style', (d) => {
    for (const id of ids) d.layers[id].effects = clip.map((e) => ({ ...structuredClone(e), id: uid('ef_') }));
  });
}

export function clearStyle() {
  const s = needDoc();
  if (!s) return;
  const ids = selectedIds(s).filter((id) => s.doc.layers[id].effects.length);
  if (!ids.length) return void toast('The selected layer has no layer style', 'info');
  ed().commit('Clear Layer Style', (d) => {
    for (const id of ids) d.layers[id].effects = [];
  });
}

/* ------------------------------------------------------------------ */
/* Smart filters                                                       */
/* ------------------------------------------------------------------ */

export function updateFilter(layerId: ID, filterInstId: ID, change: (f: FilterInstance) => void, phase: Phase, label = 'Edit Smart Filter') {
  editLayers([layerId], label, (l) => {
    const f = l.filters.find((x) => x.id === filterInstId);
    if (f) change(f);
  }, phase);
}

export function toggleFilter(layerId: ID, filterInstId: ID) {
  const f = activeSession()?.doc.layers[layerId]?.filters.find((x) => x.id === filterInstId);
  if (!f) return;
  updateFilter(layerId, filterInstId, (x) => (x.enabled = !f.enabled), 'commit', f.enabled ? 'Hide Smart Filter' : 'Show Smart Filter');
}

export function toggleAllFilters(layerId: ID) {
  const l = activeSession()?.doc.layers[layerId];
  if (!l?.filters.length) return;
  const on = !l.filters.some((f) => f.enabled);
  ed().commit(on ? 'Show Smart Filters' : 'Hide Smart Filters', (d) => {
    d.layers[layerId].filters.forEach((f) => (f.enabled = on));
  });
}

export function removeFilter(layerId: ID, filterInstId: ID) {
  ed().commit('Delete Smart Filter', (d) => {
    const l = d.layers[layerId];
    if (l) l.filters = l.filters.filter((f) => f.id !== filterInstId);
  });
}

export function moveFilter(layerId: ID, from: number, to: number) {
  const l = activeSession()?.doc.layers[layerId];
  if (!l || from === to || to < 0 || to >= l.filters.length) return;
  ed().commit('Reorder Smart Filters', (d) => {
    const list = d.layers[layerId].filters;
    const [f] = list.splice(from, 1);
    list.splice(to, 0, f);
  });
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

/** Clicking a mask thumbnail: activate the layer and paint on its mask. */
export function editMaskOf(id: ID) {
  const st = ed();
  const s = activeSession();
  if (!s?.doc.layers[id]?.mask) return;
  if (s.activeLayerId !== id) st.setActiveLayer(id);
  ed().setEditTarget('mask');
}

export function editContentOf(id: ID) {
  const s = activeSession();
  if (!s) return;
  if (s.activeLayerId !== id) ed().setActiveLayer(id);
  ed().setEditTarget('content');
}

/** Parent of the active layer (for UI). */
export function parentGroupOf(id: ID): ID | null {
  const s = activeSession();
  return s ? (parentOf(s.doc, id) ?? null) : null;
}

/** Request a viewport redraw (after silent changes). */
export function refreshView() {
  viewport.requestRender();
}
