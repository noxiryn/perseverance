/**
 * Paint module entry: brush engine tools (brush, pencil, eraser, clone stamp, gradient, paint
 * bucket, blur/sharpen/smudge, dodge/burn/sponge), brush presets and the Brushes panel.
 * Imported by src/features.ts.
 */
import { Paintbrush } from 'lucide-react';
import { brushPresets, panels, tools } from '../../registry';
import { useEditor } from '../../state/editor';
import { prewarmTexture } from './engine/tips';
import { TIP_TOOLS } from './options';
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

/*
 * Pre-generate the textured tip a tip tool will need (preset chosen / size changed from the
 * panel, options bar or '[' ']') while the app is idle, so the first dab never waits for it.
 */
let lastTipOpts: Record<string, unknown> = {};
useEditor.subscribe((st) => {
  for (const toolId of TIP_TOOLS) {
    const o = st.toolOptions[toolId] as { presetId?: string; size?: number } | undefined;
    if (!o || o === lastTipOpts[toolId]) continue;
    lastTipOpts = { ...lastTipOpts, [toolId]: o };
    if (o.presetId && typeof o.size === 'number') prewarmTexture(brushPresets.get(o.presetId), o.size);
  }
});

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
