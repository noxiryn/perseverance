/** The bundled shape presets library (all original designs — no logos or trademarks). */
import type { ShapePresetDef } from '../../../registry';
import { basicPresets } from './basic';
import { arrowPresets } from './arrows';
import { comicPresets } from './comic';
import { gothicPresets } from './gothic';
import { fantasyPresets } from './fantasy';
import { uiPresets } from './ui';
import { blockyPresets } from './blocky';
import { naturePresets } from './nature';

export const SHAPE_PRESET_CATEGORIES = ['Basic', 'Arrows', 'Comic', 'Gothic & Ornaments', 'Fantasy & Combat', 'UI & Badges', 'Blocky', 'Nature'] as const;

export const SHAPE_PRESETS: ShapePresetDef[] = [
  ...basicPresets,
  ...arrowPresets,
  ...comicPresets,
  ...gothicPresets,
  ...fantasyPresets,
  ...uiPresets,
  ...blockyPresets,
  ...naturePresets,
];

export const DEFAULT_SHAPE_PRESET = 'star-5';
