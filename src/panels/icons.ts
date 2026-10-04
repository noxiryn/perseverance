/** Icons for layer types and history entries. */
import type { ComponentType } from 'react';
import {
  Blend,
  Brush,
  Combine,
  Copy,
  CornerLeftDown,
  Crop,
  Eraser,
  Eye,
  FilePlus,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Lock,
  Merge,
  Move,
  PaintBucket,
  Palette,
  Pipette,
  RotateCw,
  Scaling,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  SquareDashedMousePointer,
  Stamp,
  Trash2,
  Type,
  Wand,
  Pencil,
  ClipboardPaste,
  Scissors,
  FlipHorizontal,
  Grid2x2,
  History,
} from 'lucide-react';
import type { Layer } from '../core/types';
import { filters } from '../registry';

export type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

export function layerTypeIcon(l: Layer): Icon {
  switch (l.type) {
    case 'raster':
      return ImageIcon;
    case 'text':
      return Type;
    case 'shape':
      return Shapes;
    case 'fill':
      return l.fill.type === 'pattern' ? Grid2x2 : l.fill.type === 'gradient' ? Palette : PaintBucket;
    case 'adjustment':
      return filters.get(l.adjustment.filterId)?.icon ?? SlidersHorizontal;
    case 'group':
      return l.collapsed ? Folder : FolderOpen;
  }
}

export function layerTypeLabel(l: Layer): string {
  switch (l.type) {
    case 'raster':
      return l.generator ? 'Generated Layer' : 'Pixel Layer';
    case 'text':
      return 'Text Layer';
    case 'shape':
      return 'Shape Layer';
    case 'fill':
      return l.fill.type === 'solid' ? 'Color Fill Layer' : l.fill.type === 'gradient' ? 'Gradient Fill Layer' : 'Pattern Fill Layer';
    case 'adjustment':
      return `${filters.get(l.adjustment.filterId)?.name ?? l.adjustment.filterId} Adjustment`;
    case 'group':
      return 'Group';
  }
}

const HISTORY_ICONS: [RegExp, Icon][] = [
  [/^(open|new document|new from|open demo)/i, FilePlus],
  [/delete|clear|remove/i, Trash2],
  [/duplicate|copy/i, Copy],
  [/paste/i, ClipboardPaste],
  [/cut/i, Scissors],
  [/merge|flatten/i, Merge],
  [/group/i, Folder],
  [/mask/i, SquareDashed],
  [/clipping/i, CornerLeftDown],
  [/select|deselect|lasso|marquee|wand|inverse|feather/i, SquareDashedMousePointer],
  [/brush|paint|pencil|stroke(?! effect)|smudge|dodge|burn|sponge/i, Brush],
  [/erase/i, Eraser],
  [/clone|stamp/i, Stamp],
  [/text|type|font|character/i, Type],
  [/shape|rectangle|ellipse|star|polygon|line/i, Shapes],
  [/fill|bucket|gradient/i, PaintBucket],
  [/effect|style|shadow|glow|bevel|overlay|outline/i, Sparkles],
  [/filter|blur|sharpen|noise|halftone|posterize|cel/i, Wand],
  [/adjust|levels|curves|hue|brightness|exposure|balance|vibrance|lookup|map|threshold|invert/i, SlidersHorizontal],
  [/blend|opacity/i, Blend],
  [/move|nudge|align|distribute|arrange|bring|send/i, Move],
  [/transform|scale|resize|size/i, Scaling],
  [/rotate/i, RotateCw],
  [/flip/i, FlipHorizontal],
  [/crop|trim/i, Crop],
  [/hide|show|visibility/i, Eye],
  [/lock/i, Lock],
  [/rename|name/i, Pencil],
  [/color|swatch/i, Pipette],
  [/rasterize/i, ImageIcon],
  [/look|template/i, Combine],
  [/layer/i, Layers],
];

export function historyIcon(label: string): Icon {
  for (const [re, icon] of HISTORY_ICONS) if (re.test(label)) return icon;
  return History;
}
