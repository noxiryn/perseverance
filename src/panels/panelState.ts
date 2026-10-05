/** Local UI state of the layers panels (not part of the document, not undoable). */
import { create } from 'zustand';
import type { ID } from '../core/types';
import type { LayerKind } from './treeOps';

export type ThumbSize = 'none' | 'small' | 'medium' | 'large';

/**
 * What a pixel / shape layer thumbnail shows: the entire document, the layer's own bounds
 * (cropped, like Photoshop's "Layer Bounds"), or 'auto' — bounds for layers that cover less than
 * about a quarter of the canvas (stickers, small shapes), the entire document otherwise.
 */
export type ThumbContent = 'auto' | 'document' | 'bounds';

/** Thumbnail edge per size (rows are thumb + 8 px tall: medium → the reference's ~32px rows). */
export const THUMB_PX: Record<ThumbSize, number> = { none: 0, small: 18, medium: 24, large: 40 };

const STORAGE_KEY = 'perseverance.layersPanel';

interface Stored {
  thumbSize: ThumbSize;
  thumbContent: ThumbContent;
}

function loadStored(): Stored {
  const out: Stored = { thumbSize: 'medium', thumbContent: 'auto' };
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Record<keyof Stored, unknown>>;
    if (v.thumbSize === 'none' || v.thumbSize === 'small' || v.thumbSize === 'medium' || v.thumbSize === 'large') out.thumbSize = v.thumbSize;
    if (v.thumbContent === 'auto' || v.thumbContent === 'document' || v.thumbContent === 'bounds') out.thumbContent = v.thumbContent;
  } catch {
    /* storage unavailable */
  }
  return out;
}

function save(s: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

interface LayersPanelState {
  kinds: LayerKind[];
  query: string;
  searchOpen: boolean;
  thumbSize: ThumbSize;
  thumbContent: ThumbContent;
  /** Layers whose effect / smart filter rows are expanded. */
  expanded: Record<ID, boolean>;
  setKinds(k: LayerKind[]): void;
  toggleKind(k: LayerKind): void;
  setQuery(q: string): void;
  setSearchOpen(v: boolean): void;
  clearFilter(): void;
  setThumbSize(s: ThumbSize): void;
  setThumbContent(c: ThumbContent): void;
  toggleExpanded(id: ID, value?: boolean): void;
}

const initial = loadStored();

export const useLayersPanel = create<LayersPanelState>()((set, get) => ({
  kinds: [],
  query: '',
  searchOpen: false,
  thumbSize: initial.thumbSize,
  thumbContent: initial.thumbContent,
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
    save({ thumbSize, thumbContent: get().thumbContent });
  },
  setThumbContent: (thumbContent) => {
    set({ thumbContent });
    save({ thumbSize: get().thumbSize, thumbContent });
  },
  toggleExpanded: (id, value) => set((st) => ({ expanded: { ...st.expanded, [id]: value ?? !st.expanded[id] } })),
}));
