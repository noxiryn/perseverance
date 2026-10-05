/**
 * "My Styles": layer styles the user saved from a layer (its effects and, optionally, its smart
 * filters) to reuse across a thumbnail series. Stored per user in localStorage, listed in the
 * Effects panel and in Layer ▸ Layer Style ▸ My Styles.
 */
import { create } from 'zustand';
import type { BlendMode, FilterInstance, Layer, LayerEffect, ParamValues } from '../core/types';
import { uid } from '../core/ids';
import { activeSession, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { assertEditable, needLayer } from './layerOps';
import { promptSave } from '../looks/SavePresetDialog';

export interface UserStyleEffect {
  effectId: string;
  params: ParamValues;
  enabled: boolean;
}

export interface UserStyleFilter {
  filterId: string;
  params: ParamValues;
  enabled: boolean;
  opacity: number;
  blendMode: BlendMode;
}

export interface UserStyle {
  id: string;
  name: string;
  created: number;
  effects: UserStyleEffect[];
  filters: UserStyleFilter[];
}

const KEY = 'perseverance.userStyles';

/** Defensive parse of stored styles (drops malformed entries). Pure. */
export function parseUserStyles(raw: unknown): UserStyle[] {
  if (!Array.isArray(raw)) return [];
  const out: UserStyle[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Partial<UserStyle>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string') continue;
    const effects = (Array.isArray(o.effects) ? o.effects : []).filter((e): e is UserStyleEffect => !!e && typeof e.effectId === 'string');
    const filters = (Array.isArray(o.filters) ? o.filters : []).filter((f): f is UserStyleFilter => !!f && typeof f.filterId === 'string');
    if (!effects.length && !filters.length) continue;
    out.push({
      id: o.id,
      name: o.name,
      created: typeof o.created === 'number' ? o.created : 0,
      effects: effects.map((e) => ({ effectId: e.effectId, params: { ...(e.params ?? {}) }, enabled: e.enabled !== false })),
      filters: filters.map((f) => ({
        filterId: f.filterId,
        params: { ...(f.params ?? {}) },
        enabled: f.enabled !== false,
        opacity: typeof f.opacity === 'number' ? f.opacity : 1,
        blendMode: (f.blendMode ?? 'normal') as BlendMode,
      })),
    });
  }
  return out;
}

function load(): UserStyle[] {
  try {
    return parseUserStyles(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return [];
  }
}

function persist(styles: UserStyle[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(styles));
  } catch {
    toast('Could not save your styles (storage is full or unavailable).', 'error');
  }
}

interface UserStylesState {
  styles: UserStyle[];
  add(s: UserStyle): void;
  remove(id: string): void;
  rename(id: string, name: string): void;
}

export const useUserStyles = create<UserStylesState>()((set, get) => ({
  styles: load(),
  add(s) {
    const styles = [...get().styles, s];
    set({ styles });
    persist(styles);
  },
  remove(id) {
    const styles = get().styles.filter((s) => s.id !== id);
    set({ styles });
    persist(styles);
  },
  rename(id, name) {
    const styles = get().styles.map((s) => (s.id === id ? { ...s, name } : s));
    set({ styles });
    persist(styles);
  },
}));

/** Snapshot a layer's style (effects + optionally smart filters) as a user style. Pure. */
export function styleFromLayer(layer: Pick<Layer, 'effects' | 'filters'>, name: string, includeFilters: boolean, id = uid('ust_'), now = Date.now()): UserStyle {
  return {
    id,
    name,
    created: now,
    effects: layer.effects.map((e) => ({ effectId: e.effectId, params: structuredClone(e.params), enabled: e.enabled })),
    filters: includeFilters
      ? layer.filters.map((f) => ({ filterId: f.filterId, params: structuredClone(f.params), enabled: f.enabled, opacity: f.opacity ?? 1, blendMode: f.blendMode ?? 'normal' }))
      : [],
  };
}

/** Layer types that can hold smart filters. */
const FILTERABLE = new Set(['raster', 'text', 'shape', 'fill']);

/**
 * Immer-draft mutation: add (or with `replace`, swap in) a user style's effects and filters,
 * with fresh instance ids. Filters are skipped on layers that can't hold them. Returns how many
 * filters were skipped.
 */
export function applyUserStyleDraft(l: Layer, style: UserStyle, replace: boolean, makeId: (prefix: string) => string = uid): number {
  const effects: LayerEffect[] = style.effects.map((e) => ({ id: makeId('ef_'), effectId: e.effectId, enabled: e.enabled, params: structuredClone(e.params) }));
  const canFilter = FILTERABLE.has(l.type);
  const filters: FilterInstance[] = canFilter
    ? style.filters.map((f) => ({ id: makeId('fx_'), filterId: f.filterId, enabled: f.enabled, params: structuredClone(f.params), opacity: f.opacity, blendMode: f.blendMode }))
    : [];
  l.effects = replace ? effects : [...l.effects, ...effects];
  // Replace swaps the layer's filters only when the style brings its own.
  if (canFilter && filters.length) l.filters = replace ? filters : [...l.filters, ...filters];
  return canFilter ? 0 : style.filters.length;
}

/** Apply a user style to the selected layer (one undo step). Alt-click → replace. */
export function applyUserStyle(style: UserStyle, replace = false) {
  const ctx = needLayer('apply a style to');
  if (!ctx) return;
  if (ctx.layer.type === 'adjustment') return void toast('Adjustment layers cannot have layer styles', 'info');
  if (!assertEditable(ctx.s.doc, [ctx.layer.id], 'all')) return;
  let skipped = 0;
  useEditor.getState().commit(`Style: ${style.name}`, (d) => {
    const l = d.layers[ctx.layer.id];
    if (l) skipped = applyUserStyleDraft(l, style, replace);
  });
  viewport.requestRender();
  if (skipped) toast(`“${style.name}”: ${skipped} smart filter${skipped > 1 ? 's' : ''} skipped — groups can’t hold smart filters.`, 'info', 3600);
}

/** Effects panel / Layer menu: save the selected layer's style under a name. */
export async function saveLayerStyle() {
  const s = activeSession();
  const layer = s?.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!layer) return void toast('Select a layer whose style you want to save.', 'info');
  if (!layer.effects.length && !layer.filters.length) return void toast(`“${layer.name}” has no layer effects or smart filters to save.`, 'info');
  const res = await promptSave({
    title: 'Save Layer Style',
    defaultName: `${layer.name} style`,
    options: [
      {
        key: 'filters',
        label: `Include smart filters (${layer.filters.length})`,
        checked: layer.filters.length > 0,
        disabled: !layer.filters.length,
        hint: 'Filters such as halftone, gradient map or cel shading are saved with the effects',
      },
    ],
    description: `Saves ${layer.effects.length} effect${layer.effects.length === 1 ? '' : 's'} under My Styles in the Effects panel, ready for your next thumbnail.`,
  });
  if (!res) return;
  const style = styleFromLayer(layer, res.name, !!res.options.filters);
  if (!style.effects.length && !style.filters.length) return void toast('Nothing to save — include the smart filters or add an effect.', 'info');
  useUserStyles.getState().add(style);
  toast(`Saved “${style.name}” to My Styles.`, 'success');
}

