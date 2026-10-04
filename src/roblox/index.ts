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

filters.registerMany(robloxFilters);

panels.register({
  id: 'roblox',
  title: 'Roblox',
  icon: Box,
  component: StylerPanel,
  defaultSlot: 'strip',
  order: 90,
  menu: () => [
    { label: 'Pose Studio…', run: () => void runCommand('roblox.poseStudio') },
    { label: 'Import 3D Model…', run: () => void runCommand('roblox.importModel') },
    { label: 'Fetch Avatar…', run: () => void runCommand('roblox.fetchAvatar') },
    { label: 'Remove Background…', run: () => void runCommand('roblox.removeBackground') },
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
