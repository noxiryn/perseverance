/**
 * Workspace presets (dock layouts) and persistence of the chosen workspace + dock width.
 *
 * Persisted in localStorage 'perseverance.workspace':
 *   { version, activeId, layouts: { [workspaceId]: WorkspaceLayout }, dockWidth }
 * Each workspace remembers its customized layout (tab moves, sizes, collapsed groups) until
 * "Reset Workspace". When a preset changes (new LAYOUT_VERSION), saved copies the user never
 * customized (same tabs and sizes as the old preset) are dropped so the new preset applies;
 * customized ones are kept as they are.
 */
import { DEFAULT_WORKSPACE, useUI, type DockGroupState, type WorkspaceLayout } from '../../state/ui';
import { useShell } from './shellStore';
import { cssZoom } from './uiScale';

export const WORKSPACE_STORAGE_KEY = 'perseverance.workspace';

const g = (slot: DockGroupState['slot'], tabs: string[], size: number, active = tabs[0], collapsed = false): DockGroupState => ({
  slot,
  tabs,
  active,
  size,
  collapsed,
});

/** Bump when a preset changes; add the old preset to LEGACY_PRESETS. */
export const LAYOUT_VERSION = 2;

export const WORKSPACE_PRESETS: WorkspaceLayout[] = [
  DEFAULT_WORKSPACE,
  {
    // Browsing assets and looks first: Libraries/Looks get a tall group (≈520px at 1600×960),
    // Adjustments/Effects/Navigator wait collapsed in the middle (click a tab to open them).
    id: 'gfx',
    name: 'GFX Artist',
    groups: [
      g('top', ['libraries', 'looks'], 2.2),
      g('middle', ['adjustments', 'effects', 'navigator'], 0.8, 'adjustments', true),
      g('bottom', ['layers', 'properties', 'history'], 1.1),
    ],
    strip: ['swatches', 'color', 'character', 'brushes', 'fonts', 'roblox'],
  },
  {
    id: 'roblox',
    name: 'Roblox',
    groups: [
      g('top', ['roblox', 'libraries'], 1.5),
      g('middle', ['looks', 'effects', 'adjustments'], 1.2),
      g('bottom', ['layers', 'properties', 'history'], 1.3),
    ],
    strip: ['navigator', 'swatches', 'color', 'character', 'fonts', 'brushes'],
  },
  {
    id: 'typography',
    name: 'Typography',
    groups: [
      g('top', ['character', 'fonts'], 1.35),
      g('middle', ['effects', 'swatches', 'color'], 0.9),
      g('bottom', ['layers', 'properties', 'history'], 1.3),
    ],
    strip: ['navigator', 'libraries', 'looks', 'adjustments', 'brushes', 'roblox'],
  },
  {
    id: 'painting',
    name: 'Painting',
    groups: [
      g('top', ['color', 'swatches'], 1),
      g('middle', ['brushes', 'navigator'], 1.1),
      g('bottom', ['layers', 'history', 'properties'], 1.3),
    ],
    strip: ['libraries', 'looks', 'adjustments', 'effects', 'character', 'fonts', 'roblox'],
  },
];

export function workspacePreset(id: string): WorkspaceLayout | undefined {
  return WORKSPACE_PRESETS.find((w) => w.id === id);
}

/** Presets as shipped before LAYOUT_VERSION 2 (cramped Libraries/Looks), for migration. */
export const LEGACY_PRESETS: Record<number, WorkspaceLayout[]> = {
  1: [
    {
      id: 'essentials',
      name: 'Essentials',
      groups: [
        g('top', ['navigator', 'libraries'], 0.9),
        g('middle', ['swatches', 'color', 'looks'], 1),
        g('bottom', ['layers', 'properties', 'history'], 1.6),
      ],
      strip: ['adjustments', 'effects', 'character', 'brushes', 'fonts', 'roblox'],
    },
    {
      id: 'gfx',
      name: 'GFX Artist',
      groups: [
        g('top', ['libraries', 'navigator'], 1.15),
        g('middle', ['looks', 'adjustments', 'effects'], 1),
        g('bottom', ['layers', 'properties', 'history'], 1.5),
      ],
      strip: ['swatches', 'color', 'character', 'brushes', 'fonts', 'roblox'],
    },
    {
      id: 'roblox',
      name: 'Roblox',
      groups: [
        g('top', ['roblox', 'libraries'], 1.1),
        g('middle', ['looks', 'effects', 'adjustments'], 0.9),
        g('bottom', ['layers', 'properties', 'history'], 1.5),
      ],
      strip: ['navigator', 'swatches', 'color', 'character', 'fonts', 'brushes'],
    },
  ],
};

