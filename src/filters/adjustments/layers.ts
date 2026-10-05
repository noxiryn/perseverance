/**
 * Adjustment-layer operations (all undoable through the editor store):
 * create above the active layer (optionally clipped), live-preview / commit param edits,
 * reset, toggle clip/visibility, delete. Also helpers shared by the Auto commands.
 */
import type { AdjustmentLayer, Document, ID, ParamValues, RasterLayer } from '../../core/types';
import { flattenIds, insertLayerDraft, isAncestor, makeAdjustmentLayer, nextLayerName, siblingsOf } from '../../core/document';
import { createCanvas, ctx2d } from '../../core/canvas';
import { transformMatrix } from '../../core/geometry';
import { filters, type FilterDef } from '../../registry';
import { activeSession, useEditor } from '../../state/editor';
import { toast, useUI } from '../../state/ui';
import { getSelectionMask } from '../../editor/selection';
import { defaultParams, resolveParams } from '../engine';
import { useAdjustmentsPrefs } from './prefs';
import { sameParams } from './presets';

export const NO_DOC_MESSAGE = 'Open or create a document first (File ▸ New or File ▸ Open).';

export interface InsertionPoint {
  aboveId?: ID | null;
  parentId?: ID | null;
  index?: number;
}

/**
 * Where a new adjustment layer goes — the same rule as the Layers panel (layerOps.insertNewLayer):
 * at the top of an expanded active group, otherwise directly above the active layer (top of the
 * root when nothing is active). `inClipGroup` is true when that spot is inside a clipping group —
 * above a clipped layer, or between a base layer and the layers clipped to it. A layer inserted
 * there must be clipped too, otherwise it would silently become the new base of the clipped
 * layers above it and change what they affect.
 */
export function adjustmentInsertion(doc: Document, activeLayerId: ID | null | undefined): { at: InsertionPoint; inClipGroup: boolean } {
  const active = activeLayerId ? doc.layers[activeLayerId] : undefined;
  if (!active) return { at: { parentId: null, index: doc.rootIds.length }, inClipGroup: false };
  if (active.type === 'group' && !active.collapsed) {
    return { at: { parentId: active.id, index: active.childIds.length }, inClipGroup: false };
  }
  const sibs = siblingsOf(doc, active.id);
  const aboveId = sibs[sibs.indexOf(active.id) + 1];
  const above = aboveId ? doc.layers[aboveId] : undefined;
  return { at: { aboveId: active.id }, inClipGroup: !!active.clipped || !!above?.clipped };
}

export interface ClipOptions {
  /** Force the clipping state (overrides everything else). */
  clipped?: boolean;
  /** Alt-click: invert the automatic clipping state. */
  invertClip?: boolean;
  /** Ignore the panel's "Clip to Layer by Default" preference (only follow the clipping group). */
  ignoreClipPref?: boolean;
}

/** Clipping state of a new adjustment layer: joins the clipping group it lands in, or follows the preference. */
export function resolveClipped(o: ClipOptions, inClipGroup: boolean, clipByDefault: boolean): boolean {
  if (o.clipped !== undefined) return o.clipped;
  const auto = inClipGroup || (!o.ignoreClipPref && clipByDefault);
  return o.invertClip ? !auto : auto;
}

/**
 * Create an adjustment layer for `filterId` above the active layer (or at the top of an expanded
 * active group) and select it. Inside a clipping group the new layer is clipped as well, so the
 * existing stack keeps affecting the same layers. Returns the new layer id, or null (with a toast).
 */
export function createAdjustmentLayer(
  filterId: string,
  opts: ClipOptions & { params?: ParamValues; name?: string; label?: string; reveal?: boolean } = {},
): ID | null {
  const s = activeSession();
  if (!s) {
    toast(NO_DOC_MESSAGE, 'info');
    return null;
  }
  const def = filters.get(filterId);
  if (!def) {
    toast(`The “${filterId}” adjustment is not available.`, 'error');
    return null;
  }
  if (!def.adjustment) {
    toast(`${def.name} can't be used as an adjustment layer — apply it from the Filter menu instead.`, 'warning');
    return null;
  }
  const params = { ...defaultParams(def.params), ...structuredClone(opts.params ?? {}) };
  const layer = makeAdjustmentLayer({ name: opts.name ?? nextLayerName(s.doc, def.name), filterId, params });
  const { at, inClipGroup } = adjustmentInsertion(s.doc, s.activeLayerId);
  layer.clipped = resolveClipped(opts, inClipGroup, useAdjustmentsPrefs.getState().clipByDefault);
  useEditor.getState().commit(opts.label ?? `New ${def.name} Layer`, (d) => insertLayerDraft(d, layer, at), { activeLayerId: layer.id });
  if (opts.reveal) revealEditor();
  return layer.id;
}

/** Make sure an adjustment editor is visible (Adjustments or Properties panel). */
export function revealEditor() {
  const ui = useUI.getState();
  const visible = (id: string) =>
    ui.flyoutPanel === id || ui.workspace.groups.some((g) => !g.collapsed && g.active === id && g.tabs.includes(id));
  if (visible('adjustments') || visible('properties')) return;
  const inDock = (id: string) => ui.workspace.groups.some((g) => g.tabs.includes(id));
  ui.showPanel(inDock('properties') ? 'properties' : 'adjustments');
}

