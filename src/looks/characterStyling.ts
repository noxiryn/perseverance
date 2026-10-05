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

export interface StripOptions {
  /** Only strip effects (keep the owners' filters) whose effect id is in this set. */
  onlyEffectTypes?: ReadonlySet<string>;
}

/**
 * Immer-draft mutation: remove the filters/effects the given owners added to a layer, and their
 * meta records. With `onlyEffectTypes`, only those owners' effects of these types are removed
 * (filters and the records stay, minus the removed ids). Returns the number of removed instances.
 */
export function stripCharacterStylingDraft(layer: Layer, owners: readonly StylingOwner[], opts: StripOptions = {}): number {
  let removed = 0;
  const meta: Record<string, unknown> = { ...(layer.meta ?? {}) };
  let metaChanged = false;
  for (const owner of owners) {
    const ids = ownedIds(layer, owner);
    if (!ids) continue;
    if (opts.onlyEffectTypes) {
      const drop = new Set(ids.effectIds.filter((id) => layer.effects.some((e) => e.id === id && opts.onlyEffectTypes!.has(e.effectId))));
      if (!drop.size) continue;
      const before = layer.effects.length;
      layer.effects = layer.effects.filter((e: LayerEffect) => !drop.has(e.id));
      removed += before - layer.effects.length;
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