/**
 * True when `saved` is an uncustomized copy of `preset`: the same tabs per group, the same group
 * sizes and the same strip (the active tab and collapsed state don't count — those change just by
 * using the dock).
 */
export function isUncustomized(saved: WorkspaceLayout, preset: WorkspaceLayout): boolean {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  for (const slot of ['top', 'middle', 'bottom'] as const) {
    const a = saved.groups.find((x) => x.slot === slot);
    const b = preset.groups.find((x) => x.slot === slot);
    const at = a?.tabs ?? [];
    const bt = b?.tabs ?? [];
    if (!same(at, bt)) return false;
    if (bt.length && Math.abs((a?.size ?? 1) - (b?.size ?? 1)) > 1e-6) return false;
  }
  return same([...saved.strip].sort(), [...preset.strip].sort());
}

/**
 * Migrate saved layouts from an older LAYOUT_VERSION: uncustomized copies of a preset that has
 * changed since are dropped (the new preset is used); everything else is kept.
 */
export function migrateLayouts(layouts: Record<string, WorkspaceLayout>, fromVersion: number): Record<string, WorkspaceLayout> {
  const out: Record<string, WorkspaceLayout> = {};
  for (const [id, layout] of Object.entries(layouts)) {
    let drop = false;
    for (let v = Math.max(1, fromVersion); v < LAYOUT_VERSION; v++) {
      const old = LEGACY_PRESETS[v]?.find((p) => p.id === id);
      if (old && isUncustomized(layout, old)) drop = true;
    }
    if (!drop) out[id] = layout;
  }
  return out;
}

/** Deep copy so presets are never mutated through store updates. */
export function cloneLayout(w: WorkspaceLayout): WorkspaceLayout {
  return { ...w, groups: w.groups.map((gr) => ({ ...gr, tabs: [...gr.tabs] })), strip: [...w.strip] };
}

const SLOTS: DockGroupState['slot'][] = ['top', 'middle', 'bottom'];

/** Validate a persisted layout; returns null when unusable. */
export function sanitizeLayout(raw: unknown): WorkspaceLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<WorkspaceLayout>;
  if (typeof r.id !== 'string' || !Array.isArray(r.groups)) return null;
  const seen = new Set<string>();
  const groups: DockGroupState[] = [];
  for (const slot of SLOTS) {
    const src = r.groups.find((x) => x && (x as DockGroupState).slot === slot) as Partial<DockGroupState> | undefined;
    const tabs: string[] = [];
    for (const t of Array.isArray(src?.tabs) ? src!.tabs : []) {
      if (typeof t !== 'string' || seen.has(t)) continue;
      seen.add(t);
      tabs.push(t);
    }
    const active = typeof src?.active === 'string' && tabs.includes(src.active) ? src.active : (tabs[0] ?? '');
    const size = typeof src?.size === 'number' && Number.isFinite(src.size) && src.size > 0 ? Math.min(10, Math.max(0.15, src.size)) : 1;
    groups.push({ slot, tabs, active, size, collapsed: !!src?.collapsed });
  }
  const strip = (Array.isArray(r.strip) ? r.strip : []).filter((t): t is string => typeof t === 'string' && !seen.has(t));
  const preset = workspacePreset(r.id);
  return { id: r.id, name: typeof r.name === 'string' ? r.name : (preset?.name ?? r.id), groups, strip: [...new Set(strip)] };
}

interface Persisted {
  version: number;
  activeId: string;
  layouts: Record<string, WorkspaceLayout>;
  dockWidth: number;
}

