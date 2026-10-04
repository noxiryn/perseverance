/**
 * Select, View and Edit ▸ (Free) Transform commands (ids/groups/shortcuts per ARCHITECTURE §5.3).
 */
import {
  Eye,
  Fullscreen,
  Grid3x3,
  Hash,
  Magnet,
  Maximize,
  Ruler,
  Scaling,
  ScanLine,
  SquareDashed,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { CommandDef } from '../registry';
import { uid } from '../core/ids';
import { deselect, invertSelection, selectAll } from '../editor/selection';
import { activeDoc, activeSession, useEditor } from '../state/editor';
import { openDialog, toast, useUI, type ViewToggles } from '../state/ui';
import { AmountDialog, NewGuideDialog, type AmountDialogProps, type NewGuideResult } from './dialogs';
import { openColorRange } from './colorRange';
import { loadLayerSelection, modifySelection, reselect, selectAllLayers, type ModifyKind } from './selectOps';
import { lastSelectionFor } from './lifecycle';
import { actualPixels, fitOnScreen, zoomStep } from './tools/navigate';
import { activeTransform, startFreeTransform, startSelectionTransform, transformAgain } from './transform/controller';
import { requireDoc } from './state';

const hasDoc = () => !!activeSession();
const hasSelection = () => !!activeDoc()?.selection;

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

const MODIFY: Record<ModifyKind, { label: string; title: string; field: string; initial: number; min: number; max: number; note?: string }> = {
  feather: { label: 'Feather…', title: 'Feather Selection', field: 'Feather Radius', initial: 8, min: 0.2, max: 1000, note: 'Softens the selection edge so effects and fills fade out smoothly.' },
  expand: { label: 'Expand…', title: 'Expand Selection', field: 'Expand By', initial: 4, min: 1, max: 500 },
  contract: { label: 'Contract…', title: 'Contract Selection', field: 'Contract By', initial: 4, min: 1, max: 500 },
  border: { label: 'Border…', title: 'Border Selection', field: 'Width', initial: 8, min: 1, max: 200, note: 'Selects a band along the selection edge — handy for outlines and rim lights.' },
  smooth: { label: 'Smooth…', title: 'Smooth Selection', field: 'Sample Radius', initial: 4, min: 1, max: 100, note: 'Rounds off jagged corners and removes stray specks.' },
};

const lastAmount: Partial<Record<ModifyKind, number>> = {};

async function runModify(kind: ModifyKind) {
  const doc = requireDoc(MODIFY[kind].title);
  if (!doc) return;
  if (!doc.selection) {
    toast(`${MODIFY[kind].title} needs an active selection.`, 'info');
    return;
  }
  const m = MODIFY[kind];
  const props: AmountDialogProps = {
    title: m.title,
    label: m.field,
    initial: lastAmount[kind] ?? m.initial,
    min: m.min,
    max: m.max,
    step: kind === 'feather' ? 0.1 : 1,
    unit: 'px',
    note: m.note,
  };
  const v = await openDialog<number, AmountDialogProps>(AmountDialog, props);
  if (v === undefined) return;
  lastAmount[kind] = v;
  modifySelection(kind, v);
}

const selectCommands: CommandDef[] = [
  {
    id: 'select.all',
    label: 'All',
    menu: 'Select',
    group: '10-basic',
    order: 10,
    shortcut: 'Ctrl+A',
    icon: SquareDashed,
    keywords: ['select all', 'everything'],
    enabled: hasDoc,
    run: () => {
      if (requireDoc('Select All')) selectAll();
    },
  },
  {
    id: 'select.deselect',
    label: 'Deselect',
    menu: 'Select',
    group: '10-basic',
    order: 20,
    shortcut: 'Ctrl+D',
    keywords: ['clear selection', 'none'],
    enabled: hasSelection,
    run: () => deselect(),
  },
  {
    id: 'select.reselect',
    label: 'Reselect',
    menu: 'Select',
    group: '10-basic',
    order: 30,
    shortcut: 'Shift+Ctrl+D',
    keywords: ['restore selection'],
    enabled: () => {
      const s = activeSession();
      return !!s && !!lastSelectionFor(s.doc.id);
    },
    run: () => reselect(),
  },
  {
    id: 'select.inverse',
    label: 'Inverse',
    menu: 'Select',
    group: '10-basic',
    order: 40,
    shortcut: 'Shift+Ctrl+I',
    keywords: ['invert selection'],
    enabled: hasSelection,
    run: () => {
      if (!activeDoc()?.selection) {
        toast('Make a selection first, then invert it.', 'info');
        return;
      }
      invertSelection();
    },
  },
  {
    id: 'select.allLayers',
    label: 'All Layers',
    menu: 'Select',
    group: '20-layers',
    order: 10,
    shortcut: 'Alt+Ctrl+A',
    keywords: ['select layers'],
    enabled: hasDoc,
    run: () => selectAllLayers(),
  },
  {
    id: 'select.loadLayer',
    label: 'Load Selection from Layer',
    menu: 'Select',
    group: '20-layers',
    order: 20,
    keywords: ['layer transparency', 'select pixels', 'alpha'],
    enabled: () => !!activeSession()?.activeLayerId,
    run: () => loadLayerSelection('new'),
  },
  {
    id: 'select.colorRange',
    label: 'Color Range…',
    menu: 'Select',
    group: '30-color',
    order: 10,
    keywords: ['select color', 'fuzziness', 'select by color'],
    enabled: hasDoc,
    run: () => {
      if (requireDoc('Color Range')) void openColorRange();
    },
  },
  ...(Object.keys(MODIFY) as ModifyKind[]).map(
    (kind, i): CommandDef => ({
      id: `select.${kind}`,
      label: MODIFY[kind].label,
      menu: 'Select/Modify',
      group: '40-modify',
      order: i * 10,
      shortcut: kind === 'feather' ? 'Shift+F6' : undefined,
      keywords: ['modify selection', kind],
      enabled: hasSelection,
      run: () => runModify(kind),
    }),
  ),
  {
    id: 'select.transform',
    label: 'Transform Selection',
    menu: 'Select',
    group: '50-transform',
    order: 10,
    icon: Scaling,
    keywords: ['scale selection', 'rotate selection'],
    enabled: hasSelection,
    run: () => startSelectionTransform(),
  },
];

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

function toggle(key: keyof ViewToggles, label: string, id: string, order: number, group: string, shortcut?: string, icon?: CommandDef['icon']): CommandDef {
  return {
    id,
    label,
    menu: 'View',
    group,
    order,
    shortcut,
    icon,
    keywords: ['show', 'hide', label.toLowerCase()],
    checked: () => useUI.getState().view[key],
    run: () => {
      useUI.getState().toggleView(key);
    },
  };
}

async function newGuide() {
  const doc = requireDoc('New Guide');
  if (!doc) return;
  const r = await openDialog<NewGuideResult>(NewGuideDialog);
  if (!r || !Number.isFinite(r.position)) return;
  if (!useUI.getState().view.guides) useUI.getState().toggleView('guides', true);
  useEditor.getState().commit('New Guide', (d) => {
    d.guides.push({ id: uid('g_'), orientation: r.orientation, position: Math.round(r.position * 100) / 100 });
  });
}

function clearGuides() {
  const doc = requireDoc('Clear Guides');
  if (!doc) return;
  if (!doc.guides.length) {
    toast('There are no guides to clear.', 'info');
    return;
  }
  useEditor.getState().commit('Clear Guides', (d) => {
    d.guides = [];
  });
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast('Full screen is not available here.', 'warning');
  }
}

