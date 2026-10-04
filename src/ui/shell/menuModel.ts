/**
 * Pure menu-tree construction from the commands registry.
 *
 * Commands declare `menu` ('Image' or 'Image/Adjustments'), `group` and `order`. Items are sorted
 * by group then order; a separator is inserted between groups. A submenu is positioned inside its
 * parent at the smallest (group, order) of its descendants.
 */
import type { CommandDef } from '../../registry';

export const TOP_MENUS = ['File', 'Edit', 'Image', 'Layer', 'Type', 'Select', 'Filter', 'Roblox', 'View', 'Window', 'Help'] as const;
export type TopMenu = (typeof TOP_MENUS)[number];

/** Mnemonic letters (Alt+letter / letter while the menu bar is focused). */
export const MENU_MNEMONICS: Record<TopMenu, string> = {
  File: 'F',
  Edit: 'E',
  Image: 'I',
  Layer: 'L',
  Type: 'Y',
  Select: 'S',
  Filter: 'T',
  Roblox: 'R',
  View: 'V',
  Window: 'W',
  Help: 'H',
};

export type MenuTreeNode =
  | { kind: 'command'; command: CommandDef; group: string; order: number }
  | { kind: 'submenu'; label: string; group: string; order: number; children: MenuTreeNode[] }
  | { kind: 'separator' };

interface Bucket {
  label: string;
  commands: CommandDef[];
  subs: Map<string, Bucket>;
}

const DEFAULT_GROUP = '50';
const DEFAULT_ORDER = 100;

function newBucket(label: string): Bucket {
  return { label, commands: [], subs: new Map() };
}

function cmpKey(a: { group: string; order: number; label: string }, b: { group: string; order: number; label: string }) {
  if (a.group !== b.group) return a.group < b.group ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.label.localeCompare(b.label);
}

type Sortable = Exclude<MenuTreeNode, { kind: 'separator' }>;

function bucketToNodes(b: Bucket): Sortable[] {
  const items: Sortable[] = b.commands.map((c) => ({
    kind: 'command' as const,
    command: c,
    group: c.group ?? DEFAULT_GROUP,
    order: c.order ?? DEFAULT_ORDER,
  }));
  for (const sub of b.subs.values()) {
    const children = bucketToNodes(sub);
    if (!children.length) continue;
    // Position = smallest (group, order) among descendants.
    let group = children[0].group;
    let order = children[0].order;
    for (const ch of children) {
      if (ch.group < group || (ch.group === group && ch.order < order)) {
        group = ch.group;
        order = ch.order;
      }
    }
    items.push({ kind: 'submenu', label: sub.label, group, order, children: withSeparators(children) as never });
  }
  items.sort((x, y) =>
    cmpKey(
      { group: x.group, order: x.order, label: x.kind === 'command' ? x.command.label : x.label },
      { group: y.group, order: y.order, label: y.kind === 'command' ? y.command.label : y.label },
    ),
  );
  return items;
}

/** Insert separators between groups (input must be sorted). */
function withSeparators(items: Sortable[]): MenuTreeNode[] {
  const out: MenuTreeNode[] = [];
  let lastGroup: string | null = null;
  for (const it of items) {
    if (lastGroup !== null && it.group !== lastGroup) out.push({ kind: 'separator' });
    out.push(it);
    lastGroup = it.group;
  }
  return out;
}

/**
 * Build the tree for every top-level menu. Unknown top-level names (e.g. a module registering
 * 'Plugins') are appended after the standard menus.
 */
export function buildMenuTree(cmds: readonly CommandDef[]): { name: string; items: MenuTreeNode[] }[] {
  const roots = new Map<string, Bucket>();
  for (const name of TOP_MENUS) roots.set(name, newBucket(name));
  for (const c of cmds) {
    if (!c.menu) continue;
    const parts = c.menu
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) continue;
    let b: Bucket | undefined = roots.get(parts[0]);
    if (!b) {
      b = newBucket(parts[0]);
      roots.set(parts[0], b);
    }
    for (const p of parts.slice(1)) {
      let next: Bucket | undefined = b.subs.get(p);
      if (!next) {
        next = newBucket(p);
        b.subs.set(p, next);
      }
      b = next;
    }
    b.commands.push(c);
  }
  const out: { name: string; items: MenuTreeNode[] }[] = [];
  for (const [name, b] of roots) {
    const items = withSeparators(bucketToNodes(b));
    // Standard menus are always shown (even if empty); extra ones only if non-empty.
    if (items.length || (TOP_MENUS as readonly string[]).includes(name)) out.push({ name, items });
  }
  return out;
}

/** Split a shortcut string that lists alternatives ('Shift+Ctrl+Z / Ctrl+Y'). */
export function shortcutAlternatives(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(/\s+\/\s+|\s*\|\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Full menu path label for a command, e.g. 'Image › Adjustments'. */
export function menuPathLabel(c: CommandDef): string {
  return c.menu ? c.menu.split('/').join(' › ') : '';
}
