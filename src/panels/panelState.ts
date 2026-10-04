/** Local UI state of the layers panels (not part of the document, not undoable). */
import { create } from 'zustand';
import type { ID } from '../core/types';
import type { LayerKind } from './treeOps';

export type ThumbSize = 'none' | 'small' | 'medium' | 'large';

/** Thumbnail edge per size (rows are thumb + 8 px tall: medium → the reference's ~32px rows). */
export const THUMB_PX: Record<ThumbSize, number> = { none: 0, small: 18, medium: 24, large: 40 };

const STORAGE_KEY = 'perseverance.layersPanel';

function loadThumbSize(): ThumbSize {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').thumbSize;
    return v === 'none' || v === 'small' || v === 'medium' || v === 'large' ? v : 'medium';
  } catch {
    return 'medium';
  }
}

interface LayersPanelState {
  kinds: LayerKind[];
  query: string;
  searchOpen: boolean;
  thumbSize: ThumbSize;
  /** Layers whose effect / smart filter rows are expanded. */
  expanded: Record<ID, boolean>;
  setKinds(k: LayerKind[]): void;
  toggleKind(k: LayerKind): void;
  setQuery(q: string): void;
  setSearchOpen(v: boolean): void;
  clearFilter(): void;
  setThumbSize(s: ThumbSize): void;
  toggleExpanded(id: ID, value?: boolean): void;
}

export const useLayersPanel = create<LayersPanelState>()((set, get) => ({
  kinds: [],
  query: '',
  searchOpen: false,
  thumbSize: loadThumbSize(),
  expanded: {},
  setKinds: (kinds) => set({ kinds }),
  toggleKind: (k) => {
    const kinds = get().kinds;
    set({ kinds: kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k] });
  },
  setQuery: (query) => set({ query }),
  setSearchOpen: (searchOpen) => set(searchOpen ? { searchOpen } : { searchOpen, query: '' }),
  clearFilter: () => set({ kinds: [], query: '', searchOpen: false }),
  setThumbSize: (thumbSize) => {
    set({ thumbSize });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ thumbSize }));
    } catch {
      /* storage unavailable */
    }
  },
  toggleExpanded: (id, value) => set((st) => ({ expanded: { ...st.expanded, [id]: value ?? !st.expanded[id] } })),
}));
