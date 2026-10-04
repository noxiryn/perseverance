/** Searchable keyboard shortcuts reference: all commands (by menu) + tools + canvas keys. */
import { useMemo, useState } from 'react';
import { Dialog, SearchInput, Button, Checkbox } from '../../controls';
import { commands, tools } from '../../../registry';
import { buildMenuTree, shortcutAlternatives, TOP_MENUS, type MenuTreeNode } from '../menuModel';
import { Keys } from '../Keys';

interface Row {
  label: string;
  path?: string;
  shortcuts: string[];
}

interface Group {
  title: string;
  rows: Row[];
}

const CANVAS_KEYS: Row[] = [
  { label: 'Hand tool (temporary)', path: 'Hold', shortcuts: ['Space'] },
  { label: 'Eyedropper while painting (temporary)', path: 'Hold', shortcuts: ['Alt'] },
  { label: 'Cycle tools in a group', path: 'Shift + tool key', shortcuts: [] },
  { label: 'Show / hide all panels', shortcuts: ['Tab'] },
  { label: 'Command search', shortcuts: ['Ctrl+K'] },
  { label: 'Focus the menu bar', shortcuts: ['Alt'] },
];

function flattenTree(nodes: MenuTreeNode[], path: string[], out: Row[]) {
  for (const n of nodes) {
    if (n.kind === 'command') out.push({ label: n.command.label, path: path.join(' › '), shortcuts: shortcutAlternatives(n.command.shortcut) });
    else if (n.kind === 'submenu') flattenTree(n.children, [...path, n.label], out);
  }
}

function collectGroups(): Group[] {
  const groups: Group[] = [];
  const tree = buildMenuTree(commands.list());
  for (const m of tree) {
    const rows: Row[] = [];
    flattenTree(m.items, [], rows);
    if (rows.length) groups.push({ title: `${m.name} menu`, rows });
  }
  const palette = commands
    .list()
    .filter((c) => !c.menu)
    .map((c) => ({ label: c.label, shortcuts: shortcutAlternatives(c.shortcut) }));
  if (palette.length) groups.push({ title: 'Other commands', rows: palette });
  const toolRows = [...tools.list()]
    .sort((a, b) => a.order - b.order)
    .map((t) => ({ label: t.name, path: 'Tool', shortcuts: t.shortcut ? [t.shortcut] : [] }));
  if (toolRows.length) groups.push({ title: 'Tools', rows: toolRows });
  groups.push({ title: 'Canvas & navigation', rows: CANVAS_KEYS });
  // Keep menu order stable even for unknown menus.
  return groups.sort((a, b) => {
    const ia = TOP_MENUS.indexOf(a.title.replace(/ menu$/, '') as never);
    const ib = TOP_MENUS.indexOf(b.title.replace(/ menu$/, '') as never);
    return (ia < 0 ? 100 : ia) - (ib < 0 ? 100 : ib);
  });
}

export function ShortcutsDialog({ close }: { close: (r?: unknown) => void }) {
  const [q, setQ] = useState('');
  const [onlyBound, setOnlyBound] = useState(true);
  const groups = useMemo(collectGroups, []);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        rows: g.rows.filter((r) => {
          if (onlyBound && !r.shortcuts.length && g.title !== 'Canvas & navigation') return false;
          if (!s) return true;
          return `${r.label} ${r.path ?? ''} ${r.shortcuts.join(' ')} ${g.title}`.toLowerCase().includes(s);
        }),
      }))
      .filter((g) => g.rows.length);
  }, [groups, q, onlyBound]);

  return (
    <Dialog title="Keyboard Shortcuts" onClose={() => close()} width={760} footer={<Button onClick={() => close()}>Close</Button>}>
      <div className="shell-sc-top">
        <div style={{ flex: 1 }}>
          <SearchInput value={q} onChange={setQ} placeholder="Search shortcuts…" autoFocus />
        </div>
        <Checkbox checked={onlyBound} onChange={setOnlyBound} label="Only with shortcuts" />
      </div>
      <div className="shell-sc-list">
        {filtered.map((g) => (
          <div key={g.title} className="shell-sc-group">
            <div className="shell-sc-group-title">{g.title}</div>
            {g.rows.map((r, i) => (
              <div key={i} className="shell-sc-row">
                <span className="shell-sc-label">{r.label}</span>
                {r.path && <span className="shell-sc-path">{r.path}</span>}
                <span className="shell-sc-keys">
                  {r.shortcuts.length ? r.shortcuts.map((s) => <Keys key={s} shortcut={s} />) : <span className="shell-sc-none">—</span>}
                </span>
              </div>
            ))}
          </div>
        ))}
        {!filtered.length && <div className="ui-empty">No shortcuts match “{q}”.</div>}
      </div>
    </Dialog>
  );
}