/** Parse + sanitize + migrate the stored workspace state (pure; exported for tests). */
export function parsePersisted(raw: string | null): Persisted | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Persisted>;
    if (!v || typeof v !== 'object') return null;
    let layouts: Record<string, WorkspaceLayout> = {};
    if (v.layouts && typeof v.layouts === 'object') {
      for (const [id, l] of Object.entries(v.layouts)) {
        const s = sanitizeLayout(l);
        if (s && s.id === id) layouts[id] = s;
      }
    }
    const version = typeof v.version === 'number' && Number.isFinite(v.version) ? v.version : 1;
    if (version < LAYOUT_VERSION) layouts = migrateLayouts(layouts, version);
    return {
      version: LAYOUT_VERSION,
      activeId: typeof v.activeId === 'string' ? v.activeId : DEFAULT_WORKSPACE.id,
      layouts,
      dockWidth: typeof v.dockWidth === 'number' && Number.isFinite(v.dockWidth) ? v.dockWidth : 268,
    };
  } catch {
    return null;
  }
}

function readPersisted(): Persisted | null {
  try {
    return parsePersisted(localStorage.getItem(WORKSPACE_STORAGE_KEY));
  } catch {
    return null;
  }
}

let persisted: Persisted = { version: LAYOUT_VERSION, activeId: DEFAULT_WORKSPACE.id, layouts: {}, dockWidth: 268 };
let saveTimer = 0;

function writePersisted() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      /* ignore */
    }
  }, 250);
}

/** Header height of a dock group and the body height below which a group feels cramped (CSS px). */
const GROUP_HEAD_H = 30;
const COMFORT_BODY_H = 220;
/** Collapse order when space is short: the middle group holds the secondary panels in every preset. */
const COLLAPSE_ORDER: DockGroupState['slot'][] = ['middle', 'top', 'bottom'];

/**
 * A fresh copy of `preset` for a dock `dockHeight` CSS px tall: when the expanded groups can't each
 * get a comfortable body, groups are collapsed to their header (middle first, never below two
 * expanded groups) so the rest get real height — e.g. Essentials at 1366×768 opens with
 * Swatches/Color/Navigator collapsed and Libraries/Looks + Layers tall. The user expands a
 * collapsed group by clicking one of its tabs.
 */
export function fitLayoutToHeight(preset: WorkspaceLayout, dockHeight: number): WorkspaceLayout {
  const layout = cloneLayout(preset);
  if (!Number.isFinite(dockHeight) || dockHeight <= 0) return layout;
  const shown = layout.groups.filter((gr) => gr.tabs.length);
  const splitters = Math.max(0, shown.length - 1) * 5;
  const openCount = () => shown.filter((gr) => !gr.collapsed).length;
  const comfortable = () => {
    const open = openCount();
    return open === 0 || (dockHeight - splitters - shown.length * GROUP_HEAD_H) / open >= COMFORT_BODY_H;
  };
  for (const slot of COLLAPSE_ORDER) {
    if (comfortable() || openCount() <= 2) break;
    const gr = shown.find((x) => x.slot === slot && !x.collapsed);
    if (gr) gr.collapsed = true;
  }
  return layout;
}

/** Estimated dock height for the current window (CSS px): window minus title + options bars. */
function currentDockHeight(): number {
  if (typeof window === 'undefined') return 0;
  return window.innerHeight / cssZoom() - 66;
}

/** Fresh preset layout fitted to the current window. */
function freshLayout(preset: WorkspaceLayout): WorkspaceLayout {
  return fitLayoutToHeight(preset, currentDockHeight());
}

/** Switch to a workspace (restoring its remembered layout). */
export function applyWorkspace(id: string) {
  const preset = workspacePreset(id);
  if (!preset) return;
  const st = useUI.getState();
  persisted.layouts[st.workspace.id] = cloneLayout(st.workspace);
  const layout = persisted.layouts[id] ?? freshLayout(preset);
  persisted.activeId = id;
  st.setWorkspace(cloneLayout(layout));
  useUI.setState({ dockVisible: true });
  writePersisted();
}

/** Restore the current workspace to its preset. */
export function resetWorkspace() {
  const st = useUI.getState();
  const preset = workspacePreset(st.workspace.id) ?? DEFAULT_WORKSPACE;
  delete persisted.layouts[preset.id];
  st.setWorkspace(freshLayout(preset));
  useUI.setState({ dockVisible: true });
  st.setDockWidth(268);
  writePersisted();
}

let initialized = false;

