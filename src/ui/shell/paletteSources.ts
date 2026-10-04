/**
 * Command palette data sources: commands, tools, panels, filters, assets, looks, templates, fonts.
 * Each source maps registry entries to PaletteItems with a run() action.
 */
import type { ComponentType } from 'react';
import {
  Blend,
  Box,
  Command as CommandIcon,
  Image as ImageIcon,
  LayoutTemplate,
  PanelRight,
  Sparkles,
  Type as TypeIcon,
  WandSparkles,
  Wrench,
} from 'lucide-react';
import {
  assets,
  commands,
  filters,
  fonts,
  looks,
  panels,
  templates,
  tools,
  type CommandDef,
  type FontDef,
} from '../../registry';
import type { TextLayer } from '../../core/types';
import { activeDoc, activeLayer, activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { openFilterDialog } from '../../filters/ui/filterDialog';
import { placeAsset } from '../../assets/place';
import { applyLook } from '../../looks/engine';
import { ensureFont } from '../../fonts/loader';
import { menuPathLabel, shortcutAlternatives } from './menuModel';
import { bareLabel, filterNamesCoveredByCommands } from './paletteRank';
import { runCommandSafely } from './MenuBar';
import { openTemplate } from './documents';
import { revealPanel } from './workspaces';

export type PaletteKind = 'command' | 'tool' | 'panel' | 'filter' | 'look' | 'template' | 'asset' | 'font';

export interface PaletteItem {
  key: string;
  kind: PaletteKind;
  title: string;
  subtitle?: string;
  shortcut?: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** Extra searchable text (keywords, category, tags). */
  keywords?: string;
  disabled?: boolean;
  /** Render the title in this font family (font previews). */
  fontFamily?: string;
  /** Hidden in the "All" scope because a menu command already offers the same action. */
  onlyInKind?: boolean;
  run(): void | Promise<void>;
}

export const KIND_LABELS: Record<PaletteKind, string> = {
  command: 'Commands',
  tool: 'Tools',
  panel: 'Panels',
  filter: 'Filters',
  look: 'Looks',
  template: 'Templates',
  asset: 'Assets',
  font: 'Fonts',
};

export const KIND_ORDER: PaletteKind[] = ['command', 'tool', 'panel', 'filter', 'look', 'template', 'asset', 'font'];

/** Score boost per kind (commands first on ties). */
export const KIND_BOOST: Record<PaletteKind, number> = {
  command: 6,
  tool: 5,
  panel: 4,
  filter: 3,
  look: 2,
  template: 2,
  asset: 1,
  font: 0,
};

export const KIND_ICONS: Record<PaletteKind, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  command: CommandIcon,
  tool: Wrench,
  panel: PanelRight,
  filter: WandSparkles,
  look: Sparkles,
  template: LayoutTemplate,
  asset: ImageIcon,
  font: TypeIcon,
};

function requireDoc(what: string): boolean {
  if (!activeDoc()) {
    toast(`Open or create a document first to use ${what}`, 'info');
    return false;
  }
  return true;
}

function safeEnabled(c: CommandDef): boolean {
  try {
    return c.enabled ? c.enabled() : true;
  } catch {
    return true;
  }
}

/** Apply a font family to the active text layer (one history step). */
export async function applyFontToActiveLayer(f: FontDef) {
  const l = activeLayer();
  if (!activeDoc()) return void toast('Open a document and select a text layer to apply a font', 'info');
  if (!l || l.type !== 'text') return void toast('Select a text layer to apply a font', 'info');
  const weights = f.weights?.length ? f.weights : [400];
  const cur = l.text.fontWeight;
  const weight = weights.reduce((best, w) => (Math.abs(w - cur) < Math.abs(best - cur) ? w : best), weights[0]);
  const style = l.text.fontStyle === 'italic' && f.italic ? 'italic' : 'normal';
  await ensureFont(f.family, weight, style);
  useEditor.getState().updateLayer<TextLayer>(
    l.id,
    (layer) => {
      layer.text.fontFamily = f.family;
      layer.text.fontWeight = weight;
      layer.text.fontStyle = style;
    },
    'Change Font',
  );
  viewport.requestRender();
}

/** Menu-only aliases that would duplicate another palette entry. */
const PALETTE_HIDDEN = new Set(['edit.keyboardShortcuts']);