const viewCommands: CommandDef[] = [
  {
    id: 'view.zoomIn',
    label: 'Zoom In',
    menu: 'View',
    group: '10-zoom',
    order: 10,
    shortcut: 'Ctrl+= / Shift+Ctrl+= / Ctrl++',
    icon: ZoomIn,
    keywords: ['magnify', 'bigger'],
    enabled: hasDoc,
    run: () => zoomStep(1),
  },
  {
    id: 'view.zoomOut',
    label: 'Zoom Out',
    menu: 'View',
    group: '10-zoom',
    order: 20,
    shortcut: 'Ctrl+-',
    icon: ZoomOut,
    keywords: ['smaller'],
    enabled: hasDoc,
    run: () => zoomStep(-1),
  },
  {
    id: 'view.fit',
    label: 'Fit on Screen',
    menu: 'View',
    group: '10-zoom',
    order: 30,
    shortcut: 'Ctrl+0',
    icon: Maximize,
    keywords: ['fit', 'zoom to fit', 'whole image'],
    enabled: hasDoc,
    run: () => fitOnScreen(),
  },
  {
    id: 'view.actual',
    label: '100%',
    menu: 'View',
    group: '10-zoom',
    order: 40,
    shortcut: 'Ctrl+1',
    keywords: ['actual pixels', '100%', 'real size'],
    enabled: hasDoc,
    run: () => actualPixels(),
  },
  toggle('rulers', 'Rulers', 'view.rulers', 10, '20-show', 'Ctrl+R', Ruler),
  toggle('guides', 'Guides', 'view.guides', 20, '20-show', 'Ctrl+;', ScanLine),
  toggle('grid', 'Grid', 'view.grid', 30, '20-show', "Ctrl+'", Grid3x3),
  toggle('pixelGrid', 'Pixel Grid', 'view.pixelGrid', 40, '20-show', undefined, Hash),
  toggle('extras', 'Extras', 'view.extras', 50, '20-show', 'Ctrl+H', Eye),
  toggle('snap', 'Snap', 'view.snap', 10, '30-snap', 'Shift+Ctrl+;', Magnet),
  {
    id: 'view.newGuide',
    label: 'New Guide…',
    menu: 'View',
    group: '40-guides',
    order: 10,
    keywords: ['add guide'],
    enabled: hasDoc,
    run: () => newGuide(),
  },
  {
    id: 'view.clearGuides',
    label: 'Clear Guides',
    menu: 'View',
    group: '40-guides',
    order: 20,
    keywords: ['remove guides', 'delete guides'],
    enabled: () => !!activeDoc()?.guides.length,
    run: () => clearGuides(),
  },
  {
    id: 'view.fullscreen',
    label: 'Full Screen',
    menu: 'View',
    group: '50-screen',
    order: 10,
    shortcut: 'F11',
    icon: Fullscreen,
    keywords: ['fullscreen', 'presentation'],
    checked: () => !!document.fullscreenElement,
    run: () => toggleFullscreen(),
  },
];

