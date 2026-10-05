/**
 * Roblox module entry: registers the Roblox filters, Character Styler panel, safe-zone overlay,
 * properties sections for character renders, and the Roblox/File/Select/View commands.
 * (Imported by src/features.ts.)
 */
import { Box } from 'lucide-react';
import { commands, filters, panels, propertiesSections, viewOverlays } from '../registry';
import { activeDoc } from '../state/editor';
import { robloxFilters } from './filters';
import { robloxCommands } from './commands';
import { StylerPanel } from './styler/StylerPanel';
import { safeZoneOverlay } from './preview/safeZones';
import { ModelSection, RigSection, isModelLayer, isRigLayer } from './studio/RigSection';
import { runCommand } from '../registry';
import './character';

filters.registerMany(robloxFilters);

panels.register({
  id: 'roblox',
  // Same name as Roblox ▸ Character Styler, the README and the guide.
  title: 'Character Styler',
  icon: Box,
  component: StylerPanel,
  defaultSlot: 'strip',
  order: 90,
  menu: () => [
    { label: 'Replace Character…', run: () => void runCommand('roblox.replaceCharacter') },
    { label: 'Remove Background…', run: () => void runCommand('roblox.removeBackground') },
    { label: 'Pose Studio…', run: () => void runCommand('roblox.poseStudio') },
    { label: 'Import 3D Model…', run: () => void runCommand('roblox.importModel') },
    { label: 'Fetch Roblox Avatar…', run: () => void runCommand('roblox.fetchAvatar') },
    { label: 'Roblox Preview…', run: () => void runCommand('roblox.preview') },
  ],
});

viewOverlays.register(safeZoneOverlay);

propertiesSections.register({
  id: 'rig',
  order: 30,
  title: 'Pose Studio Render',
  appliesTo: (layerId) => isRigLayer(activeDoc()?.layers[layerId]),
  component: RigSection,
});

propertiesSections.register({
  id: 'roblox-model',
  order: 31,
  title: '3D Model Render',
  appliesTo: (layerId) => isModelLayer(activeDoc()?.layers[layerId]),
  component: ModelSection,
});

commands.registerMany(robloxCommands);
