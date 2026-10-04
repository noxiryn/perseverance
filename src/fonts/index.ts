/**
 * fonts-color module — fonts half: bundled fonts (FontFace declarations, lazy download), system
 * fonts (Local Font Access, lazy), user fonts (IndexedDB), the Fonts panel and font commands.
 * (Imported by src/features.ts.)
 */
import { CaseSensitive, FilePlus2, Monitor } from 'lucide-react';
import { commands, panels } from '../registry';
import { useUI } from '../state/ui';
import { registerBundledFonts } from './bundled';
import { FontsPanel, fontsPanelMenu } from './FontsPanel';
import { loadSystemFonts, systemFontsSupported, useSystemFonts } from './system';
import { addFontFiles, restoreUserFonts } from './userFonts';

registerBundledFonts();
// User fonts are re-registered from IndexedDB at startup (async, never blocks).
if (typeof window !== 'undefined') void restoreUserFonts();

panels.register({
  id: 'fonts',
  title: 'Fonts',
  icon: CaseSensitive,
  component: FontsPanel,
  defaultSlot: 'strip',
  order: 50,
  menu: fontsPanelMenu,
});

commands.registerMany([
  {
    id: 'type.addFont',
    label: 'Add Font File…',
    menu: 'Type',
    group: '60-fonts',
    order: 10,
    icon: FilePlus2,
    keywords: ['font', 'install', 'ttf', 'otf', 'woff', 'import font', 'custom font'],
    run: () => void addFontFiles(),
  },
  {
    id: 'type.loadSystemFonts',
    label: 'Load System Fonts',
    menu: 'Type',
    group: '60-fonts',
    order: 20,
    icon: Monitor,
    keywords: ['font', 'local fonts', 'installed fonts', 'system'],
    enabled: () => systemFontsSupported() && useSystemFonts.getState().status !== 'loaded',
    run: () => void loadSystemFonts(),
  },
  {
    id: 'type.browseFonts',
    label: 'Browse Fonts…',
    menu: 'Type',
    group: '60-fonts',
    order: 30,
    icon: CaseSensitive,
    keywords: ['fonts panel', 'font browser', 'typeface'],
    run: () => useUI.getState().showPanel('fonts'),
  },
]);
