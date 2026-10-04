/**
 * The Layer menu (ARCHITECTURE.md §5.3 "Layer"). All logic lives in ./layerOps.
 * Layer ▸ New Adjustment Layer belongs to the adjustments module.
 */
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  AlignVerticalSpaceAround,
  ArrowDownToLine,
  ArrowUpToLine,
  ArrowDown,
  ArrowUp,
  ClipboardCopy,
  ClipboardPaste,
  ClipboardX,
  Combine,
  CopyPlus,
  CornerLeftDown,
  Eye,
  FolderOpen,
  FolderPlus,
  Grid2x2,
  Layers2,
  Lock,
  Merge,
  PaintBucket,
  Palette,
  SquareDashed,
  SquarePlus,
  Sparkles,
  Trash2,
  Image as ImageIcon,
} from 'lucide-react';
import { commands, effects, type CommandDef } from '../registry';
import { activeSession } from '../state/editor';
import * as ops from './layerOps';
import { EFFECT_NAMES, EFFECT_ORDER, STYLE_PRESETS, effectName } from './effectPresets';
import { openFillLayerDialog } from './dialogs';

const hasDoc = () => ops.hasDoc();
const hasLayer = () => ops.hasLayer();
const activeHasMask = () => {
  const s = activeSession();
  const l = s?.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  return !!l?.mask;
};

function cmd(def: CommandDef) {
  commands.register(def);
}

