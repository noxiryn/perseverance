/**
 * File / Edit / Image menu commands (ids, groups and shortcuts per ARCHITECTURE.md §5.3).
 */
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Crop,
  Download,
  Expand,
  FileDown,
  FileImage,
  FilePlus,
  Files,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  ImageDown,
  ImagePlus,
  LogOut,
  PaintBucket,
  PenLine,
  Proportions,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  SaveAll,
  Scaling,
  Scissors,
  Shrink,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { commands, type CommandDef } from '../registry';
import { openFiles, type FileFilter } from '../platform';
import { activeSession, useEditor } from '../state/editor';
import { openDialog, toast } from '../state/ui';
import { IMAGE_EXTS, openFile, placeImageBlob } from './open';
import { saveDocument } from './save';
import { quickExportPng } from './exportRender';
import { copy, cut, clear, paste } from './clipboard';
import { canRedo, canUndo, redo, redoLabel, turnLayers, undo, undoLabel } from './editOps';
import { showFillDialog, showStrokeDialog } from './fillStroke';
import { canvasSize, cropToSelection, duplicateImage, resizeImage, revealAll, rotateCanvas, trimDocument } from './imageOps';
import { closeActive, closeAll, exitApp } from './closeOps';
import { showNewDocumentDialog } from './newDocument';
import { hasDoc, requireSession } from './util';

export const OPEN_FILTERS: FileFilter[] = [
  { name: 'All supported files', extensions: ['pgfx', 'psd', ...IMAGE_EXTS] },
  { name: 'Perseverance Project', extensions: ['pgfx'] },
  { name: 'Images', extensions: IMAGE_EXTS },
  { name: 'Photoshop', extensions: ['psd'] },
];

const PLACE_FILTERS: FileFilter[] = [{ name: 'Images', extensions: IMAGE_EXTS }];

async function openCommand() {
  const files = await openFiles({ title: 'Open', filters: OPEN_FILTERS, multiple: true });
  for (const f of files) {
    try {
      await openFile(f, { asNewDocument: true });
    } catch (e) {
      toast(`Could not open ${f.name}: ${(e as Error).message ?? e}`, 'error', 5000);
    }
  }
}

async function placeCommand() {
  const files = await openFiles({ title: 'Place Image', filters: PLACE_FILTERS, multiple: true });
  for (const f of files) await placeImageBlob(new Blob([f.data]), f.name);
}

/** ag-psd is large: load the PSD module only when it is used. */
async function exportPsdCommand() {
  if (!requireSession('export a PSD')) return;
  const { showExportPsdDialog } = await import('./psd');
  await showExportPsdDialog();
}

async function exportCommand() {
  const s = requireSession('export');
  if (!s) return;
  const { ExportDialog } = await import('./dialogs/ExportDialog');
  await openDialog(ExportDialog, { doc: s.doc });
}

async function imageSizeCommand() {
  const s = requireSession('change the image size');
  if (!s) return;
  const { ImageSizeDialog } = await import('./dialogs/ImageSizeDialog');
  const r = await openDialog(ImageSizeDialog, { doc: s.doc });
  if (r) resizeImage(r.width, r.height, { method: r.method, scaleStyles: r.scaleStyles });
}

async function canvasSizeCommand() {
  const s = requireSession('change the canvas size');
  if (!s) return;
  const { CanvasSizeDialog } = await import('./dialogs/CanvasSizeDialog');
  const r = await openDialog(CanvasSizeDialog, { doc: s.doc });
  if (r) canvasSize(r.width, r.height, r.anchor, r.extension);
}

async function trimCommand() {
  const s = requireSession('trim');
  if (!s) return;
  const { TrimDialog } = await import('./dialogs/TrimDialog');
  const r = await openDialog(TrimDialog, {});
  if (r) trimDocument(r.basis, r.sides);
}

const hasSelection = () => !!activeSession()?.doc.selection;

function cmd(def: CommandDef): CommandDef {
  return def;
}