/** Load persisted workspace state into the UI store and keep it saved. Idempotent. */
export function initWorkspacePersistence() {
  if (initialized) return;
  initialized = true;
  const p = readPersisted();
  if (p) {
    persisted = p;
    const preset = workspacePreset(p.activeId) ?? DEFAULT_WORKSPACE;
    const layout = p.layouts[preset.id] ?? freshLayout(preset);
    useUI.getState().setWorkspace(cloneLayout(layout));
    useUI.getState().setDockWidth(p.dockWidth);
  } else {
    useUI.getState().setWorkspace(freshLayout(DEFAULT_WORKSPACE));
  }
  useUI.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace || s.dockWidth !== prev.dockWidth) {
      persisted.activeId = s.workspace.id;
      persisted.layouts[s.workspace.id] = cloneLayout(s.workspace);
      persisted.dockWidth = s.dockWidth;
      writePersisted();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Pure layout edits (used by tab drag & drop)                         */
/* ------------------------------------------------------------------ */

export type DropTarget = { kind: 'group'; slot: DockGroupState['slot']; index?: number } | { kind: 'strip'; index?: number };

/** Move a panel to another group / the strip. Returns a new layout. */
export function movePanel(w: WorkspaceLayout, panelId: string, target: DropTarget): WorkspaceLayout {
  const next = cloneLayout(w);
  // Remove from wherever it is.
  for (const gr of next.groups) {
    const i = gr.tabs.indexOf(panelId);
    if (i >= 0) {
      gr.tabs.splice(i, 1);
      if (gr.active === panelId) gr.active = gr.tabs[Math.min(i, gr.tabs.length - 1)] ?? '';
    }
  }
  next.strip = next.strip.filter((p) => p !== panelId);
  if (target.kind === 'strip') {
    const idx = target.index ?? next.strip.length;
    next.strip.splice(Math.max(0, Math.min(idx, next.strip.length)), 0, panelId);
  } else {
    const gr = next.groups.find((x) => x.slot === target.slot);
    if (!gr) return w;
    const idx = target.index ?? gr.tabs.length;
    gr.tabs.splice(Math.max(0, Math.min(idx, gr.tabs.length)), 0, panelId);
    gr.active = panelId;
    gr.collapsed = false;
  }
  return next;
}

/** Remove a panel from the dock entirely (still reachable via Window menu → flyout). */
export function removePanel(w: WorkspaceLayout, panelId: string): WorkspaceLayout {
  const next = cloneLayout(w);
  for (const gr of next.groups) {
    const i = gr.tabs.indexOf(panelId);
    if (i >= 0) {
      gr.tabs.splice(i, 1);
      if (gr.active === panelId) gr.active = gr.tabs[Math.min(i, gr.tabs.length - 1)] ?? '';
    }
  }
  next.strip = next.strip.filter((p) => p !== panelId);
  return next;
}

/**
 * Whether a panel is currently visible: the active, expanded tab of a rendered dock group, or the
 * open flyout. While the dock is collapsed to the icon strip, groups are not rendered, so only
 * the flyout counts.
 */
export function isPanelVisible(panelId: string): boolean {
  const st = useUI.getState();
  if (!st.dockVisible) return false;
  if (st.flyoutPanel === panelId) return true;
  if (useShell.getState().dockCollapsed) return false;
  return st.workspace.groups.some((gr) => gr.active === panelId && !gr.collapsed && gr.tabs.includes(panelId));
}

/**
 * Make a panel visible (or, with `toggle`, hide it again when it is already showing), taking the
 * hidden dock (Tab) and the collapsed icon-strip dock into account. Used by the Window menu, the
 * command palette and the tips dialog.
 */
export function revealPanel(panelId: string, toggle = false) {
  if (!useUI.getState().dockVisible) {
    // Panels were hidden with Tab: bring them back and always show (never toggle off).
    useUI.setState({ dockVisible: true });
    toggle = false;
  }
  const ui = useUI.getState();
  if (useShell.getState().dockCollapsed) {
    // Dock groups are not rendered: the panel opens as a flyout beside the strip.
    ui.setFlyout(toggle && ui.flyoutPanel === panelId ? null : panelId);
    return;
  }
  if (toggle) ui.togglePanel(panelId);
  else ui.showPanel(panelId);
}
