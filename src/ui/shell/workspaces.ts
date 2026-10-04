/**
 * Workspace presets (dock layouts) and persistence of the chosen workspace + dock width.
 *
 * Persisted in localStorage 'perseverance.workspace':
 *   { activeId, layouts: { [workspaceId]: WorkspaceLayout }, dockWidth }
 * Each workspace remembers its customized layout (tab moves, sizes, collapsed groups) until
 * "Reset Workspace".
 */
import { DEFAULT_WORKSPACE, useUI, type DockGroupState, type WorkspaceLayout } from '../../state/ui';
import { useShell } from './shellStore';

export const WORKSPACE_STORAGE_KEY = 'perseverance.workspace';

const g = (slot: DockGroupState['slot'], tabs: string[], size: number, active = tabs[0]): DockGroupState => ({
  slot,
  tabs,
  active,
  size,
  collapsed: false,
});

export const WORKSPACE_PRESETS: WorkspaceLayout[] = [
  DEFAULT_WORKSPACE,
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
  activeId: string;
  layouts: Record<string, WorkspaceLayout>;
  dockWidth: number;
}

function readPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Persisted>;
    const layouts: Record<string, WorkspaceLayout> = {};
    if (v.layouts && typeof v.layouts === 'object') {
      for (const [id, l] of Object.entries(v.layouts)) {
        const s = sanitizeLayout(l);
        if (s && s.id === id) layouts[id] = s;
      }
    }
    return {
      activeId: typeof v.activeId === 'string' ? v.activeId : DEFAULT_WORKSPACE.id,
      layouts,
      dockWidth: typeof v.dockWidth === 'number' && Number.isFinite(v.dockWidth) ? v.dockWidth : 268,
    };
  } catch {
    return null;
  }
}

let persisted: Persisted = { activeId: DEFAULT_WORKSPACE.id, layouts: {}, dockWidth: 268 };
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

/** Switch to a workspace (restoring its remembered layout). */
export function applyWorkspace(id: string) {
  const preset = workspacePreset(id);
  if (!preset) return;
  const st = useUI.getState();
  persisted.layouts[st.workspace.id] = cloneLayout(st.workspace);
  const layout = persisted.layouts[id] ?? cloneLayout(preset);
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
  st.setWorkspace(cloneLayout(preset));
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
    const layout = p.layouts[preset.id] ?? cloneLayout(preset);
    useUI.getState().setWorkspace(cloneLayout(layout));
    useUI.getState().setDockWidth(p.dockWidth);
  } else {
    useUI.getState().setWorkspace(cloneLayout(DEFAULT_WORKSPACE));
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
