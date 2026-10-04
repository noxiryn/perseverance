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

function load(): Partial<Pick<LooksUIState, 'target' | 'previews' | 'category'>> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return {
      target: v.target === 'doc' ? 'doc' : 'layer',
      previews: v.previews !== false,
      category: typeof v.category === 'string' ? v.category : 'All',
    };
  } catch {
    return {};
  }
}

function save(s: Pick<LooksUIState, 'target' | 'previews' | 'category'>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ target: s.target, previews: s.previews, category: s.category }));
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

export const useLooksUI = create<LooksUIState>()((set, get) => ({
  target: 'layer',
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

/** The layer id looks should target right now (null = whole document). */
export function currentTargetId(): ID | null {
  if (useLooksUI.getState().target === 'doc') return null;
  return activeSession()?.activeLayerId ?? null;
}
