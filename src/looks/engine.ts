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
 *  - overlays → generated asset layers (optionally confined by a mask, see ExtLookDef),
 *    adjustments → adjustment layers; both live in a pass-through group "Look: <name>" at the top
 *    of the document (meta {lookId, lookLayerIds}). Atmosphere overlays marked
 *    `placement: 'behind'` (smoke, rays, fog, bokeh…) go into a second look group directly BELOW
 *    the target instead, so the character stands in front of them (as in the templates) — unless
 *    the target still has an opaque background (never cut out) or is a fill layer, which would
 *    hide them: then they stay on top and the toast says why.
 *  - overlays whose asset is already in the document (e.g. a template's own film scratches) and
 *    adjustments whose filter is already an adjustment layer (the template's Contrast) are
 *    skipped instead of being doubled; a vignette asset and a vignette adjustment count as the same.
 * Each layer filter has a scope: 'character' filters (Roblox filters, a look's character
 * treatment such as Crimson Film's gradient map + halftone) style the character; 'document'
 * filters (glitch, RGB split, risograph…) style the whole image. Whole-document mode uses the
 * document's character (doc.meta.characterId / the only character layer) as the target of the
 * character-scope filters and of the effects, and as the anchor of 'behind' overlays; the other
 * filters become filter "adjustment" layers over everything (all of them without a character).
 * A group target is redirected to the character inside it (placeholder / only pixel layer) so
 * the look's smart filters land somewhere useful.
 * The ids of filters/effects added to the target are tracked in `layer.meta.look`, so applying
 * another look (or the same one again) replaces the previous look instead of stacking. Character
 * styling has one owner at a time (src/looks/characterStyling.ts): a look that adds restyling
 * filters (color maps, halftones, cel shading…) replaces the Character Styler's and the
 * template's treatment of the target; other looks only replace filters/effects of the same type
 * (no double glow). What a look replaced is kept in its meta and restored when it is removed. Missing
 * filter/effect/asset ids are skipped with a console warning; parts skipped because of the target
 * type are reported to the user.
 */
import type { Document, FilterInstance, GroupLayer, ID, Layer, LayerEffect, RasterLayer } from '../core/types';
import { effects, filters, looks, type LookDef } from '../registry';
import { toast } from '../state/ui';
import { activeSession, useEditor } from '../state/editor';
import { flattenIds, insertLayerDraft, isEffectivelyVisible, makeAdjustmentLayer, makeFilterInstance, makeGroupLayer, parentOf, removeLayerDraft, siblingsOf } from '../core/document';
import { assetIdOfLayer, createAssetLayer } from '../assets/place';
import { resolveParams } from '../filters/engine';
import { uid } from '../core/ids';
import { createOverlayMask, type OverlayMaskSpec } from './masks';
import { adoptTemplateStylingDraft, restoreCharacterStylingDraft, restylesCharacter, takeCharacterStylingDraft, type ReplacedStyling } from './characterStyling';
import { cutoutState, prepareCutoutBake } from '../roblox/character/cutout';

/** Key under `layer.meta` holding the look applied to that layer. */
export const LOOK_META_KEY = 'look';

export interface LookLayerMeta {
  lookId: string;
  filterIds: ID[];
  effectIds: ID[];
  /** Template / Styler instances the look replaced (put back when the look is removed). */
  replaced?: ReplacedStyling;
}

export type LookOverlay = NonNullable<LookDef['overlays']>[number];

/**
 * Where an overlay goes: 'top' (default) — in the look group above everything (textures, grain,
 * vignettes, borders); 'behind' — atmosphere that would cover the subject (smoke, rays, fog,
 * bokeh, backdrops) goes directly below the target layer when there is one.
 */
export type OverlayPlacement = 'top' | 'behind';

/** Overlay with module extensions (a mask confining it, e.g. clippings kept to the edges). */
export type LookOverlayDef = LookOverlay & { mask?: OverlayMaskSpec; placement?: OverlayPlacement };

export type LookFilter = NonNullable<LookDef['layerFilters']>[number];

/**
 * What a look's layer filter styles: 'character' — the character (in whole-document mode it goes
 * on the document's character); 'document' — the whole image (in whole-document mode it becomes a
 * filter adjustment layer over everything). Default: 'character' for Roblox filters (they need a
 * character's alpha), 'document' otherwise.
 */
export type LookFilterScope = 'character' | 'document';

/** Layer filter with module extensions (its scope). */
export type LookFilterDef = LookFilter & { scope?: LookFilterScope };

export type LookAdjustment = NonNullable<LookDef['adjustments']>[number];

/** Adjustment with module extensions (a mask confining it, e.g. captured by Save as Look). */
export type LookAdjustmentDef = LookAdjustment & { mask?: OverlayMaskSpec };

/** LookDef as authored by this module (overlays/adjustments may carry masks, filters a scope). Assignable to LookDef. */
export interface ExtLookDef extends LookDef {
  overlays?: LookOverlayDef[];
  layerFilters?: LookFilterDef[];
  adjustments?: LookAdjustmentDef[];
}

/** Effective scope of a look filter whose FilterDef has `category`. */
export function lookFilterScope(lf: LookFilterDef, category: string | undefined): LookFilterScope {
  return lf.scope ?? (category === 'Roblox' ? 'character' : 'document');
}

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
  /** Overlays placed directly below the target (bottom → top); empty without a target. */
  behindLayers?: Layer[];
  /**
   * Names of 'behind' overlays kept in the top group because the target still shows an opaque
   * background (a screenshot that was never cut out would hide them completely).
   */
  behindOnTop?: string[];
  /** Names of overlays / adjustments left out because they are already in the document. */
  duplicates?: string[];
  /** The target's filters restyle the character (they replace the template / Styler treatment). */
  restyles?: boolean;
  /** Human readable list of parts that were skipped (missing ids, unsupported target…). */
  skipped: string[];
  /** Names of filters/effects dropped because the target can't hold them (shown to the user). */
  targetSkipped?: string[];
}

export interface BuildLookOptions {
  /** Resolution factor of generated masks (previews use a low value). */
  maskScale?: number;
  /** Skip overlays / adjustments already in the document (default true). */
  skipExisting?: boolean;
  /**
   * Whole-document mode with the document's character as `targetId`: only character-scope
   * filters go on it; the others become filter adjustment layers.
   */
  documentWide?: boolean;
  /**
   * Whether a target layer still shows an opaque background that would hide overlays placed
   * behind it (default: a raster layer whose pixels were never cut out, see cutoutState).
   */
  hidesBehind?: (layer: Layer) => boolean;
}

/** Default `hidesBehind`: a fill layer, or a raster layer with an opaque, unmasked background. */
export function targetHidesBehind(layer: Layer): boolean {
  return layer.type === 'fill' || (layer.type === 'raster' && cutoutState(layer) === 'background');
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

/** Whether applying `look` changes the target layer itself (filters/effects it can hold). */
export function lookTouchesTarget(look: LookDef, target: Layer | null | undefined): boolean {
  const caps = targetCaps(target);
  return (caps.filters && !!look.layerFilters?.length) || (caps.effects && !!look.layerEffects?.length);
}

/**
 * The character inside a group: a placeholder/character layer, the document's recorded
 * character, or the group's only pixel layer. Null when there is no single obvious choice.
 */
export function characterInGroup(doc: Document, groupId: ID): ID | null {
  const ids = flattenIds(doc, groupId).filter((id) => !isInsideLookGroup(doc, id));
  const isChar = (id: ID) => {
    const m = doc.layers[id]?.meta;
    return !!m && (m.kind === 'character' || m.placeholder === true);
  };
  const tagged = ids.filter((id) => doc.layers[id]?.type !== 'group' && isChar(id));
  if (tagged.length) return tagged[tagged.length - 1];
  const recorded = doc.meta?.characterId;
  if (typeof recorded === 'string' && ids.includes(recorded)) return recorded;
  const rasters = ids.filter((id) => doc.layers[id]?.type === 'raster');
  return rasters.length === 1 ? rasters[0] : null;
}

const isCharacterTagged = (l: Layer | undefined) => {
  const m = l?.meta;
  if (!m || l.type !== 'raster') return false;
  const roblox = m.roblox as { kind?: unknown } | undefined;
  return m.kind === 'character' || m.placeholder === true || roblox?.kind === 'character';
};

/** Visible character layers of a document (tagged or recorded), bottom → top. */
export function documentCharacters(doc: Document): ID[] {
  const recorded = typeof doc.meta?.characterId === 'string' ? (doc.meta.characterId as string) : null;
  return flattenIds(doc).filter((id) => {
    const l = doc.layers[id];
    if (!l || l.type !== 'raster' || isInsideLookGroup(doc, id) || !isEffectivelyVisible(doc, id)) return false;
    return id === recorded || isCharacterTagged(l);
  });
}

/**
 * The layer a whole-document look styles as "the character": the document's only character
 * layer (null when there is none, several, or it is locked).
 */
export function documentCharacter(doc: Document): ID | null {
  const ids = documentCharacters(doc);
  if (ids.length !== 1) return null;
  return doc.layers[ids[0]]?.locks.all ? null : ids[0];
}

/** Look parts that do the same thing (a vignette asset and a vignette adjustment). */
const EQUIVALENT_PARTS: Record<string, string> = { 'asset:vignette-overlay': 'vignette', 'filter:vignette': 'vignette' };

/** Canonical key of an overlay ('asset') or adjustment ('filter') part, for duplicate checks. */
export function lookPartKey(kind: 'asset' | 'filter', id: string): string {
  const k = `${kind}:${id}`;
  return EQUIVALENT_PARTS[k] ?? k;
}

/**
 * Keys (lookPartKey) of the generated asset layers and adjustment layers visible in the document
 * outside look groups — a look doesn't double them (e.g. a template's own scratches or Contrast).
 */
export function existingLookParts(doc: Document): Set<string> {
  const out = new Set<string>();
  for (const l of Object.values(doc.layers)) {
    if (isInsideLookGroup(doc, l.id) || !isEffectivelyVisible(doc, l.id)) continue;
    const a = assetIdOfLayer(l);
    if (a) out.add(lookPartKey('asset', a));
    else if (l.type === 'adjustment') out.add(lookPartKey('filter', l.adjustment.filterId));
  }
  return out;
}

/**
 * Where the 'behind' look group goes for a subject: directly below it in its parent list, or
 * below the base of its clipping group when the subject is clipped (inserting between a clipped
 * layer and its base would break the clip).
 */
export function behindInsertionPoint(d: Document, subjectId: ID): { parentId: ID | null; index: number } | null {
  if (!d.layers[subjectId]) return null;
  const parentId = parentOf(d, subjectId) ?? null;
  const list = siblingsOf(d, subjectId);
  let index = list.indexOf(subjectId);
  if (index < 0) return null;
  while (index > 0 && d.layers[list[index]]?.clipped) index--;
  return { parentId, index };
}

const defaultOverlayFactory: OverlayFactory = (o, w, h) =>
  createAssetLayer(o.assetId, o.params, w, h, { name: o.name, blendMode: o.blendMode, opacity: o.opacity });

/**
 * Resolve a LookDef against the registries into concrete layers/instances (no store access).
 * Overlay (and mask) bitmaps are generated here (side effect on the bitmap store only).
 */
export function buildLook(
  look: LookDef,
  doc: Document,
  targetId: ID | null,
  makeOverlay: OverlayFactory = defaultOverlayFactory,
  opts: BuildLookOptions = {},
): BuiltLook {
  const target = targetId ? (doc.layers[targetId] ?? null) : null;
  const caps = targetCaps(target);
  const out: BuiltLook = { lookId: look.id, lookName: look.name, filters: [], effects: [], groupLayers: [], behindLayers: [], behindOnTop: [], duplicates: [], skipped: [], targetSkipped: [] };
  const existing = opts.skipExisting === false ? new Set<string>() : existingLookParts(doc);
  const behind: Layer[] = [];
  const converted: Layer[] = [];
  const overlays: Layer[] = [];
  const adjustments: Layer[] = [];
  const warn = (what: string) => {
    out.skipped.push(what);
    console.warn(`[looks] ${look.id}: skipped ${what}`);
  };
  const targetSkip = (name: string, what: string) => {
    out.skipped.push(what);
    out.targetSkipped!.push(name);
  };

  const duplicate = (name: string, what: string) => {
    out.duplicates!.push(name);
    out.skipped.push(`${what} (already in the document)`);
  };
  const documentWide = !!opts.documentWide && !!target;

  for (const lf of (look as ExtLookDef).layerFilters ?? []) {
    const def = filters.get(lf.filterId);
    if (!def) {
      warn(`filter "${lf.filterId}" (not registered)`);
      continue;
    }
    const params = resolveParams(def, lf.params);
    const scope = lookFilterScope(lf, def.category);
    if (caps.filters && (!documentWide || scope === 'character')) out.filters.push(makeFilterInstance(def.id, params));
    else if (!target || documentWide) {
      if (def.category === 'Roblox') {
        targetSkip(def.name, `character filter "${def.id}" (needs a target layer)`);
        continue;
      }
      if (existing.has(lookPartKey('filter', def.id))) {
        duplicate(def.name, `filter "${def.id}"`);
        continue;
      }
      converted.push(makeAdjustmentLayer({ name: def.name, filterId: def.id, params }));
    } else targetSkip(def.name, `filter "${def.id}" (a ${target.type} layer can't hold smart filters)`);
  }
  out.restyles = restylesCharacter(out.filters.map((f) => f.filterId));

  for (const le of look.layerEffects ?? []) {
    const def = effects.get(le.effectId);
    if (!def) {
      warn(`effect "${le.effectId}" (not registered)`);
      continue;
    }
    if (!caps.effects) {
      targetSkip(def.name, `effect "${def.id}" (needs a target layer)`);
      continue;
    }
    out.effects.push({ id: uid('lfx_'), effectId: def.id, enabled: true, params: resolveParams(def, le.params) });
  }

  let hidden: boolean | undefined;
  for (const o of (look as ExtLookDef).overlays ?? []) {
    if (existing.has(lookPartKey('asset', o.assetId))) {
      duplicate(o.name ?? o.assetId, `overlay "${o.assetId}"`);
      continue;
    }
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
    if (o.mask) {
      const m = createOverlayMask(o.mask, doc.width, doc.height, opts.maskScale ?? 1);
      if (m) layer.mask = m.mask;
    }
    // Behind a fill layer or a target that still has its opaque background (never cut out) the
    // atmosphere would be hidden completely: keep it on top then.
    if (o.placement === 'behind' && target) {
      hidden ??= (opts.hidesBehind ?? targetHidesBehind)(target);
      if (!hidden) behind.push(layer);
      else (overlays.push(layer), out.behindOnTop!.push(layer.name));
    } else overlays.push(layer);
  }

  for (const a of (look as ExtLookDef).adjustments ?? []) {
    const def = filters.get(a.filterId);
    if (!def) {
      warn(`adjustment "${a.filterId}" (not registered)`);
      continue;
    }
    if (existing.has(lookPartKey('filter', def.id))) {
      duplicate(a.name ?? def.name, `adjustment "${def.id}"`);
      continue;
    }
    const layer = makeAdjustmentLayer({ name: a.name ?? def.name, filterId: def.id, params: resolveParams(def, a.params) });
    if (a.blendMode) layer.blendMode = a.blendMode;
    if (a.opacity !== undefined) layer.opacity = a.opacity;
    if (a.mask) {
      const m = createOverlayMask(a.mask, doc.width, doc.height, opts.maskScale ?? 1);
      if (m) layer.mask = m.mask;
    }
    adjustments.push(layer);
  }

  // Filters first, then textures/overlays, then the color grade on top so it unifies everything.
  out.groupLayers = [...converted, ...overlays, ...adjustments];
  out.behindLayers = behind;
  return out;
}

/**
 * Remove the tracked look filters/effects (and the look meta) from one layer of a draft, and put
 * back the template / Styler treatment the look replaced.
 */
function stripLayerLook(d: Document, id: ID): boolean {
  const l = d.layers[id];
  const m = lookMetaOf(l);
  if (!l || !m) return false;
  const fids = new Set(m.filterIds);
  const eids = new Set(m.effectIds);
  const replaced = m.replaced ? (JSON.parse(JSON.stringify(m.replaced)) as ReplacedStyling) : null;
  l.filters = l.filters.filter((f) => !fids.has(f.id));
  l.effects = l.effects.filter((e) => !eids.has(e.id));
  const meta = { ...l.meta };
  delete meta[LOOK_META_KEY];
  if (Object.keys(meta).length) l.meta = meta;
  else delete l.meta;
  restoreCharacterStylingDraft(l, replaced);
  return true;
}

/**
 * Delete a look group and the layers the look created in it. Layers the user added to the group
 * are moved out (to where the group was) instead of being deleted.
 */
function removeLookGroupDraft(d: Document, g: GroupLayer) {
  const own = Array.isArray(g.meta?.lookLayerIds) ? new Set(g.meta!.lookLayerIds as ID[]) : null;
  const foreign = own ? g.childIds.filter((id) => !own.has(id)) : [];
  if (foreign.length) {
    const parentList = siblingsOf(d, g.id);
    let at = parentList.indexOf(g.id);
    for (const id of foreign) {
      const i = g.childIds.indexOf(id);
      if (i >= 0) g.childIds.splice(i, 1);
      parentList.splice(Math.max(0, at), 0, id);
      at++;
    }
  }
  removeLayerDraft(d, g.id);
}

/**
 * Remove look artifacts from a draft: every look group (plus the filters/effects that same look
 * put on any layer), and the tracked filters/effects of the target layer (or of every layer when
 * `allLayers`). Returns true when something changed.
 */
export function stripLookDraft(d: Document, targetId: ID | null, allLayers = false): boolean {
  let changed = false;
  const removedLooks = new Set<string>();
  for (const id of lookGroups(d).map((x) => x.id)) {
    const g = d.layers[id];
    if (!isLookGroup(g)) continue; // already removed with an enclosing group
    removedLooks.add(String(g.meta!.lookId));
    removeLookGroupDraft(d, g);
    changed = true;
  }
  for (const id of Object.keys(d.layers)) {
    const m = lookMetaOf(d.layers[id]);
    if (!m) continue;
    if (allLayers || id === targetId || removedLooks.has(m.lookId)) changed = stripLayerLook(d, id) || changed;
  }
  return changed;
}

/** Insert a built look into a draft (replacing any previous look). Returns the look group id. */
export function insertLookDraft(d: Document, built: BuiltLook, targetId: ID | null): ID | null {
  stripLookDraft(d, targetId);
  const target = targetId ? d.layers[targetId] : undefined;
  if (target && (built.filters.length || built.effects.length)) {
    // One owner of character styling: a look with restyling filters replaces the Styler's /
    // template's treatment; other looks replace only their filters/effects of the same kind (no
    // double glow or rim light). What was taken off comes back when the look is removed.
    adoptTemplateStylingDraft(target);
    const restyles = built.restyles ?? restylesCharacter(built.filters.map((f) => f.filterId));
    const replaced = restyles
      ? takeCharacterStylingDraft(target, ['template', 'styler'])
      : takeCharacterStylingDraft(target, ['template', 'styler'], {
          onlyFilterTypes: new Set(built.filters.map((f) => f.filterId)),
          onlyEffectTypes: new Set(built.effects.map((e) => e.effectId)),
        });
    target.filters = [...target.filters, ...built.filters];
    target.effects = [...target.effects, ...built.effects];
    const meta: LookLayerMeta = {
      lookId: built.lookId,
      filterIds: built.filters.map((f) => f.id),
      effectIds: built.effects.map((e) => e.id),
    };
    if (replaced) meta.replaced = replaced;
    target.meta = { ...target.meta, [LOOK_META_KEY]: meta };
  }
  let topLayers = built.groupLayers;
  const behindLayers = built.behindLayers ?? [];
  if (behindLayers.length) {
    const at = targetId ? behindInsertionPoint(d, targetId) : null;
    if (at) {
      const behind = makeGroupLayer({ name: `Look: ${built.lookName} (behind)` });
      behind.meta = { lookId: built.lookId, lookLayerIds: behindLayers.map((l) => l.id), lookPart: 'behind' };
      behind.collapsed = true;
      insertLayerDraft(d, behind, at);
      for (const l of behindLayers) insertLayerDraft(d, l, { parentId: behind.id });
    } else topLayers = [...behindLayers, ...topLayers];
  }
  if (!topLayers.length) return null;
  const group = makeGroupLayer({ name: `Look: ${built.lookName}` });
  group.meta = { lookId: built.lookId, lookLayerIds: topLayers.map((l) => l.id) };
  group.collapsed = true;
  insertLayerDraft(d, group, { parentId: null });
  for (const l of topLayers) insertLayerDraft(d, l, { parentId: group.id });
  return group.id;
}

export interface LookTargets {
  /** Layer that receives the look's filters/effects and anchors 'behind' overlays. */
  targetId: ID | null;
  /** Why the effective target differs from the request (shown to the user). */
  note?: string;
  blocked?: string;
  /** True when the target is the document's character picked for whole-document mode. */
  character?: boolean;
}

/**
 * Effective target of an apply/preview: the resolved requested layer, or — in whole-document
 * mode — the document's only character layer.
 */
export function lookTargets(doc: Document, requested: ID | null): LookTargets {
  const r = resolveTarget(doc, requested);
  if (requested || r.targetId) return r;
  const ch = documentCharacter(doc);
  if (!ch) return r;
  return { targetId: ch, character: true, note: `character filters on “${doc.layers[ch].name}”` };
}

export interface ResolvedTarget {
  targetId: ID | null;
  /** Why the effective target differs from the request (shown to the user). */
  note?: string;
  /** The request can't be honored at all (e.g. locked layer). */
  blocked?: string;
}

/** Decide the effective target for a request; returns a note when the request had to change. */
export function resolveTarget(doc: Document, requested: ID | null): ResolvedTarget {
  if (!requested) return { targetId: null };
  const l = doc.layers[requested];
  if (!l) return { targetId: null };
  if (isInsideLookGroup(doc, requested)) return { targetId: null, note: 'look layers can’t be a target' };
  if (l.type === 'adjustment') return { targetId: null, note: 'adjustment layers can’t hold a look' };
  if (l.type === 'group') {
    const ch = characterInGroup(doc, requested);
    const c = ch ? doc.layers[ch] : null;
    if (c) {
      if (c.locks.all) return { targetId: ch, blocked: `“${c.name}” is locked. Unlock it or switch the Looks target to Document.` };
      return { targetId: ch, note: `inside group “${l.name}”` };
    }
  }
  if (l.locks.all) return { targetId: requested, blocked: `“${l.name}” is locked. Unlock it or switch the Looks target to Document.` };
  return { targetId: requested };
}

function listNames(names: string[]): string {
  const u = [...new Set(names)];
  if (u.length <= 1) return u[0] ?? '';
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`;
}

/** User-facing explanation of the parts a target couldn't receive (empty when none). */
export function describeTargetSkips(built: BuiltLook, target: Layer | null | undefined): string {
  const names = built.targetSkipped ?? [];
  if (!names.length) return '';
  const list = listNames(names);
  const many = new Set(names).size > 1;
  if (!target) return `${list} ${many ? 'need' : 'needs'} a layer: choose “Layer” in Looks and select your character to include ${many ? 'them' : 'it'}`;
  if (target.type === 'group') return `${list} skipped: groups can’t hold smart filters — select the character layer itself`;
  return `${list} skipped: a ${target.type} layer can’t hold ${many ? 'them' : 'it'}`;
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
  const { targetId, note, blocked, character } = lookTargets(s.doc, targetLayerId);
  if (blocked) {
    toast(blocked, 'warning', 3600);
    return;
  }
  const built = buildLook(look, s.doc, targetId, undefined, { documentWide: !!character });
  const duplicates = built.duplicates ?? [];
  if (!built.filters.length && !built.effects.length && !built.groupLayers.length && !built.behindLayers?.length) {
    const why = describeTargetSkips(built, targetId ? s.doc.layers[targetId] : null);
    const dup = duplicates.length ? `its overlays (${listNames(duplicates)}) are already in the document` : '';
    toast(why || dup ? `“${look.name}”: ${why || dup}.` : `“${look.name}” needs filters/assets that aren’t available yet.`, 'warning', 4600);
    return;
  }
  const target = targetId ? s.doc.layers[targetId] : null;
  // Character filters run before the layer mask: apply a Remove Background mask first.
  const bake = target && built.filters.length ? prepareCutoutBake(s.doc, target) : null;
  useEditor.getState().commit(
    `Apply Look: ${look.name}`,
    (d) => {
      const t = targetId ? d.layers[targetId] : undefined;
      if (bake && t) bake.apply(t);
      insertLookDraft(d, built, targetId);
    },
    bake ? { patches: bake.patches } : undefined,
  );
  const where = target && !character ? ` to “${target.name}”` : ' to the whole document';
  // In whole-document mode, name the character only when it received filters or effects.
  const shownNote = character && !built.filters.length && !built.effects.length ? undefined : note;
  const skips = describeTargetSkips(built, target);
  const extra = [
    skips,
    duplicates.length ? `${listNames(duplicates)} ${duplicates.length > 1 ? 'were' : 'was'} already in the document (not doubled)` : '',
    bake ? 'the Remove Background mask was applied first' : '',
    built.behindOnTop?.length && target
      ? `${listNames(built.behindOnTop)} went on top: “${target.name}” still has its background (remove it with Roblox ▸ Remove Background… to put atmosphere behind the character)`
      : '',
  ].filter(Boolean);
  toast(
    `Applied look “${look.name}”${where}${shownNote ? ` (${shownNote})` : ''}.${extra.length ? ` ${extra.join('; ')}.` : ''}`,
    skips ? 'info' : 'success',
    extra.length ? 5600 : shownNote ? 3600 : 2600,
  );
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