export function collectPaletteItems(): PaletteItem[] {
  const out: PaletteItem[] = [];
  const allCommands = commands.list();
  const coveredFilters = filterNamesCoveredByCommands(allCommands);

  for (const c of allCommands) {
    if (PALETTE_HIDDEN.has(c.id)) continue;
    out.push({
      key: `command:${c.id}`,
      kind: 'command',
      title: c.label,
      subtitle: menuPathLabel(c),
      shortcut: shortcutAlternatives(c.shortcut)[0],
      icon: c.icon,
      keywords: [c.id, ...(c.keywords ?? [])].join(' '),
      disabled: !safeEnabled(c),
      run: () => runCommandSafely(c),
    });
  }

  for (const t of tools.list()) {
    out.push({
      key: `tool:${t.id}`,
      kind: 'tool',
      title: t.name,
      subtitle: 'Tool',
      shortcut: t.shortcut,
      icon: t.icon,
      keywords: `${t.id} ${t.group} tool`,
      run: () => useEditor.getState().setTool(t.id),
    });
  }

  for (const p of panels.list()) {
    out.push({
      key: `panel:${p.id}`,
      kind: 'panel',
      title: p.title,
      subtitle: 'Show panel',
      icon: p.icon,
      keywords: `${p.id} panel window`,
      run: () => revealPanel(p.id),
    });
  }

  for (const f of filters.list()) {
    out.push({
      key: `filter:${f.id}`,
      kind: 'filter',
      title: `${f.name}…`,
      subtitle: `Filter › ${f.category}`,
      icon: f.icon ?? (f.adjustment ? Blend : WandSparkles),
      keywords: [f.id, f.category, f.description ?? '', ...(f.keywords ?? [])].join(' '),
      onlyInKind: coveredFilters.has(bareLabel(f.name)),
      run: () => {
        if (!requireDoc(f.name)) return;
        if (!activeSession()?.activeLayerId) return void toast('Select a layer to apply a filter to', 'info');
        return openFilterDialog(f.id);
      },
    });
  }

  for (const l of looks.list()) {
    out.push({
      key: `look:${l.id}`,
      kind: 'look',
      title: l.name,
      subtitle: `Look › ${l.category}`,
      icon: Sparkles,
      keywords: [l.id, l.category, l.description ?? ''].join(' '),
      run: () => {
        if (!requireDoc(`the “${l.name}” look`)) return;
        return applyLook(l.id, activeSession()?.activeLayerId ?? null);
      },
    });
  }

  for (const t of templates.list()) {
    out.push({
      key: `template:${t.id}`,
      kind: 'template',
      title: t.name,
      subtitle: `Template › ${t.category} · ${t.width}×${t.height}`,
      icon: LayoutTemplate,
      keywords: [t.id, t.category, t.description ?? '', 'new template'].join(' '),
      run: () => openTemplate(t),
    });
  }

  for (const a of assets.list()) {
    out.push({
      key: `asset:${a.id}`,
      kind: 'asset',
      title: a.name,
      subtitle: `Asset › ${a.category}`,
      icon: a.category === 'Roblox' ? Box : ImageIcon,
      keywords: [a.id, a.category, ...(a.tags ?? []), 'place asset'].join(' '),
      run: () => {
        if (!requireDoc(`“${a.name}”`)) return;
        placeAsset(a.id);
      },
    });
  }

  for (const f of fonts.list()) {
    out.push({
      key: `font:${f.id}`,
      kind: 'font',
      title: f.family,
      subtitle: `Font › ${f.category}`,
      icon: TypeIcon,
      fontFamily: f.family,
      keywords: [f.category, ...(f.tags ?? []), 'font'].join(' '),
      run: () => applyFontToActiveLayer(f),
    });
  }

  return out;
}

/** Commands suggested when the query is empty (only those registered are shown). */
export const SUGGESTED = [
  'command:file.new',
  'command:file.newFromTemplate',
  'command:file.open',
  'command:roblox.poseStudio',
  'command:file.placeAsset',
  'command:filter.gallery',
  'command:file.export',
  'command:help.tips',
];

const RECENT_KEY = 'perseverance.paletteRecent';

export function readPaletteRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function pushPaletteRecent(key: string) {
  try {
    const next = [key, ...readPaletteRecent().filter((k) => k !== key)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