export const ioCommands: CommandDef[] = [
  /* ---------------- File ---------------- */
  cmd({
    id: 'file.new',
    label: 'New…',
    menu: 'File',
    group: '10-new',
    order: 10,
    shortcut: 'Ctrl+N',
    icon: FilePlus,
    keywords: ['document', 'create', 'blank', 'canvas'],
    run: () => showNewDocumentDialog(),
  }),
  cmd({
    id: 'file.open',
    label: 'Open…',
    menu: 'File',
    group: '10-new',
    order: 30,
    shortcut: 'Ctrl+O',
    icon: FolderOpen,
    keywords: ['load', 'pgfx', 'psd', 'image', 'png', 'jpg'],
    run: openCommand,
  }),
  cmd({
    id: 'file.save',
    label: 'Save',
    menu: 'File',
    group: '20-save',
    order: 10,
    shortcut: 'Ctrl+S',
    icon: Save,
    keywords: ['project', 'pgfx'],
    enabled: hasDoc,
    run: async () => void (await saveDocument()),
  }),
  cmd({
    id: 'file.saveAs',
    label: 'Save As…',
    menu: 'File',
    group: '20-save',
    order: 20,
    shortcut: 'Shift+Ctrl+S',
    icon: SaveAll,
    keywords: ['project', 'pgfx', 'copy'],
    enabled: hasDoc,
    run: async () => void (await saveDocument(undefined, { saveAs: true })),
  }),
  cmd({
    id: 'file.place',
    label: 'Place Image…',
    menu: 'File',
    group: '30-place',
    order: 10,
    shortcut: 'Shift+Ctrl+P',
    icon: ImagePlus,
    keywords: ['import', 'embed', 'picture', 'photo', 'insert'],
    run: placeCommand,
  }),
  cmd({
    id: 'file.export',
    label: 'Export As…',
    menu: 'File',
    group: '40-export',
    order: 10,
    shortcut: 'Alt+Shift+Ctrl+W',
    icon: Download,
    keywords: ['png', 'jpg', 'jpeg', 'webp', 'save image', 'thumbnail', 'icon'],
    enabled: hasDoc,
    run: exportCommand,
  }),
  cmd({
    id: 'file.quickExportPng',
    label: 'Quick Export as PNG',
    menu: 'File',
    group: '40-export',
    order: 20,
    shortcut: 'Alt+Shift+Ctrl+S',
    icon: ImageDown,
    keywords: ['png', 'save image'],
    enabled: hasDoc,
    run: quickExportPng,
  }),
  cmd({
    id: 'file.exportPsd',
    label: 'Export as PSD…',
    menu: 'File',
    group: '40-export',
    order: 30,
    icon: FileDown,
    keywords: ['photoshop', 'psd', 'layers'],
    enabled: hasDoc,
    run: exportPsdCommand,
  }),
  cmd({
    id: 'file.close',
    label: 'Close',
    menu: 'File',
    group: '90-close',
    order: 10,
    shortcut: 'Ctrl+W',
    icon: X,
    keywords: ['document', 'tab'],
    enabled: hasDoc,
    run: closeActive,
  }),
  cmd({
    id: 'file.closeAll',
    label: 'Close All',
    menu: 'File',
    group: '90-close',
    order: 20,
    shortcut: 'Alt+Ctrl+W',
    icon: Files,
    keywords: ['documents', 'tabs'],
    enabled: hasDoc,
    run: async () => void (await closeAll()),
  }),
  cmd({
    id: 'file.exit',
    label: 'Exit',
    menu: 'File',
    group: '90-close',
    order: 90,
    shortcut: 'Ctrl+Q',
    icon: LogOut,
    keywords: ['quit', 'close app'],
    run: exitApp,
  }),

  /* ---------------- Edit ---------------- */
  {
    id: 'edit.undo',
    get label() {
      return undoLabel();
    },
    menu: 'Edit',
    group: '10-history',
    order: 10,
    shortcut: 'Ctrl+Z',
    icon: Undo2,
    keywords: ['undo', 'back'],
    enabled: canUndo,
    run: undo,
  },
  {
    id: 'edit.redo',
    get label() {
      return redoLabel();
    },
    menu: 'Edit',
    group: '10-history',
    order: 20,
    shortcut: 'Shift+Ctrl+Z',
    icon: Redo2,
    keywords: ['redo', 'forward'],
    enabled: canRedo,
    run: redo,
  },
  cmd({ id: 'edit.redoAlt', label: 'Redo (Ctrl+Y)', shortcut: 'Ctrl+Y', icon: Redo2, keywords: ['redo'], enabled: canRedo, run: redo }),
  cmd({
    id: 'edit.stepBackward',
    label: 'Step Backward',
    menu: 'Edit',
    group: '10-history',
    order: 30,
    shortcut: 'Alt+Ctrl+Z',
    icon: Undo2,
    keywords: ['undo', 'history'],
    enabled: canUndo,
    run: undo,
  }),

  cmd({
    id: 'edit.cut',
    label: 'Cut',
    menu: 'Edit',
    group: '20-clipboard',
    order: 10,
    shortcut: 'Ctrl+X',
    icon: Scissors,
    keywords: ['clipboard'],
    enabled: hasDoc,
    run: cut,
  }),
  cmd({
    id: 'edit.copy',
    label: 'Copy',
    menu: 'Edit',
    group: '20-clipboard',
    order: 20,
    shortcut: 'Ctrl+C',
    icon: Copy,
    keywords: ['clipboard'],
    enabled: hasDoc,
    run: () => void copy(false),
  }),
  cmd({
    id: 'edit.copyMerged',
    label: 'Copy Merged',
    menu: 'Edit',
    group: '20-clipboard',
    order: 30,
    shortcut: 'Shift+Ctrl+C',
    icon: CopyPlus,
    keywords: ['clipboard', 'flatten', 'composite'],
    enabled: hasDoc,
    run: () => void copy(true),
  }),
  cmd({
    id: 'edit.paste',
    label: 'Paste',
    menu: 'Edit',
    group: '20-clipboard',
    order: 40,
    shortcut: 'Ctrl+V',
    icon: ClipboardPaste,
    keywords: ['clipboard', 'image'],
    run: () => paste(false),
  }),
  cmd({
    id: 'edit.pasteInPlace',
    label: 'Paste in Place',
    menu: 'Edit',
    group: '20-clipboard',
    order: 50,
    shortcut: 'Shift+Ctrl+V',
    icon: ClipboardPaste,
    keywords: ['clipboard', 'same position'],
    run: () => paste(true),
  }),
  cmd({
    id: 'edit.clear',
    label: 'Clear',
    menu: 'Edit',
    group: '20-clipboard',
    order: 60,
    // Backspace is the delete key on Mac keyboards.
    shortcut: 'Delete / Backspace',
    icon: Trash2,
    keywords: ['delete', 'erase selection', 'remove'],
    enabled: hasDoc,
    run: clear,
  }),

  cmd({
    id: 'edit.fill',
    label: 'Fill…',
    menu: 'Edit',
    group: '30-fill',
    order: 10,
    shortcut: 'Shift+F5',
    icon: PaintBucket,
    keywords: ['color', 'pattern', 'bucket'],
    enabled: hasDoc,
    run: showFillDialog,
  }),
  cmd({
    id: 'edit.stroke',
    label: 'Stroke…',
    menu: 'Edit',
    group: '30-fill',
    order: 20,
    icon: PenLine,
    keywords: ['outline', 'border', 'selection'],
    enabled: hasSelection,
    run: showStrokeDialog,
  }),

  cmd({
    id: 'edit.rotate180',
    label: 'Rotate 180°',
    menu: 'Edit/Transform',
    group: '50-rotate',
    order: 10,
    icon: RotateCw,
    keywords: ['turn layer'],
    enabled: hasDoc,
    run: () => turnLayers('rotate180'),
  }),
  cmd({
    id: 'edit.rotate90cw',
    label: 'Rotate 90° Clockwise',
    menu: 'Edit/Transform',
    group: '50-rotate',
    order: 20,
    icon: RotateCw,
    keywords: ['turn layer', 'cw'],
    enabled: hasDoc,
    run: () => turnLayers('rotate90cw'),
  }),
  cmd({
    id: 'edit.rotate90ccw',
    label: 'Rotate 90° Counter Clockwise',
    menu: 'Edit/Transform',
    group: '50-rotate',
    order: 30,
    icon: RotateCcw,
    keywords: ['turn layer', 'ccw'],
    enabled: hasDoc,
    run: () => turnLayers('rotate90ccw'),
  }),
  cmd({
    id: 'edit.flipH',
    label: 'Flip Horizontal',
    menu: 'Edit/Transform',
    group: '60-flip',
    order: 10,
    icon: FlipHorizontal2,
    keywords: ['mirror layer'],
    enabled: hasDoc,
    run: () => turnLayers('flipH'),
  }),
  cmd({
    id: 'edit.flipV',
    label: 'Flip Vertical',
    menu: 'Edit/Transform',
    group: '60-flip',
    order: 20,
    icon: FlipVertical2,
    keywords: ['mirror layer', 'upside down'],
    enabled: hasDoc,
    run: () => turnLayers('flipV'),
  }),

  /* ---------------- Image ---------------- */
  cmd({
    id: 'image.imageSize',
    label: 'Image Size…',
    menu: 'Image',
    group: '30-size',
    order: 10,
    shortcut: 'Alt+Ctrl+I',
    icon: Scaling,
    keywords: ['resize', 'resample', 'scale', 'dimensions'],
    enabled: hasDoc,
    run: imageSizeCommand,
  }),
  cmd({
    id: 'image.canvasSize',
    label: 'Canvas Size…',
    menu: 'Image',
    group: '30-size',
    order: 20,
    shortcut: 'Alt+Ctrl+C',
    icon: Proportions,
    keywords: ['resize canvas', 'extend', 'expand', 'border'],
    enabled: hasDoc,
    run: canvasSizeCommand,
  }),
  cmd({
    id: 'image.rotate180',
    label: '180°',
    menu: 'Image/Image Rotation',
    group: '40-rotate',
    order: 10,
    icon: RotateCw,
    keywords: ['rotate canvas'],
    enabled: hasDoc,
    run: () => rotateCanvas('rotate180'),
  }),
  cmd({
    id: 'image.rotate90cw',
    label: '90° Clockwise',
    menu: 'Image/Image Rotation',
    group: '40-rotate',
    order: 20,
    icon: RotateCw,
    keywords: ['rotate canvas', 'portrait', 'landscape'],
    enabled: hasDoc,
    run: () => rotateCanvas('rotate90cw'),
  }),
  cmd({
    id: 'image.rotate90ccw',
    label: '90° Counter Clockwise',
    menu: 'Image/Image Rotation',
    group: '40-rotate',
    order: 30,
    icon: RotateCcw,
    keywords: ['rotate canvas', 'portrait', 'landscape'],
    enabled: hasDoc,
    run: () => rotateCanvas('rotate90ccw'),
  }),
  cmd({
    id: 'image.flipCanvasH',
    label: 'Flip Canvas Horizontal',
    menu: 'Image/Image Rotation',
    group: '41-flip',
    order: 10,
    icon: FlipHorizontal2,
    keywords: ['mirror canvas'],
    enabled: hasDoc,
    run: () => rotateCanvas('flipH'),
  }),
  cmd({
    id: 'image.flipCanvasV',
    label: 'Flip Canvas Vertical',
    menu: 'Image/Image Rotation',
    group: '41-flip',
    order: 20,
    icon: FlipVertical2,
    keywords: ['mirror canvas'],
    enabled: hasDoc,
    run: () => rotateCanvas('flipV'),
  }),
  cmd({
    id: 'image.cropToSelection',
    label: 'Crop',
    menu: 'Image',
    group: '50-crop',
    order: 10,
    icon: Crop,
    keywords: ['crop to selection'],
    enabled: hasSelection,
    run: cropToSelection,
  }),
  cmd({
    id: 'image.trim',
    label: 'Trim…',
    menu: 'Image',
    group: '50-crop',
    order: 20,
    icon: Shrink,
    keywords: ['transparent', 'remove borders', 'autocrop'],
    enabled: hasDoc,
    run: trimCommand,
  }),
  cmd({
    id: 'image.revealAll',
    label: 'Reveal All',
    menu: 'Image',
    group: '50-crop',
    order: 30,
    icon: Expand,
    keywords: ['expand canvas', 'show hidden'],
    enabled: hasDoc,
    run: revealAll,
  }),
  cmd({
    id: 'image.duplicate',
    label: 'Duplicate…',
    menu: 'Image',
    group: '60-duplicate',
    order: 10,
    icon: FileImage,
    keywords: ['copy document', 'clone'],
    enabled: hasDoc,
    run: () => duplicateImage(),
  }),
];

export function registerIoCommands() {
  commands.registerMany(ioCommands);
}

/** For dev/tests: whether a document is open. */
export function documentCount() {
  return useEditor.getState().docOrder.length;
}
