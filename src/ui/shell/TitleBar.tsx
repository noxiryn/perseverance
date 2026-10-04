/**
 * 32px title bar: logo, menu bar, command search, help/preferences, workspace switcher.
 * Draggable (Electron frameless window) with interactive parts marked .app-no-drag. Leaves room
 * for native window buttons (Windows/Linux: right; macOS: traffic lights on the left).
 */
import { useRef } from 'react';
import { ChevronDown, Keyboard, Lightbulb, Search, Settings } from 'lucide-react';
import { runCommand } from '../../registry';
import { isDesktop, isMac } from '../../platform';
import { useUI } from '../../state/ui';
import { showMenuAt, type MenuItem } from '../controls';
import { Keys } from './Keys';
import { LogoMark } from './Logo';
import { MenuBar } from './MenuBar';
import { applyWorkspace, resetWorkspace, WORKSPACE_PRESETS } from './workspaces';

function WorkspaceSwitcher() {
  const ws = useUI((s) => s.workspace);
  const ref = useRef<HTMLButtonElement>(null);
  const open = () => {
    if (!ref.current) return;
    const items: MenuItem[] = [
      { label: 'Workspaces', heading: true },
      ...WORKSPACE_PRESETS.map((w) => ({ label: w.name, checked: w.id === ws.id, run: () => applyWorkspace(w.id) })),
      { separator: true },
      { label: `Reset ${ws.name}`, run: resetWorkspace },
    ];
    showMenuAt(ref.current, items, ref.current.offsetWidth);
  };
  return (
    <button ref={ref} className="shell-ws-btn app-no-drag" onClick={open} title="Workspace">
      <span>{ws.name}</span>
      <ChevronDown size={12} />
    </button>
  );
}

export function TitleBar() {
  const setPalette = useUI((s) => s.setCommandPalette);
  const cls = ['shell-titlebar', 'app-drag', isDesktop && !isMac && 'shell-has-wco', isDesktop && isMac && 'shell-mac'].filter(Boolean).join(' ');
  return (
    <div className={cls} onDoubleClick={(e) => e.target === e.currentTarget && window.desktop?.toggleMaximize()}>
      <div className="shell-titlebar-left">
        <div className="shell-logo app-no-drag" title="Perseverance" onClick={() => runCommand('help.about')}>
          <LogoMark size={18} />
        </div>
        <MenuBar />
      </div>
      <div className="shell-titlebar-center">
        <button className="shell-search app-no-drag" onClick={() => setPalette(true)} title="Search commands, tools, panels, filters, assets… (Ctrl+K)">
          <Search size={12} strokeWidth={2} />
          <span className="shell-search-text">Search</span>
          <Keys shortcut="Ctrl+K" />
        </button>
      </div>
      <div className="shell-titlebar-right">
        <button className="shell-title-icon app-no-drag" title="Make your first Roblox thumbnail (Tips)" onClick={() => runCommand('help.tips')}>
          <Lightbulb size={14} strokeWidth={1.7} />
        </button>
        <button className="shell-title-icon app-no-drag" title="Keyboard shortcuts (F1)" onClick={() => runCommand('help.shortcuts')}>
          <Keyboard size={14} strokeWidth={1.7} />
        </button>
        <button className="shell-title-icon app-no-drag" title="Preferences" onClick={() => runCommand('edit.preferences')}>
          <Settings size={14} strokeWidth={1.7} />
        </button>
        <WorkspaceSwitcher />
      </div>
    </div>
  );
}
