/**
 * Per-user font preferences: favorites, recently used families and Fonts-panel preview settings.
 * Persisted in localStorage (best effort — private windows / blocked storage just don't persist).
 */
import { create } from 'zustand';

const FAV_KEY = 'perseverance.fonts.favorites';
const RECENT_KEY = 'perseverance.fonts.recents';
const PREVIEW_KEY = 'perseverance.fonts.preview';
const MAX_RECENTS = 12;

function read<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export interface FontPreviewPrefs {
  text: string;
  size: number;
  category: string;
}

interface FontPrefsState {
  favorites: string[];
  recents: string[];
  preview: FontPreviewPrefs;
  isFavorite(family: string): boolean;
  toggleFavorite(family: string): void;
  pushRecent(family: string): void;
  clearRecents(): void;
  setPreview(p: Partial<FontPreviewPrefs>): void;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export const useFontPrefs = create<FontPrefsState>()((set, get) => ({
  favorites: strings(read(FAV_KEY, [])),
  recents: strings(read(RECENT_KEY, [])).slice(0, MAX_RECENTS),
  preview: { text: '', size: 30, category: 'all', ...read<Partial<FontPreviewPrefs>>(PREVIEW_KEY, {}) },

  isFavorite: (family) => get().favorites.includes(family),

  toggleFavorite(family) {
    const favs = get().favorites;
    const next = favs.includes(family) ? favs.filter((f) => f !== family) : [...favs, family];
    write(FAV_KEY, next);
    set({ favorites: next });
  },

  pushRecent(family) {
    const next = [family, ...get().recents.filter((f) => f !== family)].slice(0, MAX_RECENTS);
    write(RECENT_KEY, next);
    set({ recents: next });
  },

  clearRecents() {
    write(RECENT_KEY, []);
    set({ recents: [] });
  },

  setPreview(p) {
    const next = { ...get().preview, ...p };
    write(PREVIEW_KEY, next);
    set({ preview: next });
  },
}));
