/** Menu item builders shared by the Layers / Effects panels (context menus, footer menus). */
import {
  Contrast,
  CopyPlus,
  CornerLeftDown,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  Grid2x2,
  Image as ImageIcon,
  Lock,
  Merge,
  PaintBucket,
  Palette,
  Pencil,
  SlidersHorizontal,
  SquareDashed,
  SquareDashedMousePointer,
  Trash2,
  Unlock,
} from 'lucide-react';
import type { ID, LabelColor, Layer } from '../core/types';
import type { MenuItem } from '../ui/controls';
import { activeSession, useEditor } from '../state/editor';
import { layerBelow } from './treeOps';
import { useUI } from '../state/ui';
import { adjustmentFilters } from '../filters/engine';
import * as ops from './layerOps';
import { STYLE_PRESETS, effectMenuIds, effectName } from './effectPresets';
import { openFillLayerDialog } from './dialogs';

export const LABEL_COLORS: { value: LabelColor; label: string; css: string }[] = [
  { value: 'none', label: 'No Color', css: 'transparent' },
  { value: 'red', label: 'Red', css: '#d9534f' },
  { value: 'orange', label: 'Orange', css: '#e8893a' },
  { value: 'yellow', label: 'Yellow', css: '#d8c13a' },
  { value: 'green', label: 'Green', css: '#4fae5c' },
  { value: 'blue', label: 'Blue', css: '#4a86d8' },
  { value: 'violet', label: 'Violet', css: '#8b7cf6' },
  { value: 'gray', label: 'Gray', css: '#8a8a8a' },
];

export function labelCss(l: LabelColor): string | undefined {
  return l === 'none' ? undefined : LABEL_COLORS.find((c) => c.value === l)?.css;
}

/** "Add effect" items (effects registry) for the active layer. */
export function effectMenuItems(): MenuItem[] {
  const ids = effectMenuIds();
  const items: MenuItem[] = ids.map((id) => ({ label: `${effectName(id)}…`, run: () => void ops.addEffect(id) }));
  items.push(
    { separator: true },
    { label: 'Style Presets', submenu: STYLE_PRESETS.map((p) => ({ label: p.name, run: () => ops.applyStylePreset(p) })) },
    { separator: true },
    { label: 'Copy Layer Style', run: ops.copyStyle },
    { label: 'Paste Layer Style', run: ops.pasteStyle, disabled: !ops.useLayersUI.getState().styleClipboard },
    { label: 'Clear Layer Style', run: ops.clearStyle },
  );
  return items;
}

/** Fill + adjustment layer items (panel footer half-circle button). */
export function adjustmentMenuItems(): MenuItem[] {
  const adj = adjustmentFilters();
  const items: MenuItem[] = [
    { label: 'Solid Color…', icon: PaintBucket, run: () => void openFillLayerDialog('solid') },
    { label: 'Gradient…', icon: Palette, run: () => void openFillLayerDialog('gradient') },
    { label: 'Pattern…', icon: Grid2x2, run: () => void openFillLayerDialog('pattern') },
    { separator: true },
  ];
  if (!adj.length) items.push({ label: 'No adjustments available', disabled: true });
  for (const f of adj) items.push({ label: `${f.name}…`, icon: f.icon ?? SlidersHorizontal, run: () => void ops.newAdjustmentLayer(f.id) });
  return items;
}

