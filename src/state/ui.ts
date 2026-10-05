/**
 * UI store: workspace/dock layout, view toggles, dialogs and toasts.
 * Kept separate from the editor store so UI chrome changes don't re-render document consumers.
 */
import { create } from 'zustand';
import type { ComponentType } from 'react';
import { uid } from '../core/ids';
import type { DockSlot } from '../registry';

export interface DockGroupState {
  slot: Exclude<DockSlot, 'strip'>;
  tabs: string[];
  active: string;
  /** Flex weight for vertical sizing. */
  size: number;
  collapsed: boolean;
}

export interface WorkspaceLayout {
  id: string;
  name: string;
  groups: DockGroupState[];
  /** Panels shown as icons in the collapsed strip next to the dock. */
  strip: string[];
}

export interface Toast {
  id: string;
  message: string;
  kind: 'success' | 'info' | 'warning' | 'error';
  timeout: number;
}

export interface DialogOptions {
  /** Close when the backdrop is clicked (default true). Heavy editors may opt out. */
  closeOnBackdrop?: boolean;
}

export interface DialogEntry {
  id: string;
  component: ComponentType<{ close: (result?: unknown) => void } & Record<string, unknown>>;
  props: Record<string, unknown>;
  options?: DialogOptions;
  resolve: (v: unknown) => void;
}

export interface ViewToggles {
  rulers: boolean;
  guides: boolean;
  grid: boolean;
  /** Roblox safe-zone overlay for the current document format. */
  safeZones: boolean;
  /** Pixel grid at high zoom. */
  pixelGrid: boolean;
  snap: boolean;
  /** Show transform handles for the move tool. */
  transformControls: boolean;
  /** Extras: selection edges, layer bounds, etc. */
  extras: boolean;
}

export interface UIState {
  workspace: WorkspaceLayout;
  /** Panel currently popped out from the strip (shown as a flyout), or null. */
  flyoutPanel: string | null;
  /** Width of the right dock in px. */
  dockWidth: number;
  dockVisible: boolean;
  view: ViewToggles;
  gridSize: number;
  units: 'px' | '%';
  toasts: Toast[];
  dialogs: DialogEntry[];
  commandPaletteOpen: boolean;
  /** Show the welcome/start screen when no documents are open. */
  showStart: boolean;

  setWorkspace(w: WorkspaceLayout): void;
  showPanel(panelId: string): void;
  togglePanel(panelId: string): void;
  setGroupActive(slot: DockGroupState['slot'], panelId: string): void;
  setGroupCollapsed(slot: DockGroupState['slot'], collapsed: boolean): void;
  setGroupSize(slot: DockGroupState['slot'], size: number): void;
  setFlyout(panelId: string | null): void;
  setDockWidth(w: number): void;
  toggleView(key: keyof ViewToggles, value?: boolean): void;
  setGridSize(n: number): void;
  setUnits(u: UIState['units']): void;
  setCommandPalette(open: boolean): void;
  setShowStart(v: boolean): void;
}

/**
 * Default dock. The app's content-heavy browsers (Libraries, Looks) share the tall top group;
 * Swatches / Color / Navigator share the compact middle one; Layers keeps a generous bottom group.
 * Tuned so Libraries shows two-plus rows of thumbnails and Looks two rows of cards at 1366×768,
 * and more at 1600×960 (groups never go below the dock's minimum group height, see Dock.tsx).
 * Changing this? Add the previous version to LEGACY_PRESETS in src/ui/shell/workspaces.ts so
 * untouched saved copies migrate to it.
 */
export const DEFAULT_WORKSPACE: WorkspaceLayout = {
  id: 'essentials',
  name: 'Essentials',
  groups: [
    { slot: 'top', tabs: ['libraries', 'looks'], active: 'libraries', size: 1.6, collapsed: false },
    { slot: 'middle', tabs: ['swatches', 'color', 'navigator'], active: 'swatches', size: 0.8, collapsed: false },
    { slot: 'bottom', tabs: ['layers', 'properties', 'history'], active: 'layers', size: 1.4, collapsed: false },
  ],
  strip: ['adjustments', 'effects', 'character', 'brushes', 'fonts', 'roblox'],
};

