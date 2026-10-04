/** Fallback titles/icons for panel ids that are not (yet) registered. */
import type { ComponentType } from 'react';
import {
  Blend,
  Box,
  Brush,
  CaseSensitive,
  Compass,
  History,
  Layers,
  LibraryBig,
  Palette,
  PanelRight,
  SlidersHorizontal,
  Sparkle,
  Sparkles,
  SwatchBook,
  Type,
} from 'lucide-react';
import { panels } from '../../registry';

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

const FALLBACK: Record<string, { title: string; icon: Icon }> = {
  navigator: { title: 'Navigator', icon: Compass },
  libraries: { title: 'Libraries', icon: LibraryBig },
  swatches: { title: 'Swatches', icon: SwatchBook },
  color: { title: 'Color', icon: Palette },
  looks: { title: 'Looks', icon: Sparkles },
  layers: { title: 'Layers', icon: Layers },
  properties: { title: 'Properties', icon: SlidersHorizontal },
  history: { title: 'History', icon: History },
  adjustments: { title: 'Adjustments', icon: Blend },
  effects: { title: 'Effects', icon: Sparkle },
  character: { title: 'Character', icon: Type },
  brushes: { title: 'Brushes', icon: Brush },
  fonts: { title: 'Fonts', icon: CaseSensitive },
  roblox: { title: 'Roblox', icon: Box },
};

const cap = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function panelTitle(id: string): string {
  return panels.get(id)?.title ?? FALLBACK[id]?.title ?? cap(id);
}

export function panelIcon(id: string): Icon {
  return panels.get(id)?.icon ?? FALLBACK[id]?.icon ?? PanelRight;
}

export const PANEL_MIME = 'application/x-perseverance-panel';