/** Context menu for a layer row (acts on the current selection). */
export function layerContextMenu(layer: Layer, startRename: (id: ID) => void): MenuItem[] {
  const s = activeSession();
  if (!s) return [];
  const sel = ops.selectedTopLevel(s);
  const multi = sel.length > 1;
  const isGroup = layer.type === 'group';
  const canRasterize = layer.type === 'text' || layer.type === 'shape' || layer.type === 'fill' || (layer.type === 'raster' && !!layer.generator);
  const hasBelow = !!layerBelow(s.doc, layer.id);
  const mergeLabel = multi ? 'Merge Layers' : isGroup ? 'Merge Group' : 'Merge Down';
  const maskItems: MenuItem[] = layer.mask
    ? [
        { label: 'Edit Layer Mask', icon: SquareDashed, run: () => ops.editMaskOf(layer.id) },
        { label: layer.mask.enabled ? 'Disable Layer Mask' : 'Enable Layer Mask', run: () => ops.toggleMaskEnabled(layer.id) },
        { label: 'Apply Layer Mask', run: ops.applyMask, disabled: isGroup || layer.type === 'adjustment' },
        { label: 'Delete Layer Mask', run: ops.deleteMask },
      ]
    : [
        { label: 'Add Layer Mask', icon: SquareDashed, run: () => void ops.addMask('reveal') },
        { label: 'Add Layer Mask (Hide All)', run: () => void ops.addMask('hide') },
        ...(s.doc.selection ? [{ label: 'Layer Mask from Selection', run: ops.maskFromSelection }] : []),
      ];
  return [
    { label: multi ? `${sel.length} layers selected` : layer.name, heading: true },
    { label: 'Rename Layer…', icon: Pencil, run: () => startRename(layer.id), disabled: multi },
    { label: multi ? 'Duplicate Layers' : 'Duplicate Layer', icon: CopyPlus, shortcut: 'Ctrl+J', run: () => void ops.duplicateLayers() },
    { label: multi ? 'Delete Layers' : 'Delete Layer', icon: Trash2, run: () => void ops.deleteLayers() },
    { separator: true },
    { label: 'Group Layers', icon: FolderPlus, shortcut: 'Ctrl+G', run: () => void ops.groupSelected() },
    ...(isGroup ? [{ label: 'Ungroup Layers', icon: FolderOpen, shortcut: 'Shift+Ctrl+G', run: ops.ungroupSelected }] : []),
    { separator: true },
    ...maskItems,
    layer.clipped
      ? { label: 'Release Clipping Mask', icon: CornerLeftDown, run: () => ops.setClipped(false) }
      : { label: 'Create Clipping Mask', icon: CornerLeftDown, shortcut: 'Alt+Ctrl+G', run: () => ops.setClipped(true), disabled: !hasBelow },
    { separator: true },
    { label: 'Rasterize Layer', icon: ImageIcon, run: ops.rasterizeSelected, disabled: !canRasterize },
    {
      label: 'Rasterize Layer Style',
      run: ops.rasterizeStyleSelected,
      disabled: isGroup || layer.type === 'adjustment' || (!layer.effects.length && !layer.filters.length),
    },
    { label: 'Add Layer Style', submenu: effectMenuItems(), disabled: layer.type === 'adjustment' },
    { separator: true },
    { label: mergeLabel, icon: Merge, shortcut: 'Ctrl+E', run: ops.mergeDown },
    { label: 'Merge Visible', shortcut: 'Shift+Ctrl+E', run: ops.mergeVisible },
    { label: 'Flatten Image', run: ops.flattenImage },
    { separator: true },
    { label: layer.visible ? 'Hide Layer' : 'Show Layer', icon: layer.visible ? EyeOff : Eye, shortcut: 'Ctrl+,', run: ops.toggleHideSelected },
    { label: layer.locks.all ? 'Unlock Layer' : 'Lock Layer', icon: layer.locks.all ? Unlock : Lock, shortcut: 'Ctrl+/', run: ops.toggleLockSelected },
    {
      label: 'Label Color',
      submenu: LABEL_COLORS.map((c) => ({
        label: c.label,
        checked: layer.label === c.value,
        run: () => ops.setLabelColor(ops.selectedIds(), c.value),
      })),
    },
    { separator: true },
    {
      label: 'Select Pixels',
      icon: SquareDashedMousePointer,
      run: () => ops.loadSelectionFromLayer(layer.id),
      disabled: layer.type === 'adjustment' || isGroup,
    },
    { label: 'Properties', icon: SlidersHorizontal, run: () => useUI.getState().showPanel('properties') },
    { label: 'Layer Style…', icon: Contrast, run: () => useUI.getState().showPanel('effects'), disabled: layer.type === 'adjustment' },
  ];
}

/** Context menu for a smart filter row. */
export function filterContextMenu(layerId: ID, filterInstId: ID): MenuItem[] {
  const l = activeSession()?.doc.layers[layerId];
  const i = l?.filters.findIndex((f) => f.id === filterInstId) ?? -1;
  if (!l || i < 0) return [];
  const f = l.filters[i];
  return [
    { label: 'Edit Smart Filter…', icon: SlidersHorizontal, run: () => showProps(layerId) },
    { label: f.enabled ? 'Disable Smart Filter' : 'Enable Smart Filter', run: () => ops.toggleFilter(layerId, filterInstId) },
    { label: 'Move Up', run: () => ops.moveFilter(layerId, i, i + 1), disabled: i >= l.filters.length - 1 },
    { label: 'Move Down', run: () => ops.moveFilter(layerId, i, i - 1), disabled: i <= 0 },
    { separator: true },
    { label: 'Delete Smart Filter', icon: Trash2, run: () => ops.removeFilter(layerId, filterInstId) },
  ];
}

/** Context menu for an effect row. */
export function effectContextMenu(layerId: ID, effectInstId: ID): MenuItem[] {
  const l = activeSession()?.doc.layers[layerId];
  const e = l?.effects.find((x) => x.id === effectInstId);
  if (!l || !e) return [];
  return [
    {
      label: `Edit ${effectName(e.effectId)}…`,
      icon: SlidersHorizontal,
      run: () => {
        ops.useLayersUI.getState().setExpandedEffect(effectInstId);
        showFx(layerId);
      },
    },
    { label: e.enabled ? 'Hide Effect' : 'Show Effect', run: () => ops.toggleEffect(layerId, effectInstId) },
    { label: 'Duplicate Effect', icon: CopyPlus, run: () => ops.duplicateEffect(layerId, effectInstId) },
    { separator: true },
    { label: 'Delete Effect', icon: Trash2, run: () => ops.removeEffect(layerId, effectInstId) },
  ];
}

function selectIfNeeded(layerId: ID) {
  const s = activeSession();
  if (s && s.activeLayerId !== layerId) useEditor.getState().setActiveLayer(layerId);
}

export function showProps(layerId: ID) {
  selectIfNeeded(layerId);
  useUI.getState().showPanel('properties');
}

export function showFx(layerId: ID) {
  selectIfNeeded(layerId);
  useUI.getState().showPanel('effects');
}