function adjustmentOf(doc: Document | null | undefined, id: ID): AdjustmentLayer | null {
  const l = doc?.layers[id];
  return l && l.type === 'adjustment' ? l : null;
}

/** Live preview of new params (no history entry). */
export function previewAdjustmentParams(layerId: ID, params: ParamValues) {
  if (!adjustmentOf(activeSession()?.doc, layerId)) return;
  useEditor.getState().preview((d) => {
    const l = d.layers[layerId];
    if (l?.type === 'adjustment') l.adjustment.params = params;
  });
}

/** Params of `layerId` in the committed (history) document — what an edit is compared against. */
function committedParams(layerId: ID): ParamValues | null {
  const s = activeSession();
  const l = s?.history.entries[s.history.index]?.doc.layers[layerId];
  return l && l.type === 'adjustment' ? l.adjustment.params : null;
}

/**
 * True when `params` would not change the committed layer. Then any live preview is reverted
 * and no history entry is recorded (clicking a slider without moving it, Tab out of a field,
 * Reset on an untouched layer…), so the document doesn't turn dirty for nothing.
 */
function isNoop(def: FilterDef | undefined, layerId: ID, params: ParamValues): boolean {
  const base = committedParams(layerId);
  if (!base || !sameParams(def, base, params)) return false;
  useEditor.getState().cancelPreview();
  return true;
}

/** Commit params as one (coalesced) history step. */
export function commitAdjustmentParams(layerId: ID, params: ParamValues, label?: string) {
  const l = adjustmentOf(activeSession()?.doc, layerId);
  if (!l) return;
  const def = filters.get(l.adjustment.filterId);
  if (isNoop(def, layerId, params)) return;
  useEditor.getState().commit(
    label ?? `Edit ${def?.name ?? 'Adjustment'}`,
    (d) => {
      const t = d.layers[layerId];
      if (t?.type === 'adjustment') t.adjustment.params = params;
    },
    { coalesce: true },
  );
}

/** Replace params with defaults merged with `params` (presets, reset). */
export function setAdjustmentParams(layerId: ID, params: ParamValues, label: string) {
  const l = adjustmentOf(activeSession()?.doc, layerId);
  if (!l) return;
  const def = filters.get(l.adjustment.filterId);
  const full = def ? resolveParams(def, structuredClone(params)) : structuredClone(params);
  if (isNoop(def, layerId, full)) return;
  useEditor.getState().commit(label, (d) => {
    const t = d.layers[layerId];
    if (t?.type === 'adjustment') t.adjustment.params = full;
  });
}

export function resetAdjustment(layerId: ID) {
  const l = adjustmentOf(activeSession()?.doc, layerId);
  if (!l) return;
  const def = filters.get(l.adjustment.filterId);
  setAdjustmentParams(layerId, {}, `Reset ${def?.name ?? 'Adjustment'}`);
}

export function toggleClipped(layerId: ID) {
  const l = activeSession()?.doc.layers[layerId];
  if (!l) return;
  useEditor.getState().updateLayer(layerId, { clipped: !l.clipped }, l.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask');
}

export function toggleVisible(layerId: ID) {
  const l = activeSession()?.doc.layers[layerId];
  if (!l) return;
  useEditor.getState().updateLayer(layerId, { visible: !l.visible }, l.visible ? 'Hide Layer' : 'Show Layer');
}

export function deleteAdjustmentLayer(layerId: ID) {
  const l = activeSession()?.doc.layers[layerId];
  if (!l) return;
  if (l.locks.all) {
    toast('This layer is locked. Unlock it in the Layers panel to delete it.', 'warning');
    return;
  }
  useEditor.getState().removeLayers([layerId], 'Delete Layer');
}

/* ---------------- helpers for Auto commands / histograms ---------------- */

/**
 * Layers that are above `layerId` in global stacking order (excluding its own descendants).
 * Hiding them renders the composite "up to and including" the layer.
 */
export function layersAbove(doc: Document, layerId: ID): Set<ID> {
  const order = flattenIds(doc);
  const i = order.indexOf(layerId);
  const out = new Set<ID>();
  if (i < 0) return out;
  for (const id of order.slice(i + 1)) if (!isAncestor(doc, layerId, id)) out.add(id);
  return out;
}

/** Selection mask mapped into a raster layer's local pixel space (alpha per pixel), or null. */
export function layerSelectionMask(doc: Document, layer: RasterLayer): Uint8ClampedArray | null {
  const sel = getSelectionMask(doc);
  if (!sel) return null;
  const c = createCanvas(layer.width, layer.height);
  const ctx = ctx2d(c, { willReadFrequently: true });
  const inv = transformMatrix(layer.transform, layer.width, layer.height).inverse();
  ctx.setTransform(inv);
  ctx.drawImage(sel, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8ClampedArray(layer.width * layer.height);
  for (let p = 0, i = 3; p < out.length; p++, i += 4) out[p] = d[i];
  return out;
}
