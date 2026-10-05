/**
 * One ownership model for character styling.
 *
 * Three features put stylizing smart filters and layer effects on a character layer:
 *  - templates  — the character treatment a template authored   (layer.meta.templateStyle),
 *  - the Character Styler — one-click styles                     (layer.meta.styler),
 *  - Looks      — a look's filters/effects on its target layer   (layer.meta.look).
 * Each records the instance ids it added, so applying one can replace what the others added
 * instead of stacking (two gradient maps + two halftones turn a character into a dark blob).
 * Filters and effects the user added by hand are never touched.
 *
 * Only RESTYLING filters (color maps, halftones, cel/toon shading…) replace a whole treatment;
 * additive ones (rim light, glitch, blur…) only replace the same filter type, so a rim-light look
 * keeps the template's colors. A look keeps what it took off (`takeCharacterStylingDraft`) and
 * puts it back when it is removed (`restoreCharacterStylingDraft`).
 */
import type { FilterInstance, Layer, LayerEffect } from '../core/types';

/** `layer.meta` key of the treatment a template authored on its placeholder character. */
export const TEMPLATE_STYLE_KEY = 'templateStyle';
/** `layer.meta` key of the Character Styler (see src/roblox/styler/styles.ts). */
export const STYLER_META_KEY = 'styler';
/** `layer.meta` key of a look applied to the layer (see src/looks/engine.ts). */
export const LOOK_LAYER_KEY = 'look';

export type StylingOwner = 'template' | 'styler' | 'look';

export const ALL_OWNERS: readonly StylingOwner[] = ['template', 'styler', 'look'];

export interface OwnedIds {
  filterIds: string[];
  effectIds: string[];
}

type Meta = Record<string, unknown> | undefined;

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const refIds = (v: unknown): string[] =>
  v && typeof v === 'object' ? Object.values(v as Record<string, unknown>).flatMap((r) => (r && typeof (r as { id?: unknown }).id === 'string' ? [(r as { id: string }).id] : [])) : [];

/** Instance ids one owner added to a layer (null when it added nothing). */
export function ownedIds(layer: Pick<Layer, 'meta'> | null | undefined, owner: StylingOwner): OwnedIds | null {
  const meta = layer?.meta as Meta;
  if (!meta) return null;
  if (owner === 'styler') {
    const m = meta[STYLER_META_KEY] as { filters?: unknown; effects?: unknown } | undefined;
    if (!m || typeof m !== 'object') return null;
    return { filterIds: refIds(m.filters), effectIds: refIds(m.effects) };
  }
  const m = meta[owner === 'template' ? TEMPLATE_STYLE_KEY : LOOK_LAYER_KEY] as { filterIds?: unknown; effectIds?: unknown } | undefined;
  if (!m || typeof m !== 'object') return null;
  return { filterIds: strList(m.filterIds), effectIds: strList(m.effectIds) };
}

const META_KEY: Record<StylingOwner, string> = { template: TEMPLATE_STYLE_KEY, styler: STYLER_META_KEY, look: LOOK_LAYER_KEY };

/** True when any owner's filters/effects are still on the layer. */
export function hasCharacterStyling(layer: Pick<Layer, 'meta' | 'filters' | 'effects'> | null | undefined, owners: readonly StylingOwner[] = ALL_OWNERS): boolean {
  if (!layer) return false;
  const fids = new Set(layer.filters.map((f) => f.id));
  const eids = new Set(layer.effects.map((e) => e.id));
  return owners.some((o) => {
    const ids = ownedIds(layer, o);
    return !!ids && (ids.filterIds.some((id) => fids.has(id)) || ids.effectIds.some((id) => eids.has(id)));
  });
}

/**
 * Filters that redefine a character's colors or shading. Two of them stacked muddy the character
 * (double gradient maps / halftones), so adding one replaces the whole existing treatment.
 */
