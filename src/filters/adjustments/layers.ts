/**
 * Adjustment-layer operations (all undoable through the editor store):
 * create above the active layer (optionally clipped), live-preview / commit param edits,
 * reset, toggle clip/visibility, delete. Also helpers shared by the Auto commands.
 */
import type { AdjustmentLayer, Document, ID, ParamValues, RasterLayer } from '../../core/types';
import { flattenIds, isAncestor, makeAdjustmentLayer, nextLayerName } from '../../core/document';
import { createCanvas, ctx2d } from '../../core/canvas';
import { transformMatrix } from '../../core/geometry';
import { filters } from '../../registry';
import { activeSession, useEditor } from '../../state/editor';
import { toast, useUI } from '../../state/ui';
import { getSelectionMask } from '../../editor/selection';
import { defaultParams, resolveParams } from '../engine';
import { useAdjustmentsPrefs } from './prefs';

export const NO_DOC_MESSAGE = 'Open or create a document first (File ▸ New or File ▸ Open).';

/**
 * Create an adjustment layer for `filterId` above the active layer and select it.
 * Returns the new layer id, or null (with a toast) when it cannot be created.
 */
export function createAdjustmentLayer(
  filterId: string,
  opts: { clipped?: boolean; params?: ParamValues; name?: string; label?: string; reveal?: boolean } = {},
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
  layer.clipped = opts.clipped ?? useAdjustmentsPrefs.getState().clipByDefault;
  const aboveId = s.activeLayerId && s.doc.layers[s.activeLayerId] ? s.activeLayerId : null;
  useEditor.getState().addLayer(layer, { aboveId, label: opts.label ?? `New ${def.name} Layer` });
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

/** Commit params as one (coalesced) history step. */
export function commitAdjustmentParams(layerId: ID, params: ParamValues, label?: string) {
  const l = adjustmentOf(activeSession()?.doc, layerId);
  if (!l) return;
  const def = filters.get(l.adjustment.filterId);
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