export function registerLayerCommands() {
  /* ---------------- 10-new ---------------- */
  cmd({
    id: 'layer.new',
    label: 'New Layer',
    menu: 'Layer',
    group: '10-new',
    order: 10,
    shortcut: 'Shift+Ctrl+N',
    icon: SquarePlus,
    keywords: ['add layer', 'empty layer', 'pixel layer'],
    enabled: hasDoc,
    run: () => void ops.newLayer(),
  });
  cmd({
    id: 'layer.newGroup',
    label: 'New Group',
    menu: 'Layer',
    group: '10-new',
    order: 20,
    icon: FolderPlus,
    keywords: ['folder'],
    enabled: hasDoc,
    run: () => void ops.newGroup(),
  });
  cmd({
    id: 'layer.duplicate',
    label: 'Duplicate Layer',
    menu: 'Layer',
    group: '10-new',
    order: 30,
    shortcut: 'Ctrl+J',
    icon: CopyPlus,
    keywords: ['copy layer', 'layer via copy', 'clone'],
    enabled: hasLayer,
    run: () => void ops.duplicateLayers({ viaCopy: true }),
  });
  cmd({
    id: 'layer.delete',
    label: 'Delete Layer',
    menu: 'Layer',
    group: '10-new',
    order: 40,
    icon: Trash2,
    keywords: ['remove layer'],
    enabled: hasLayer,
    run: () => void ops.deleteLayers(),
  });

  /* ---------------- 20-fill ---------------- */
  cmd({
    id: 'layer.newFillSolid',
    label: 'Solid Color…',
    menu: 'Layer/New Fill Layer',
    group: '20-fill',
    order: 10,
    icon: PaintBucket,
    keywords: ['fill layer', 'color fill'],
    enabled: hasDoc,
    run: () => openFillLayerDialog('solid'),
  });
  cmd({
    id: 'layer.newFillGradient',
    label: 'Gradient…',
    menu: 'Layer/New Fill Layer',
    group: '20-fill',
    order: 20,
    icon: Palette,
    keywords: ['fill layer', 'gradient fill'],
    enabled: hasDoc,
    run: () => openFillLayerDialog('gradient'),
  });
  cmd({
    id: 'layer.newFillPattern',
    label: 'Pattern…',
    menu: 'Layer/New Fill Layer',
    group: '20-fill',
    order: 30,
    icon: Grid2x2,
    keywords: ['fill layer', 'pattern fill', 'texture'],
    enabled: hasDoc,
    run: () => openFillLayerDialog('pattern'),
  });

  /* ---------------- 30-style ---------------- */
  cmd({
    id: 'layer.copyStyle',
    label: 'Copy Layer Style',
    menu: 'Layer/Layer Style',
    group: '30-style~clip',
    order: 10,
    icon: ClipboardCopy,
    enabled: hasLayer,
    run: ops.copyStyle,
  });
  cmd({
    id: 'layer.pasteStyle',
    label: 'Paste Layer Style',
    menu: 'Layer/Layer Style',
    group: '30-style~clip',
    order: 20,
    icon: ClipboardPaste,
    enabled: () => hasLayer() && !!ops.useLayersUI.getState().styleClipboard,
    run: ops.pasteStyle,
  });
  cmd({
    id: 'layer.clearStyle',
    label: 'Clear Layer Style',
    menu: 'Layer/Layer Style',
    group: '30-style~clip',
    order: 30,
    icon: ClipboardX,
    enabled: hasLayer,
    run: ops.clearStyle,
  });
  STYLE_PRESETS.forEach((p, i) =>
    cmd({
      id: `layer.stylePreset.${p.id}`,
      label: p.name,
      menu: 'Layer/Layer Style/Style Presets',
      group: '30-style~presets',
      order: i,
      icon: Sparkles,
      keywords: ['layer style', 'preset', p.description],
      enabled: hasLayer,
      run: () => ops.applyStylePreset(p),
    }),
  );
  // One command per effect (known ids now, plus any effect registered later by the renderer).
  const registerEffectCommand = (effectId: string) => {
    const id = `layer.style.${effectId}`;
    if (commands.has(id)) return;
    const order = EFFECT_ORDER.indexOf(effectId);
    cmd({
      id,
      get label() {
        return `${effectName(effectId)}…`;
      },
      menu: 'Layer/Layer Style',
      group: '30-style',
      order: order < 0 ? 100 : order,
      keywords: ['layer style', 'effect', 'fx'],
      enabled: () => hasLayer() && (effects.list().length === 0 || effects.has(effectId)),
      run: () => void ops.addEffect(effectId),
    } as CommandDef);
  };
  Object.keys(EFFECT_NAMES).forEach(registerEffectCommand);
  effects.list().forEach((e) => registerEffectCommand(e.id));
  effects.subscribe(() => effects.list().forEach((e) => registerEffectCommand(e.id)));

  /* ---------------- 40-mask ---------------- */
  cmd({
    id: 'layer.addMask',
    label: 'Add Layer Mask (Reveal All)',
    menu: 'Layer',
    group: '40-mask',
    order: 10,
    icon: SquareDashed,
    keywords: ['mask', 'reveal all'],
    enabled: hasLayer,
    run: () => void ops.addMask('reveal'),
  });
  cmd({
    id: 'layer.addMaskHide',
    label: 'Add Layer Mask (Hide All)',
    menu: 'Layer',
    group: '40-mask',
    order: 20,
    keywords: ['mask', 'hide all'],
    enabled: hasLayer,
    run: () => void ops.addMask('hide'),
  });
  cmd({
    id: 'layer.maskFromSelection',
    label: 'Layer Mask from Selection',
    menu: 'Layer',
    group: '40-mask',
    order: 30,
    keywords: ['mask', 'reveal selection'],
    enabled: () => hasLayer() && !!activeSession()?.doc.selection,
    run: ops.maskFromSelection,
  });
  cmd({
    id: 'layer.applyMask',
    label: 'Apply Layer Mask',
    menu: 'Layer',
    group: '40-mask',
    order: 40,
    keywords: ['mask', 'bake mask'],
    enabled: activeHasMask,
    run: ops.applyMask,
  });
  cmd({
    id: 'layer.deleteMask',
    label: 'Delete Layer Mask',
    menu: 'Layer',
    group: '40-mask',
    order: 50,
    keywords: ['mask', 'remove mask'],
    enabled: activeHasMask,
    run: ops.deleteMask,
  });
  cmd({
    id: 'layer.toggleMask',
    label: 'Disable Layer Mask',
    menu: 'Layer',
    group: '40-mask',
    order: 60,
    keywords: ['mask', 'enable mask'],
    enabled: activeHasMask,
    checked: () => {
      const s = activeSession();
      const l = s?.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
      return !!l?.mask && !l.mask.enabled;
    },
    run: () => ops.toggleMaskEnabled(),
  });
  cmd({
    id: 'layer.clip',
    label: 'Create Clipping Mask',
    menu: 'Layer',
    group: '40-mask',
    order: 70,
    shortcut: 'Alt+Ctrl+G',
    icon: CornerLeftDown,
    keywords: ['clipping mask', 'clip to layer below'],
    enabled: hasLayer,
    run: ops.toggleClip,
  });
  cmd({
    id: 'layer.releaseClip',
    label: 'Release Clipping Mask',
    menu: 'Layer',
    group: '40-mask',
    order: 80,
    keywords: ['clipping mask', 'unclip'],
    enabled: () => {
      const s = activeSession();
      return !!s && ops.selectedIds(s).some((id) => s.doc.layers[id]?.clipped);
    },
    run: () => ops.setClipped(false),
  });

  /* ---------------- 50-convert ---------------- */
  cmd({
    id: 'layer.rasterize',
    label: 'Rasterize Layer',
    menu: 'Layer',
    group: '50-convert',
    order: 10,
    icon: ImageIcon,
    keywords: ['rasterize', 'convert to pixels', 'rasterize type', 'rasterize shape'],
    enabled: hasLayer,
    run: ops.rasterizeSelected,
  });
  cmd({
    id: 'layer.rasterizeStyle',
    label: 'Rasterize Layer Style',
    menu: 'Layer',
    group: '50-convert',
    order: 20,
    keywords: ['bake effects', 'flatten style'],
    enabled: hasLayer,
    run: ops.rasterizeStyleSelected,
  });

  /* ---------------- 60-group ---------------- */
  cmd({
    id: 'layer.group',
    label: 'Group Layers',
    menu: 'Layer',
    group: '60-group',
    order: 10,
    shortcut: 'Ctrl+G',
    icon: FolderPlus,
    keywords: ['group', 'folder'],
    enabled: hasLayer,
    run: () => void ops.groupSelected(),
  });
  cmd({
    id: 'layer.ungroup',
    label: 'Ungroup Layers',
    menu: 'Layer',
    group: '60-group',
    order: 20,
    shortcut: 'Shift+Ctrl+G',
    icon: FolderOpen,
    keywords: ['ungroup'],
    enabled: hasLayer,
    run: ops.ungroupSelected,
  });
  cmd({
    id: 'layer.hide',
    label: 'Hide / Show Layers',
    menu: 'Layer',
    group: '60-group',
    order: 30,
    shortcut: 'Ctrl+,',
    icon: Eye,
    keywords: ['visibility', 'hide layer', 'show layer'],
    enabled: hasLayer,
    run: ops.toggleHideSelected,
  });
  cmd({
    id: 'layer.lock',
    label: 'Lock / Unlock Layers',
    menu: 'Layer',
    group: '60-group',
    order: 40,
    shortcut: 'Ctrl+/',
    icon: Lock,
    keywords: ['lock all'],
    enabled: hasLayer,
    run: ops.toggleLockSelected,
  });

  /* ---------------- 70-arrange ---------------- */
  const arrange: [string, string, string, Parameters<typeof ops.arrangeSelected>[0], CommandDef['icon']][] = [
    ['layer.bringToFront', 'Bring to Front', 'Shift+Ctrl+]', 'front', ArrowUpToLine],
    ['layer.bringForward', 'Bring Forward', 'Ctrl+]', 'forward', ArrowUp],
    ['layer.sendBackward', 'Send Backward', 'Ctrl+[', 'backward', ArrowDown],
    ['layer.sendToBack', 'Send to Back', 'Shift+Ctrl+[', 'back', ArrowDownToLine],
  ];
  arrange.forEach(([id, label, shortcut, op, icon], i) =>
    cmd({
      id,
      label,
      menu: 'Layer/Arrange',
      group: '70-arrange',
      order: i * 10,
      shortcut,
      icon,
      keywords: ['arrange', 'order', 'z-order'],
      enabled: hasLayer,
      run: () => ops.arrangeSelected(op),
    }),
  );

  const align: [string, string, Parameters<typeof ops.alignSelected>[0], CommandDef['icon']][] = [
    ['layer.alignLeft', 'Left Edges', 'left', AlignStartVertical],
    ['layer.alignHCenter', 'Horizontal Centers', 'hcenter', AlignCenterVertical],
    ['layer.alignRight', 'Right Edges', 'right', AlignEndVertical],
    ['layer.alignTop', 'Top Edges', 'top', AlignStartHorizontal],
    ['layer.alignVCenter', 'Vertical Centers', 'vcenter', AlignCenterHorizontal],
    ['layer.alignBottom', 'Bottom Edges', 'bottom', AlignEndHorizontal],
  ];
  align.forEach(([id, label, mode, icon], i) =>
    cmd({
      id,
      label,
      menu: 'Layer/Align',
      group: i < 3 ? '70-arrange' : '70-arrange~v',
      order: 40 + i,
      icon,
      keywords: ['align', `align ${label.toLowerCase()}`, 'selection', 'canvas'],
      enabled: hasLayer,
      run: () => ops.alignSelected(mode),
    }),
  );
  const distribute: [string, string, 'h' | 'v', 'centers' | 'spacing', CommandDef['icon']][] = [
    ['layer.distributeHCenters', 'Horizontal Centers', 'h', 'centers', AlignHorizontalDistributeCenter],
    ['layer.distributeVCenters', 'Vertical Centers', 'v', 'centers', AlignVerticalDistributeCenter],
    ['layer.distributeHSpacing', 'Horizontal Spacing', 'h', 'spacing', AlignHorizontalSpaceAround],
    ['layer.distributeVSpacing', 'Vertical Spacing', 'v', 'spacing', AlignVerticalSpaceAround],
  ];
  distribute.forEach(([id, label, axis, mode, icon], i) =>
    cmd({
      id,
      label,
      menu: 'Layer/Distribute',
      group: mode === 'centers' ? '70-arrange' : '70-arrange~s',
      order: 50 + i,
      icon,
      keywords: ['distribute', 'space evenly'],
      enabled: hasLayer,
      run: () => ops.distributeSelected(axis, mode),
    }),
  );

  /* ---------------- 80-merge ---------------- */
  cmd({
    id: 'layer.mergeDown',
    label: 'Merge Down',
    menu: 'Layer',
    group: '80-merge',
    order: 10,
    shortcut: 'Ctrl+E',
    icon: Merge,
    keywords: ['merge layers', 'merge group', 'combine'],
    enabled: hasLayer,
    run: ops.mergeDown,
  });
  cmd({
    id: 'layer.mergeVisible',
    label: 'Merge Visible',
    menu: 'Layer',
    group: '80-merge',
    order: 20,
    shortcut: 'Shift+Ctrl+E',
    icon: Combine,
    keywords: ['merge all visible'],
    enabled: hasDoc,
    run: ops.mergeVisible,
  });
  cmd({
    id: 'layer.flatten',
    label: 'Flatten Image',
    menu: 'Layer',
    group: '80-merge',
    order: 30,
    icon: Layers2,
    keywords: ['flatten', 'merge all'],
    enabled: hasDoc,
    run: ops.flattenImage,
  });

  /* ---------------- 90-select ---------------- */
  cmd({
    id: 'layer.selectNext',
    label: 'Select Layer Above',
    menu: 'Layer',
    group: '90-select',
    order: 10,
    shortcut: 'Alt+]',
    keywords: ['next layer', 'forward layer'],
    enabled: hasDoc,
    run: () => ops.selectAdjacent(1),
  });
  cmd({
    id: 'layer.selectPrev',
    label: 'Select Layer Below',
    menu: 'Layer',
    group: '90-select',
    order: 20,
    shortcut: 'Alt+[',
    keywords: ['previous layer', 'backward layer'],
    enabled: hasDoc,
    run: () => ops.selectAdjacent(-1),
  });
}
