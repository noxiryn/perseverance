/**
 * CONTRACT (owned by the looks/templates module): apply a registered Look (one-click style) to
 * the active document, targeting a layer (e.g. the Roblox character) or the whole document when
 * targetLayerId is null. Must be ONE history step.
 *
 * How a declarative LookDef is applied:
 *  - layerFilters → smart filters appended to the target layer (raster/text/shape/fill).
 *    With no target (whole document) they become filter "adjustment" layers in the look group
 *    (Roblox character filters are skipped there — they need a character's alpha).
 *  - layerEffects → layer style entries appended to the target (any layer but adjustments).
 *  - overlays → generated asset layers, adjustments → adjustment layers; both live in a
 *    pass-through group "Look: <name>" at the top of the document (meta {lookId}).
 * The ids of filters/effects added to the target are tracked in `layer.meta.look`, so applying
 * another look (or the same one again) replaces the previous look instead of stacking.
 * Missing filter/effect/asset ids are skipped with a console warning.
 */
import type { Document, FilterInstance, GroupLayer, ID, Layer, LayerEffect, RasterLayer } from '../core/types';
import { effects, filters, looks, type LookDef } from '../registry';
import { toast } from '../state/ui';
import { activeSession, useEditor } from '../state/editor';
import { insertLayerDraft, makeAdjustmentLayer, makeFilterInstance, makeGroupLayer, parentOf, removeLayerDraft } from '../core/document';
import { createAssetLayer } from '../assets/place';
import { resolveParams } from '../filters/engine';
import { uid } from '../core/ids';

/** Key under `layer.meta` holding the look applied to that layer. */
export const LOOK_META_KEY = 'look';

export interface LookLayerMeta {
  lookId: string;
  filterIds: ID[];
  effectIds: ID[];
}

export type LookOverlay = NonNullable<LookDef['overlays']>[number];

/** Creates the raster layer for an overlay (swappable so previews can render at low resolution). */
export type OverlayFactory = (overlay: LookOverlay, docWidth: number, docHeight: number) => RasterLayer | null;

export interface BuiltLook {
  lookId: string;
  lookName: string;
  /** Smart filters for the target layer. */
  filters: FilterInstance[];
  /** Layer effects for the target layer. */
  effects: LayerEffect[];
  /** Children of the look group, bottom → top. */
  groupLayers: Layer[];
  /** Human readable list of parts that were skipped (missing ids, unsupported target…). */
  skipped: string[];
}

export interface TargetCaps {
  filters: boolean;
  effects: boolean;
}

/** What a layer can receive from a look. */
export function targetCaps(layer: Layer | null | undefined): TargetCaps {
  if (!layer) return { filters: false, effects: false };
  switch (layer.type) {
    case 'raster':
    case 'text':
    case 'shape':
    case 'fill':
      return { filters: true, effects: true };
    case 'group':
      return { filters: false, effects: true };
    default:
      return { filters: false, effects: false };
  }
}

export function lookMetaOf(layer: Layer | null | undefined): LookLayerMeta | null {
  const m = layer?.meta?.[LOOK_META_KEY] as LookLayerMeta | undefined;
  return m && typeof m === 'object' && typeof m.lookId === 'string' ? m : null;
}

export function isLookGroup(layer: Layer | null | undefined): layer is GroupLayer {
  return !!layer && layer.type === 'group' && typeof layer.meta?.lookId === 'string';
}

/** The look groups currently in a document. */
export function lookGroups(doc: Document): GroupLayer[] {
  return Object.values(doc.layers).filter(isLookGroup);
}

/** True when the layer is a look group or lives inside one. */
export function isInsideLookGroup(doc: Document, id: ID): boolean {
  let cur: ID | null | undefined = id;
  while (cur) {
    if (isLookGroup(doc.layers[cur])) return true;
    cur = parentOf(doc, cur);
  }
  return false;
}

/** Look id currently applied: the target's own look first, then the document's look group. */
export function currentLookId(doc: Document | null, targetId: ID | null): string | null {
  if (!doc) return null;
  const t = targetId ? lookMetaOf(doc.layers[targetId]) : null;
  if (t) return t.lookId;
  const g = lookGroups(doc)[0];
  return g ? String(g.meta!.lookId) : null;
}

