/**
 * All built-in procedural assets, in library order.
 */
import type { AssetCategory, AssetDef } from '../registry';
import { paperAssets } from './generators/paper';
import { overlayAssets } from './generators/overlays';
import { lightAssets } from './generators/light';
import { atmosphereAssets } from './generators/atmosphere';
import { comicAssets } from './generators/comic';
import { frameAssets } from './generators/frames';
import { ornamentAssets } from './generators/ornaments';
import { splatterAssets } from './generators/splatter';
import { particleAssets } from './generators/particles';
import { backgroundAssets } from './generators/backgrounds';
import { robloxAssets } from './generators/roblox';

export const BUILTIN_ASSETS: AssetDef[] = [
  ...paperAssets,
  ...overlayAssets,
  ...lightAssets,
  ...atmosphereAssets,
  ...comicAssets,
  ...frameAssets,
  ...ornamentAssets,
  ...splatterAssets,
  ...particleAssets,
  ...backgroundAssets,
  ...robloxAssets,
];

/** Category display order in the library. */
export const CATEGORY_ORDER: AssetCategory[] = [
  'Paper & Grunge',
  'Overlays',
  'Light & Glow',
  'Smoke & Atmosphere',
  'Comic & Halftone',
  'Borders & Frames',
  'Ornaments',
  'Splatter & Ink',
  'Particles',
  'Backgrounds',
  'Shapes',
  'Roblox',
  'My Assets',
];
