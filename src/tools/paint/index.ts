/**
 * Paint module entry: brush engine tools (brush, pencil, eraser, clone stamp, gradient, paint
 * bucket, blur/sharpen/smudge, dodge/burn/sponge), brush presets and the Brushes panel.
 * Imported by src/features.ts.
 */
import { Paintbrush } from 'lucide-react';
import { brushPresets, panels, tools } from '../../registry';
import { BUILTIN_PRESETS } from './presets/presets';
import { loadUserPresets } from './presets/user';
import { brushTool, eraserTool, pencilTool } from './tools/brush';
import { cloneTool } from './tools/clone';
import { gradientTool } from './tools/gradient';
import { bucketTool } from './tools/bucket';
import { retouchTools } from './tools/retouch';
import { BrushesPanel } from './ui/BrushesPanel';

brushPresets.registerMany(BUILTIN_PRESETS);
loadUserPresets();

tools.registerMany([brushTool, pencilTool, cloneTool, eraserTool, gradientTool, bucketTool, ...retouchTools]);

panels.register({
  id: 'brushes',
  title: 'Brushes',
  icon: Paintbrush,
  component: BrushesPanel,
  defaultSlot: 'strip',
  order: 40,
});

export { applyPreset, panelTargetTool } from './presets/apply';
export { BUILTIN_PRESETS } from './presets/presets';
