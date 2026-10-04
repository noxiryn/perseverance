/** Shell-local UI state (menu bar focus, drag overlay…). Not persisted. */
import { create } from 'zustand';

export interface ShellState {
  /** Index of the open top-level menu, or null. */
  menuOpen: number | null;
  /** Keyboard-focused top-level menu (Alt pressed) while no menu is open. */
  menuFocus: number | null;
  /** Underline mnemonics in the menu bar. */
  mnemonics: boolean;
  /** A file drag is hovering the window. */
  fileDrag: boolean;
  /** Dock collapsed to the icon strip (all panels become strip icons + flyouts). */
  dockCollapsed: boolean;
  setMenuOpen(i: number | null): void;
  setMenuFocus(i: number | null): void;
  setMnemonics(v: boolean): void;
  setFileDrag(v: boolean): void;
  setDockCollapsed(v: boolean): void;
}

const COLLAPSED_KEY = 'perseverance.dockCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export const useShell = create<ShellState>()((set) => ({
  menuOpen: null,
  menuFocus: null,
  mnemonics: false,
  fileDrag: false,
  dockCollapsed: readCollapsed(),
  setDockCollapsed: (v) => {
    try {
      localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ dockCollapsed: v });
  },
  setMenuOpen: (i) => set((s) => ({ menuOpen: i, menuFocus: null, mnemonics: i === null ? false : s.mnemonics })),
  setMenuFocus: (i) => set({ menuFocus: i, mnemonics: i !== null }),
  setMnemonics: (v) => set({ mnemonics: v }),
  setFileDrag: (v) => set({ fileDrag: v }),
}));

/** True when the menu bar owns the keyboard (a menu is open or Alt-focused). */
export function menuBarActive(): boolean {
  const s = useShell.getState();
  return s.menuOpen !== null || s.menuFocus !== null;
}