/* ---------------- smart filter clipboard ---------------- */

let filterClipboard: UserStyleFilter[] | null = null;

export const hasFilterClipboard = () => !!filterClipboard?.length;

/** Layer ▸ Layer Style ▸ Copy Smart Filters: remember the active layer's smart filters. */
export function copySmartFilters() {
  const ctx = needLayer('copy its smart filters');
  if (!ctx) return;
  if (!ctx.layer.filters.length) return void toast(`“${ctx.layer.name}” has no smart filters to copy`, 'info');
  filterClipboard = styleFromLayer(ctx.layer, '', true).filters;
  toast(`Copied ${filterClipboard.length} smart filter${filterClipboard.length === 1 ? '' : 's'}`, 'info', 1800);
}

/** Layer ▸ Layer Style ▸ Paste Smart Filters: append the copied filters to the selected layers. */
export function pasteSmartFilters() {
  const s = activeSession();
  if (!s) return;
  const clip = filterClipboard;
  if (!clip?.length) return void toast('Copy smart filters first (Layer ▸ Layer Style ▸ Copy Smart Filters)', 'info');
  const sel = s.selectedLayerIds?.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
  const ids = sel.filter((id) => FILTERABLE.has(s.doc.layers[id]?.type ?? ''));
  if (!ids.length) return void toast('Select a pixel, text, shape or fill layer to paste the smart filters onto', 'info');
  if (!assertEditable(s.doc, ids, 'all')) return;
  const style: UserStyle = { id: '', name: '', created: 0, effects: [], filters: clip };
  useEditor.getState().commit('Paste Smart Filters', (d) => {
    for (const id of ids) {
      const l = d.layers[id];
      if (l) applyUserStyleDraft(l, style, false);
    }
  });
  viewport.requestRender();
}
