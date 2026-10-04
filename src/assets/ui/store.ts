/**
 * Library UI state shared by the Libraries panel and the Place Asset dialog: active tab,
 * category filter, search, the selected asset and the per-asset settings the user tweaked.
 */
import { create } from 'zustand';
import type { BlendMode, ParamValues } from '../../core/types';
import type { AssetDef } from '../../registry';

export type LibraryTab = 'assets' | 'shapes' | 'mine';

export interface AssetSettings {
  params: ParamValues;
  blendMode?: BlendMode;
  opacity?: number;
}

interface LibraryState {
  tab: LibraryTab;
  category: string;
  query: string;
  shapeCategory: string;
  shapeQuery: string;
  selectedId: string | null;
  settings: Record<string, AssetSettings>;
  setTab(t: LibraryTab): void;
  setCategory(c: string): void;
  setQuery(q: string): void;
  setShapeCategory(c: string): void;
  setShapeQuery(q: string): void;
  select(id: string | null): void;
  setParams(id: string, params: ParamValues): void;
  setLayerOpts(id: string, o: { blendMode?: BlendMode; opacity?: number }): void;
  reset(id: string): void;
}

export const useLibrary = create<LibraryState>()((set) => ({
  tab: 'assets',
  category: 'All',
  query: '',
  shapeCategory: 'All',
  shapeQuery: '',
  selectedId: null,
  settings: {},
  setTab: (tab) => set({ tab }),
  setCategory: (category) => set({ category }),
  setQuery: (query) => set({ query }),
  setShapeCategory: (shapeCategory) => set({ shapeCategory }),
  setShapeQuery: (shapeQuery) => set({ shapeQuery }),
  select: (selectedId) => set({ selectedId }),
  setParams: (id, params) => set((st) => ({ settings: { ...st.settings, [id]: { ...st.settings[id], params } } })),
  setLayerOpts: (id, o) => set((st) => ({ settings: { ...st.settings, [id]: { ...st.settings[id], params: st.settings[id]?.params ?? {}, ...o } } })),
  reset: (id) =>
    set((st) => {
      const next = { ...st.settings };
      delete next[id];
      return { settings: next };
    }),
}));

/** Case-insensitive multi-term search over name, id, category and tags. Pure. */
export function matchesQuery(def: Pick<AssetDef, 'id' | 'name' | 'category' | 'tags'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [def.name, def.id, def.category, ...(def.tags ?? [])].join(' ').toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}