/** Whether there is anything a "Remove look" could remove for this target. */
export function hasLook(doc: Document | null, targetId: ID | null): boolean {
  if (!doc) return false;
  if (lookGroups(doc).length) return true;
  if (targetId) return !!lookMetaOf(doc.layers[targetId]);
  return Object.values(doc.layers).some((l) => !!lookMetaOf(l));
}

const defaultOverlayFactory: OverlayFactory = (o, w, h) =>
  createAssetLayer(o.assetId, o.params, w, h, { name: o.name, blendMode: o.blendMode, opacity: o.opacity });

/**
 * Resolve a LookDef against the registries into concrete layers/instances (no store access).
 * Overlay bitmaps are generated here (side effect on the bitmap store only).
 */
export function buildLook(look: LookDef, doc: Document, targetId: ID | null, makeOverlay: OverlayFactory = defaultOverlayFactory): BuiltLook {
  const target = targetId ? (doc.layers[targetId] ?? null) : null;
  const caps = targetCaps(target);
  const out: BuiltLook = { lookId: look.id, lookName: look.name, filters: [], effects: [], groupLayers: [], skipped: [] };
  const converted: Layer[] = [];
  const overlays: Layer[] = [];
  const adjustments: Layer[] = [];
  const warn = (what: string) => {
    out.skipped.push(what);
    console.warn(`[looks] ${look.id}: skipped ${what}`);
  };

  for (const lf of look.layerFilters ?? []) {
    const def = filters.get(lf.filterId);
    if (!def) {
      warn(`filter "${lf.filterId}" (not registered)`);
      continue;
    }
    const params = resolveParams(def, lf.params);
    if (caps.filters) out.filters.push(makeFilterInstance(def.id, params));
    else if (!target) {
      if (def.category === 'Roblox') {
        warn(`character filter "${def.id}" (needs a target layer)`);
        continue;
      }
      converted.push(makeAdjustmentLayer({ name: def.name, filterId: def.id, params }));
    } else warn(`filter "${def.id}" (a ${target.type} layer can't hold smart filters)`);
  }

  for (const le of look.layerEffects ?? []) {
    const def = effects.get(le.effectId);
    if (!def) {
      warn(`effect "${le.effectId}" (not registered)`);
      continue;
    }
    if (!caps.effects) {
      warn(`effect "${def.id}" (needs a target layer)`);
      continue;
    }
    out.effects.push({ id: uid('lfx_'), effectId: def.id, enabled: true, params: resolveParams(def, le.params) });
  }

  for (const o of look.overlays ?? []) {
    let layer: RasterLayer | null = null;
    try {
      layer = makeOverlay(o, doc.width, doc.height);
    } catch (e) {
      console.warn(`[looks] overlay ${o.assetId} failed`, e);
    }
    if (!layer) {
      warn(`overlay "${o.assetId}" (asset not available)`);
      continue;
    }
    if (o.name) layer.name = o.name;
    if (o.blendMode) layer.blendMode = o.blendMode;
    if (o.opacity !== undefined) layer.opacity = o.opacity;
    overlays.push(layer);
  }

  for (const a of look.adjustments ?? []) {
    const def = filters.get(a.filterId);
    if (!def) {
      warn(`adjustment "${a.filterId}" (not registered)`);
      continue;
    }
    const layer = makeAdjustmentLayer({ name: a.name ?? def.name, filterId: def.id, params: resolveParams(def, a.params) });
    if (a.blendMode) layer.blendMode = a.blendMode;
    if (a.opacity !== undefined) layer.opacity = a.opacity;
    adjustments.push(layer);
  }

  // Filters first, then textures/overlays, then the color grade on top so it unifies everything.
  out.groupLayers = [...converted, ...overlays, ...adjustments];
  return out;
}

/**
 * Remove look artifacts from a draft: every look group, plus the tracked filters/effects of the
 * target layer (or of every layer when `allLayers`). Returns true when something changed.
 */
export function stripLookDraft(d: Document, targetId: ID | null, allLayers = false): boolean {
  let changed = false;
  for (const g of lookGroups(d).map((x) => x.id)) {
    if (!d.layers[g]) continue; // already removed with an enclosing group
    removeLayerDraft(d, g);
    changed = true;
  }
  const clean = allLayers ? Object.keys(d.layers) : targetId && d.layers[targetId] ? [targetId] : [];
  for (const id of clean) {
    const l = d.layers[id];
    const m = lookMetaOf(l);
    if (!m) continue;
    const fids = new Set(m.filterIds);
    const eids = new Set(m.effectIds);
    l.filters = l.filters.filter((f) => !fids.has(f.id));
    l.effects = l.effects.filter((e) => !eids.has(e.id));
    const meta = { ...l.meta };
    delete meta[LOOK_META_KEY];
    l.meta = Object.keys(meta).length ? meta : undefined;
    if (!l.meta) delete l.meta;
    changed = true;
  }
  return changed;
}

