/**
 * Shape module: shape tools (U), the shape presets library and the shape Properties section.
 * Imported by src/features.ts.
 */
import { propertiesSections, shapePresets, tools } from '../../registry';
import { activeDoc } from '../../state/editor';
import { SHAPE_PRESETS } from './presets';
import { shapeTools } from './shapeTool';
import { ShapeProperties } from './ShapeProperties';

shapePresets.registerMany(SHAPE_PRESETS);
for (const t of shapeTools) tools.register(t);

propertiesSections.register({
  id: 'shape-props',
  order: 20,
  title: 'Shape',
  appliesTo: (layerId) => activeDoc()?.layers[layerId]?.type === 'shape',
  component: ShapeProperties,
});

export { SHAPE_PRESETS, SHAPE_PRESET_CATEGORIES } from './presets';
export { PresetGlyph, PresetPicker, PresetBrowser } from './PresetPicker';
export { traceGrid, simplifyClosed, smoothClosedPath } from './trace';
