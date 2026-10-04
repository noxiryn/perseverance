/** 34px options bar: active tool icon (menu: group tools + reset) and the tool's OptionsBar. */
import { useRef } from 'react';
import { ChevronDown, MousePointer2 } from 'lucide-react';
import { tools, useRegistry } from '../../registry';
import { useEditor } from '../../state/editor';
import { showMenuAt, type MenuItem } from '../controls';
import { toast } from '../../state/ui';
import { ErrorBoundary } from './ErrorBoundary';

export function OptionsBar() {
  const activeId = useEditor((s) => s.activeTool);
  const list = useRegistry(tools);
  const tool = list.find((t) => t.id === activeId);
  const btn = useRef<HTMLButtonElement>(null);
  const Icon = tool?.icon ?? MousePointer2;
  const Bar = tool?.OptionsBar;

  const openMenu = () => {
    if (!btn.current || !tool) return;
    const siblings = list.filter((t) => t.group === tool.group).sort((a, b) => a.order - b.order);
    const items: MenuItem[] = [];
    if (siblings.length > 1) {
      items.push({ label: 'Tools', heading: true });
      siblings.forEach((t) => items.push({ label: t.name, icon: t.icon, checked: t.id === tool.id, shortcut: t.shortcut, run: () => useEditor.getState().setTool(t.id) }));
      items.push({ separator: true });
    }
    items.push({
      label: `Reset ${tool.name} Options`,
      run: () => {
        useEditor.setState((st) => {
          const next = { ...st.toolOptions };
          delete next[tool.id];
          return { toolOptions: next };
        });
        toast(`${tool.name} options reset`, 'info');
      },
    });
    items.push({
      label: 'Reset All Tools',
      run: () => {
        useEditor.setState({ toolOptions: {} });
        toast('All tool options reset', 'info');
      },
    });
    showMenuAt(btn.current, items, 200);
  };

  return (
    <div className="shell-optionsbar">
      <button ref={btn} className="shell-optionsbar-tool" onClick={openMenu} title={tool ? `${tool.name} — tool presets` : 'No tool'}>
        <Icon size={15} strokeWidth={1.6} />
        <ChevronDown size={9} className="shell-optionsbar-caret" />
      </button>
      <div className="shell-optionsbar-sep" />
      <div className="shell-optionsbar-content">
        <ErrorBoundary inline name={`${tool?.name ?? 'Tool'} options`} resetKey={activeId}>
          {Bar ? <Bar /> : <span className="shell-optionsbar-name">{tool?.name ?? 'Select a tool'}</span>}
        </ErrorBoundary>
      </div>
    </div>
  );
}
