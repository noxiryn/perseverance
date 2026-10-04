/** Applying brush presets to tools (shared by the Brushes panel and the options-bar picker). */
import type { BrushPresetDef } from '../../../registry';
import { useEditor } from '../../../state/editor';
import { isRetouchTool, isTipTool, setOpts } from '../options';
import { presetSettings, type PaintBrushPreset } from './presets';

/**
 * The tool the Brushes panel edits: the active tool when it uses brush tips (brush, eraser,
 * clone stamp) or is a retouch tool (size/hardness only); otherwise the Brush tool.
 */
export function panelTargetTool(activeTool = useEditor.getState().activeTool): string {
  if (isTipTool(activeTool) || isRetouchTool(activeTool)) return activeTool;
  return 'brush';
}

/** Apply a preset to a tool's options (activates the brush when no brush-like tool is active). */
export function applyPreset(preset: BrushPresetDef, toolId?: string) {
  const st = useEditor.getState();
  const target = toolId ?? panelTargetTool(st.activeTool);
  if (isRetouchTool(target)) {
    setOpts(target, { size: preset.size, hardness: preset.hardness });
    return target;
  }
  const s = presetSettings(preset);
  const values: Record<string, unknown> = { ...s };
  if (target === 'brush') values.airbrush = !!(preset as PaintBrushPreset).airbrush;
  setOpts(target, values);
  if (!toolId && st.activeTool !== target) st.setTool(target);
  return target;
}
