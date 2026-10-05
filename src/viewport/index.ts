/**
 * viewport-select module entry (imported by src/features.ts): registers the selection /
 * navigation / transform tools and the Select, View and Edit ▸ Transform commands. The canvas
 * component itself is exported from ./Viewport.tsx and mounted by the shell.
 */
import { commands, tools } from '../registry';
import { moveTool } from './tools/move';
import { marqueeEllipseTool, marqueeRectTool } from './tools/marquee';
import { lassoTool, polygonLassoTool } from './tools/lasso';
import { magicWandTool } from './tools/wand';
import { cropTool } from './tools/crop';
import { eyedropperTool } from './tools/eyedropper';
import { handTool, zoomTool } from './tools/navigate';
import { viewportCommands } from './commands';
import './lifecycle';

tools.registerMany([
  moveTool,
  marqueeRectTool,
  marqueeEllipseTool,
  lassoTool,
  polygonLassoTool,
  magicWandTool,
  cropTool,
  eyedropperTool,
  handTool,
  zoomTool,
]);

commands.registerMany(viewportCommands);

export * from './snap';
export { applyCrop } from './cropApply';
export { openColorRange, closeColorRange } from './colorRange';
export { startFreeTransform, startSelectionTransform, commitTransform, cancelTransform, activeTransform } from './transform/controller';