/* ------------------------------------------------------------------ */
/* Edit ▸ Free Transform / Transform                                   */
/* ------------------------------------------------------------------ */

const canTransform = () => {
  const s = activeSession();
  return !!s && (!!s.activeLayerId || s.selectedLayerIds.length > 0);
};

const editCommands: CommandDef[] = [
  {
    id: 'edit.freeTransform',
    label: 'Free Transform',
    menu: 'Edit',
    group: '40-transform',
    order: 10,
    shortcut: 'Ctrl+T',
    icon: Scaling,
    keywords: ['scale', 'rotate', 'resize layer', 'transform'],
    enabled: canTransform,
    run: () => startFreeTransform(),
  },
  {
    id: 'edit.transformAgain',
    label: 'Again',
    menu: 'Edit/Transform',
    group: '40-transform',
    order: 10,
    shortcut: 'Shift+Ctrl+T',
    keywords: ['repeat transform'],
    enabled: canTransform,
    run: () => transformAgain(),
  },
  {
    id: 'edit.transformScale',
    label: 'Scale',
    menu: 'Edit/Transform',
    group: '40-transform',
    order: 20,
    keywords: ['resize'],
    enabled: canTransform,
    run: () => startFreeTransform(),
  },
  {
    id: 'edit.transformRotate',
    label: 'Rotate',
    menu: 'Edit/Transform',
    group: '40-transform',
    order: 30,
    enabled: canTransform,
    run: () => {
      startFreeTransform();
      if (activeTransform()) toast('Drag outside the box to rotate (Shift snaps to 15°).', 'info');
    },
  },
  {
    id: 'edit.transformSkew',
    label: 'Skew',
    menu: 'Edit/Transform',
    group: '40-transform',
    order: 40,
    keywords: ['shear', 'slant'],
    enabled: canTransform,
    run: () => startFreeTransform({ skew: true }),
  },
];

export const viewportCommands: CommandDef[] = [...selectCommands, ...viewCommands, ...editCommands];
