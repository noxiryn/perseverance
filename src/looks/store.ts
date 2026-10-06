/** Looks panel UI state (target mode, previews), persisted per user in localStorage. */
import { create } from 'zustand';
import type { ID } from '../core/types';
import { activeSession } from '../state/editor';

export type LookTargetMode = 'layer' | 'doc';

interface LooksUIState {
  target: LookTargetMode;
  previews: boolean;
  category: string;
  setTarget(t: LookTargetMode): void;
  setPreviews(v: boolean): void;
  setCategory(c: string): void;
}

const KEY = 'perseverance.looks';
/**
 * Stored settings version. v2: 'layer' means "this layer only" (grades and textures clipped to
 * it) and 'doc' is the default. Before, 'layer' (then the default, saved with any other setting)
 * gave the whole-image look that 'doc' gives now, so older settings start in 'doc'.
 */
const VERSION = 2;

/** Persisted Looks settings → state (pure; exported for tests). */
export function parseLooksSettings(raw: unknown): Partial<Pick<LooksUIState, 'target' | 'previews' | 'category'>> {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const current = v.v === VERSION;
  return {
    target: current && v.target === 'layer' ? 'layer' : 'doc',
    previews: v.previews !== false,
    category: typeof v.category === 'string' ? v.category : 'All',
  };
}

function load(): Partial<Pick<LooksUIState, 'target' | 'previews' | 'category'>> {
  try {
    return parseLooksSettings(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return {};
  }
}

function save(s: Pick<LooksUIState, 'target' | 'previews' | 'category'>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, target: s.target, previews: s.previews, category: s.category }));
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

export const useLooksUI = create<LooksUIState>()((set, get) => ({
  target: 'doc',
  previews: true,
  category: 'All',
  ...load(),
  setTarget(target) {
    set({ target });
    save(get());
  },
  setPreviews(previews) {
    set({ previews });
    save(get());
  },
  setCategory(category) {
    set({ category });
    save(get());
  },
}));

/** The layer id looks should target right now: the active layer in Layer mode, null = whole document. */
export function currentTargetId(): ID | null {
  if (useLooksUI.getState().target === 'doc') return null;
  return activeSession()?.activeLayerId ?? null;
}