export const RESTYLING_FILTERS: ReadonlySet<string> = new Set([
  'gradient-map',
  'halftone',
  'comic-dots',
  'newsprint',
  'dither',
  'risograph',
  'screen-print',
  'cel-shade',
  'toon-roblox',
  'posterize',
  'posterize-edges',
  'silhouette',
  'cutout',
  'watercolor',
  'charcoal',
  'pencil-sketch',
  'ink-wash',
  'poster-edges',
  'stamp',
  'sketch',
  'oil-paint',
  'kuwahara',
  'black-white',
  'threshold',
  'sepia',
  'old-photo',
  'solarize',
]);

/** True when any of these filter ids restyles a character (see RESTYLING_FILTERS). */
export function restylesCharacter(filterIds: Iterable<string>): boolean {
  for (const id of filterIds) if (RESTYLING_FILTERS.has(id)) return true;
  return false;
}

export interface StripOptions {
  /**
   * Partial strip: only the owners' effects whose effect id is in this set (and, with
   * `onlyFilterTypes`, their filters of those types) are removed; the owner records stay.
   */
  onlyEffectTypes?: ReadonlySet<string>;
  /** Partial strip: only the owners' filters whose filter id is in this set are removed. */
  onlyFilterTypes?: ReadonlySet<string>;
}

/**
 * Immer-draft mutation: remove the filters/effects the given owners added to a layer, and their
 * meta records. With `onlyEffectTypes` / `onlyFilterTypes`, only those owners' instances of these
 * types are removed (the records stay). Returns the number of removed instances.
 */
export function stripCharacterStylingDraft(layer: Layer, owners: readonly StylingOwner[], opts: StripOptions = {}): number {
  let removed = 0;
  const meta: Record<string, unknown> = { ...(layer.meta ?? {}) };
  let metaChanged = false;
  const partial = !!(opts.onlyEffectTypes || opts.onlyFilterTypes);
  for (const owner of owners) {
    const ids = ownedIds(layer, owner);
    if (!ids) continue;
    if (partial) {
      const fset = opts.onlyFilterTypes;
      const eset = opts.onlyEffectTypes;
      const dropF = new Set(fset ? ids.filterIds.filter((id) => layer.filters.some((f) => f.id === id && fset.has(f.filterId))) : []);
      const dropE = new Set(eset ? ids.effectIds.filter((id) => layer.effects.some((e) => e.id === id && eset.has(e.effectId))) : []);
      if (!dropF.size && !dropE.size) continue;
      const before = layer.filters.length + layer.effects.length;
      if (dropF.size) layer.filters = layer.filters.filter((f: FilterInstance) => !dropF.has(f.id));
      if (dropE.size) layer.effects = layer.effects.filter((e: LayerEffect) => !dropE.has(e.id));
      removed += before - layer.filters.length - layer.effects.length;
      continue;
    }
    const fids = new Set(ids.filterIds);
    const eids = new Set(ids.effectIds);
    const before = layer.filters.length + layer.effects.length;
    layer.filters = layer.filters.filter((f: FilterInstance) => !fids.has(f.id));
    layer.effects = layer.effects.filter((e: LayerEffect) => !eids.has(e.id));
    removed += before - layer.filters.length - layer.effects.length;
    delete meta[META_KEY[owner]];
    metaChanged = true;
  }
  if (metaChanged) {
    if (Object.keys(meta).length) layer.meta = meta;
    else delete layer.meta;
  }
  return removed;
}

