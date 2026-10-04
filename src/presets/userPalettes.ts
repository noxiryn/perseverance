/**
 * User swatches & palettes: "My Swatches" plus palettes created by "Extract palette from image".
 * Persisted in localStorage and mirrored into the `palettes` registry (category 'User') so every
 * palette consumer (ColorPicker, looks…) sees them.
 */
import { create } from 'zustand';
import { palettes } from '../registry';
import { uid } from '../core/ids';

export const MY_SWATCHES_ID = 'my-swatches';
const KEY = 'perseverance.palettes.user';

export interface UserSwatch {
  color: string;
  name?: string;
}

export interface UserPalette {
  id: string;
  name: string;
  swatches: UserSwatch[];
  createdAt: number;
}

interface UserPaletteState {
  palettes: UserPalette[];
  addSwatch(paletteId: string, color: string, name?: string): void;
  removeSwatch(paletteId: string, index: number): void;
  renameSwatch(paletteId: string, index: number, name: string): void;
  createPalette(name: string, colors: string[]): string;
  renamePalette(paletteId: string, name: string): void;
  deletePalette(paletteId: string): void;
}

function load(): UserPalette[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as UserPalette[]) : [];
    if (Array.isArray(parsed)) {
      return parsed
        .filter((p) => p && typeof p.id === 'string' && Array.isArray(p.swatches))
        .map((p) => ({
          ...p,
          name: String(p.name ?? 'Palette'),
          swatches: p.swatches.filter((s) => s && typeof s.color === 'string'),
        }));
    }
  } catch {
    /* ignore */
  }
  return [];
}

function ensureMySwatches(list: UserPalette[]): UserPalette[] {
  if (list.some((p) => p.id === MY_SWATCHES_ID)) return list;
  return [{ id: MY_SWATCHES_ID, name: 'My Swatches', swatches: [], createdAt: 0 }, ...list];
}

function save(list: UserPalette[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: keep in memory */
  }
}

/** Mirror user palettes into the registry (id = palette id). */
function sync(list: UserPalette[], removed: string[] = []) {
  for (const id of removed) palettes.unregister(id);
  for (const p of list) palettes.register({ id: p.id, name: p.name, category: 'User', colors: p.swatches.map((s) => s.color) });
}

export const useUserPalettes = create<UserPaletteState>()((set, get) => {
  const update = (fn: (list: UserPalette[]) => UserPalette[], removed: string[] = []) => {
    const next = fn(get().palettes);
    save(next);
    sync(next, removed);
    set({ palettes: next });
  };
  const edit = (id: string, fn: (p: UserPalette) => UserPalette) =>
    update((list) => list.map((p) => (p.id === id ? fn(p) : p)));

  return {
    palettes: ensureMySwatches(load()),

    addSwatch(paletteId, color, name) {
      edit(paletteId, (p) => ({ ...p, swatches: [...p.swatches, name ? { color, name } : { color }] }));
    },
    removeSwatch(paletteId, index) {
      edit(paletteId, (p) => ({ ...p, swatches: p.swatches.filter((_, i) => i !== index) }));
    },
    renameSwatch(paletteId, index, name) {
      edit(paletteId, (p) => ({
        ...p,
        swatches: p.swatches.map((s, i) => (i === index ? { color: s.color, ...(name.trim() ? { name: name.trim() } : {}) } : s)),
      }));
    },
    createPalette(name, colors) {
      const id = uid('pal_');
      update((list) => [...list, { id, name: name.trim() || 'Palette', swatches: colors.map((color) => ({ color })), createdAt: Date.now() }]);
      return id;
    },
    renamePalette(paletteId, name) {
      if (!name.trim()) return;
      edit(paletteId, (p) => ({ ...p, name: name.trim() }));
    },
    deletePalette(paletteId) {
      if (paletteId === MY_SWATCHES_ID) {
        edit(paletteId, (p) => ({ ...p, swatches: [] }));
        return;
      }
      update((list) => list.filter((p) => p.id !== paletteId), [paletteId]);
    },
  };
});

/** Register stored user palettes (called at module init, after the built-ins). */
export function registerUserPalettes() {
  sync(useUserPalettes.getState().palettes);
}

export function isUserPalette(id: string): boolean {
  return useUserPalettes.getState().palettes.some((p) => p.id === id);
}
