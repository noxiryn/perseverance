/**
 * Commands owned by the shell: Window menu (workspaces, one checkable entry per panel, command
 * palette, toggle panels), Help menu, Edit ▸ Preferences, color swap/reset.
 */
import type { ComponentType } from 'react';
import { ArrowLeftRight, Command as CommandIcon, FolderOpen, Info, Keyboard, Lightbulb, PanelRightDashed, RotateCcw, Settings } from 'lucide-react';
import { commands, panels, type CommandDef, type PanelDef } from '../../registry';
import { desktop, isDesktop } from '../../platform';
import { useEditor } from '../../state/editor';
import { openDialog, toast, useUI } from '../../state/ui';
import { AboutDialog } from './dialogs/AboutDialog';
import { PreferencesDialog } from './dialogs/PreferencesDialog';
import { ShortcutsDialog } from './dialogs/ShortcutsDialog';
import { TipsDialog } from './dialogs/TipsDialog';
import { applyWorkspace, isPanelVisible, resetWorkspace, revealPanel, WORKSPACE_PRESETS } from './workspaces';

type DialogComponent = ComponentType<{ close: (result?: unknown) => void }>;

/** Open a dialog only once (re-running the command while it is open does nothing). */
function singleton(component: DialogComponent) {
  return () => {
    const open = useUI.getState().dialogs.some((d) => d.component === (component as unknown));
    if (!open) void openDialog(component);
  };
}

/** Well-known panel shortcuts (Photoshop-like). */
const PANEL_SHORTCUTS: Record<string, string> = { layers: 'F7' };

function panelCommand(p: PanelDef, order: number): CommandDef {
  return {
    id: `window.panel.${p.id}`,
    label: p.title,
    menu: 'Window',
    group: '20-panels',
    order,
    icon: p.icon,
    shortcut: PANEL_SHORTCUTS[p.id],
    keywords: ['panel', 'show', p.id],
    checked: () => isPanelVisible(p.id),
    run: () => revealPanel(p.id, true),
  };
}

/** Keep one Window-menu command per registered panel (also for panels registered later). */
function syncPanelCommands() {
  const list = [...panels.list()].sort((a, b) => a.title.localeCompare(b.title));
  const want = new Set(list.map((p) => `window.panel.${p.id}`));
  list.forEach((p, i) => {
    const id = `window.panel.${p.id}`;
    const existing = commands.get(id);
    if (!existing || existing.label !== p.title || existing.order !== i || existing.icon !== p.icon) commands.register(panelCommand(p, i));
  });
  for (const c of commands.list()) {
    if (c.id.startsWith('window.panel.') && !want.has(c.id)) commands.unregister(c.id);
  }
}

let registered = false;

export function registerShellCommands() {
  if (registered) return;
  registered = true;

  const defs: CommandDef[] = [
    /* ---- Window ---- */
    ...WORKSPACE_PRESETS.map((w, i) => ({
      id: `window.workspace.${w.id}`,
      label: w.name,
      menu: 'Window/Workspace',
      group: '10-workspace',
      order: i,
      keywords: ['workspace', 'layout'],
      checked: () => useUI.getState().workspace.id === w.id,
      run: () => applyWorkspace(w.id),
    })),
    {
      id: 'window.resetWorkspace',
      label: 'Reset Workspace',
      menu: 'Window/Workspace',
      group: '11-workspace-reset',
      order: 0,
      icon: RotateCcw,
      keywords: ['layout', 'panels', 'default'],
      run: () => {
        resetWorkspace();
        toast(`${useUI.getState().workspace.name} workspace reset`, 'info');
      },
    },
    {
      id: 'window.commandPalette',
      label: 'Command Search…',
      menu: 'Window',
      group: '30-palette',
      order: 0,
      shortcut: 'Ctrl+K',
      icon: CommandIcon,
      keywords: ['palette', 'search', 'find', 'command'],
      run: () => useUI.getState().setCommandPalette(!useUI.getState().commandPaletteOpen),
    },
    {
      id: 'window.togglePanels',
      label: 'Show Panels',
      menu: 'Window',
      group: '30-palette',
      order: 1,
      shortcut: 'Tab',
      icon: PanelRightDashed,
      keywords: ['hide', 'panels', 'dock', 'distraction free'],
      checked: () => useUI.getState().dockVisible,
      run: () => useUI.setState((s) => ({ dockVisible: !s.dockVisible, flyoutPanel: null })),
    },

    /* ---- Help ---- */
    {
      id: 'help.shortcuts',
      label: 'Keyboard Shortcuts…',
      menu: 'Help',
      group: '10-help',
      order: 0,
      shortcut: 'F1',
      icon: Keyboard,
      keywords: ['keys', 'hotkeys', 'shortcuts', 'help'],
      run: singleton(ShortcutsDialog),
    },
    {
      id: 'help.tips',
      label: 'Make Your First Roblox Thumbnail…',
      menu: 'Help',
      group: '10-help',
      order: 1,
      icon: Lightbulb,
      keywords: ['tutorial', 'guide', 'tips', 'getting started', 'learn'],
      run: singleton(TipsDialog),
    },
    {
      id: 'help.about',
      label: 'About Perseverance',
      menu: 'Help',
      group: '90-about',
      order: 0,
      icon: Info,
      keywords: ['version', 'credits', 'license'],
      run: singleton(AboutDialog),
    },

    /* ---- Edit ---- */
    {
      id: 'edit.keyboardShortcuts',
      label: 'Keyboard Shortcuts…',
      menu: 'Edit',
      group: '90-prefs',
      order: 0,
      icon: Keyboard,
      keywords: ['keys', 'hotkeys'],
      run: singleton(ShortcutsDialog),
    },
    {
      id: 'edit.preferences',
      label: 'Preferences…',
      menu: 'Edit',
      group: '90-prefs',
      order: 1,
      icon: Settings,
      keywords: ['settings', 'options', 'ui scale', 'autosave', 'toasts'],
      run: singleton(PreferencesDialog),
    },

    /* ---- Colors (palette-only) ---- */
    {
      id: 'shell.swapColors',
      label: 'Swap Foreground/Background Colors',
      shortcut: 'X',
      icon: ArrowLeftRight,
      keywords: ['color', 'swap'],
      run: () => useEditor.getState().swapColors(),
    },
    {
      id: 'shell.resetColors',
      label: 'Default Foreground/Background Colors',
      shortcut: 'D',
      keywords: ['color', 'reset', 'black', 'white'],
      run: () => useEditor.getState().resetColors(),
    },
  ];

  if (isDesktop) {
    defs.push({
      id: 'help.openDataFolder',
      label: 'Open Data Folder',
      menu: 'Help',
      group: '50-data',
      order: 0,
      icon: FolderOpen,
      keywords: ['user data', 'autosave', 'assets', 'folder'],
      run: async () => {
        try {
          const p = await desktop!.userDataPath();
          desktop!.showItemInFolder(p);
        } catch (e) {
          toast(`Could not open the data folder: ${(e as Error).message ?? e}`, 'error');
        }
      },
    });
  }

  commands.registerMany(defs);
  syncPanelCommands();
  panels.subscribe(syncPanelCommands);
}