export const useUI = create<UIState>()((set, get) => ({
  workspace: DEFAULT_WORKSPACE,
  flyoutPanel: null,
  dockWidth: 268,
  dockVisible: true,
  view: {
    rulers: false,
    guides: true,
    grid: false,
    safeZones: false,
    pixelGrid: true,
    snap: true,
    transformControls: true,
    extras: true,
  },
  gridSize: 64,
  units: 'px',
  toasts: [],
  dialogs: [],
  commandPaletteOpen: false,
  showStart: true,

  setWorkspace(w) {
    set({ workspace: w, flyoutPanel: null });
  },

  showPanel(panelId) {
    const ws = get().workspace;
    const g = ws.groups.find((gr) => gr.tabs.includes(panelId));
    if (g) {
      set({
        workspace: {
          ...ws,
          groups: ws.groups.map((gr) => (gr === g ? { ...gr, active: panelId, collapsed: false } : gr)),
        },
        flyoutPanel: null,
      });
    } else {
      set({ flyoutPanel: panelId });
    }
  },

  togglePanel(panelId) {
    const ws = get().workspace;
    const g = ws.groups.find((gr) => gr.tabs.includes(panelId));
    if (g && g.active === panelId && !g.collapsed) {
      set({ workspace: { ...ws, groups: ws.groups.map((gr) => (gr === g ? { ...gr, collapsed: true } : gr)) } });
    } else if (!g && get().flyoutPanel === panelId) {
      set({ flyoutPanel: null });
    } else {
      get().showPanel(panelId);
    }
  },

  setGroupActive(slot, panelId) {
    const ws = get().workspace;
    set({
      workspace: {
        ...ws,
        groups: ws.groups.map((g) => (g.slot === slot ? { ...g, active: panelId, collapsed: false } : g)),
      },
    });
  },

  setGroupCollapsed(slot, collapsed) {
    const ws = get().workspace;
    set({ workspace: { ...ws, groups: ws.groups.map((g) => (g.slot === slot ? { ...g, collapsed } : g)) } });
  },

  setGroupSize(slot, size) {
    const ws = get().workspace;
    set({ workspace: { ...ws, groups: ws.groups.map((g) => (g.slot === slot ? { ...g, size } : g)) } });
  },

  setFlyout(panelId) {
    set({ flyoutPanel: panelId });
  },

  setDockWidth(w) {
    set({ dockWidth: Math.max(220, Math.min(520, w)) });
  },

  toggleView(key, value) {
    set((st) => ({ view: { ...st.view, [key]: value ?? !st.view[key] } }));
  },

  setGridSize(n) {
    set({ gridSize: Math.max(4, n) });
  },

  setUnits(u) {
    set({ units: u });
  },

  setCommandPalette(open) {
    set({ commandPaletteOpen: open });
  },

  setShowStart(v) {
    set({ showStart: v });
  },
}));

/* ------------------------------------------------------------------ */
/* Toasts & dialogs API                                                */
/* ------------------------------------------------------------------ */

/** Show a transient notification (like Photoshop's "✓ Delete Layer completed."). */
export function toast(message: string, kind: Toast['kind'] = 'success', timeout = 2600) {
  const t: Toast = { id: uid('t_'), message, kind, timeout };
  useUI.setState((st) => ({ toasts: [...st.toasts.slice(-4), t] }));
  window.setTimeout(() => dismissToast(t.id), timeout);
}

export function dismissToast(id: string) {
  useUI.setState((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }));
}

/**
 * Open a modal dialog. The component receives `close(result)` plus `props`.
 * Resolves with the value passed to close (undefined if dismissed).
 */
export function openDialog<R = unknown, P extends Record<string, unknown> = Record<string, unknown>>(
  component: ComponentType<{ close: (result?: R) => void } & P>,
  props?: P,
  options?: DialogOptions,
): Promise<R | undefined> {
  return new Promise((resolve) => {
    const entry: DialogEntry = {
      id: uid('dlg_'),
      component: component as unknown as DialogEntry['component'],
      props: (props ?? {}) as Record<string, unknown>,
      options,
      resolve: resolve as (v: unknown) => void,
    };
    useUI.setState((st) => ({ dialogs: [...st.dialogs, entry] }));
  });
}

export function closeDialog(id: string, result?: unknown) {
  const d = useUI.getState().dialogs.find((x) => x.id === id);
  useUI.setState((st) => ({ dialogs: st.dialogs.filter((x) => x.id !== id) }));
  d?.resolve(result);
}