/** Insert a built look into a draft (replacing any previous look). Returns the look group id. */
export function insertLookDraft(d: Document, built: BuiltLook, targetId: ID | null): ID | null {
  stripLookDraft(d, targetId);
  const target = targetId ? d.layers[targetId] : undefined;
  if (target && (built.filters.length || built.effects.length)) {
    target.filters = [...target.filters, ...built.filters];
    target.effects = [...target.effects, ...built.effects];
    const meta: LookLayerMeta = {
      lookId: built.lookId,
      filterIds: built.filters.map((f) => f.id),
      effectIds: built.effects.map((e) => e.id),
    };
    target.meta = { ...target.meta, [LOOK_META_KEY]: meta };
  }
  if (!built.groupLayers.length) return null;
  const group = makeGroupLayer({ name: `Look: ${built.lookName}` });
  group.meta = { lookId: built.lookId };
  group.collapsed = true;
  insertLayerDraft(d, group, { parentId: null });
  for (const l of built.groupLayers) insertLayerDraft(d, l, { parentId: group.id });
  return group.id;
}

/** Decide the effective target for a request; returns a note when the request had to change. */
export function resolveTarget(doc: Document, requested: ID | null): { targetId: ID | null; note?: string; blocked?: string } {
  if (!requested) return { targetId: null };
  const l = doc.layers[requested];
  if (!l) return { targetId: null };
  if (isInsideLookGroup(doc, requested)) return { targetId: null, note: 'look layers can’t be a target — applied to the whole document' };
  if (l.type === 'adjustment') return { targetId: null, note: 'adjustment layers can’t hold a look — applied to the whole document' };
  if (l.locks.all) return { targetId: requested, blocked: `“${l.name}” is locked. Unlock it or switch the Looks target to Whole document.` };
  return { targetId: requested };
}

export async function applyLook(lookId: string, targetLayerId: ID | null): Promise<void> {
  const s = activeSession();
  if (!s) {
    toast('Open or create a document first, then pick a look.', 'warning');
    return;
  }
  const look = looks.get(lookId);
  if (!look) {
    toast(`Look “${lookId}” is not available.`, 'error');
    return;
  }
  if (look.apply) {
    try {
      await look.apply(targetLayerId);
    } catch (e) {
      console.error(e);
      toast(`Look “${look.name}” failed: ${(e as Error).message ?? e}`, 'error');
    }
    return;
  }
  const { targetId, note, blocked } = resolveTarget(s.doc, targetLayerId);
  if (blocked) {
    toast(blocked, 'warning', 3600);
    return;
  }
  const built = buildLook(look, s.doc, targetId);
  if (!built.filters.length && !built.effects.length && !built.groupLayers.length) {
    toast(`“${look.name}” needs filters/assets that aren’t available yet.`, 'warning', 3600);
    return;
  }
  useEditor.getState().commit(`Apply Look: ${look.name}`, (d) => {
    insertLookDraft(d, built, targetId);
  });
  const targetName = targetId ? s.doc.layers[targetId]?.name : null;
  const where = targetName ? ` to “${targetName}”` : ' to the whole document';
  toast(`Applied look “${look.name}”${where}${note ? ` (${note})` : ''}.`, 'success', note ? 4200 : 2600);
}

/**
 * Remove the current look: the look group(s) plus the look's filters/effects on the target layer
 * (or on every layer when targetLayerId is null). One history step.
 */
export function removeLook(targetLayerId: ID | null): void {
  const s = activeSession();
  if (!s) {
    toast('No document is open.', 'warning');
    return;
  }
  if (!hasLook(s.doc, targetLayerId)) {
    toast(targetLayerId ? 'No look on this layer or document.' : 'This document has no look applied.', 'info');
    return;
  }
  useEditor.getState().commit('Remove Look', (d) => {
    stripLookDraft(d, targetLayerId, targetLayerId === null);
  });
  toast('Look removed.', 'success');
}