/** What a look took off a layer (restored when the look is removed). JSON-safe. */
export interface ReplacedStyling {
  filters: { index: number; instance: FilterInstance }[];
  effects: { index: number; instance: LayerEffect }[];
  /** Owner records removed with them (meta key → record). */
  records: Record<string, unknown>;
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * `stripCharacterStylingDraft` that also returns what it removed (plain copies with their
 * positions, plus the removed owner records), or null when nothing changed.
 */
export function takeCharacterStylingDraft(layer: Layer, owners: readonly StylingOwner[], opts: StripOptions = {}): ReplacedStyling | null {
  const beforeF = layer.filters.map((f, index) => ({ index, id: f.id }));
  const beforeE = layer.effects.map((e, index) => ({ index, id: e.id }));
  const snapF = new Map(layer.filters.map((f) => [f.id, f]));
  const snapE = new Map(layer.effects.map((e) => [e.id, e]));
  const beforeMeta: Record<string, unknown> = { ...(layer.meta ?? {}) };
  const records: Record<string, unknown> = {};
  for (const o of owners) {
    const key = META_KEY[o];
    if (key in beforeMeta) records[key] = plain(beforeMeta[key]);
  }
  const removed = stripCharacterStylingDraft(layer, owners, opts);
  const keptF = new Set(layer.filters.map((f) => f.id));
  const keptE = new Set(layer.effects.map((e) => e.id));
  const after = layer.meta ?? {};
  for (const key of Object.keys(records)) if (key in after) delete records[key];
  if (!removed && !Object.keys(records).length) return null;
  return {
    filters: beforeF.filter((x) => !keptF.has(x.id)).map((x) => ({ index: x.index, instance: plain(snapF.get(x.id)!) })),
    effects: beforeE.filter((x) => !keptE.has(x.id)).map((x) => ({ index: x.index, instance: plain(snapE.get(x.id)!) })),
    records,
  };
}

/**
 * Immer-draft mutation: put back what `takeCharacterStylingDraft` removed (at their old
 * positions; instances / records that are back already are skipped).
 */
export function restoreCharacterStylingDraft(layer: Layer, rep: ReplacedStyling | null | undefined) {
  if (!rep || typeof rep !== 'object') return;
  const fids = new Set(layer.filters.map((f) => f.id));
  for (const { index, instance } of [...(rep.filters ?? [])].sort((a, b) => a.index - b.index)) {
    if (!instance || fids.has(instance.id)) continue;
    layer.filters.splice(Math.max(0, Math.min(index, layer.filters.length)), 0, plain(instance));
  }
  const eids = new Set(layer.effects.map((e) => e.id));
  for (const { index, instance } of [...(rep.effects ?? [])].sort((a, b) => a.index - b.index)) {
    if (!instance || eids.has(instance.id)) continue;
    layer.effects.splice(Math.max(0, Math.min(index, layer.effects.length)), 0, plain(instance));
  }
  const recs = rep.records && typeof rep.records === 'object' ? rep.records : {};
  const missing = Object.keys(recs).filter((k) => !(k in (layer.meta ?? {})));
  if (missing.length) layer.meta = { ...(layer.meta ?? {}), ...Object.fromEntries(missing.map((k) => [k, plain(recs[k])])) };
}

/**
 * Record the treatment currently on a template character (all its filters/effects) as the
 * template's, so a Styler style or a Look replaces it. Used by the template builder and, for
 * documents made before ownership was recorded, when a placeholder is first restyled/replaced.
 */
export function templateStyleOf(layer: Pick<Layer, 'filters' | 'effects' | 'meta'>): OwnedIds {
  const taken = new Set<string>();
  for (const o of ['styler', 'look'] as const) {
    const ids = ownedIds(layer, o);
    ids?.filterIds.forEach((id) => taken.add(id));
    ids?.effectIds.forEach((id) => taken.add(id));
  }
  return {
    filterIds: layer.filters.map((f) => f.id).filter((id) => !taken.has(id)),
    effectIds: layer.effects.map((e) => e.id).filter((id) => !taken.has(id)),
  };
}

/**
 * Immer-draft mutation: give a template placeholder that predates ownership records a
 * `templateStyle` record (no-op for other layers or when one exists).
 */
export function adoptTemplateStylingDraft(layer: Layer) {
  if (layer.meta?.placeholder !== true || ownedIds(layer, 'template')) return;
  const ids = templateStyleOf(layer);
  if (!ids.filterIds.length && !ids.effectIds.length) return;
  layer.meta = { ...(layer.meta ?? {}), [TEMPLATE_STYLE_KEY]: ids };
}

/** Human-readable names of the owners currently styling the layer ("the template's", "a look's"…). */
export function stylingOwnersOn(layer: Pick<Layer, 'meta' | 'filters' | 'effects'> | null | undefined): StylingOwner[] {
  return ALL_OWNERS.filter((o) => hasCharacterStyling(layer, [o]));
}
