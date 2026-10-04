/** Type menu commands (ids per ARCHITECTURE.md §5.3). */
import { Bold, CaseUpper, Italic, PanelRight, Pencil, Shapes, Spline, TextCursorInput, Image as ImageIcon, AArrowUp, AArrowDown, Pilcrow } from 'lucide-react';
import type { CommandDef } from '../../registry';
import { insertLayerDraft, makeTextLayer } from '../../core/document';
import { activeDoc, activeSession, useEditor } from '../../state/editor';
import { toast, useUI } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { primaryTextTarget } from './apply';
import { currentTextView, setParagraphMode, stepFontSize, toggleText, type TextToggle } from './actions';
import { convertSelectedTextToShape, rasterizeSelectedText } from './convert';
import { LOREM, loremWords } from './lorem';
import { readTypeOptions, textPropsFromOptions } from './options';
import { CHARACTER_PANEL_ID, isCharacterPanelOpen } from './panelState';
import { editTextLayer, insertAtCaret, isEditing } from './session';
import { openWarpDialog } from './WarpDialog';

const hasDoc = () => !!activeDoc();

function needTextLayer(what: string): boolean {
  if (!activeDoc()) {
    toast('Open a document first', 'info');
    return false;
  }
  if (!isEditing() && !primaryTextTarget()) {
    toast(`Select a text layer to ${what}`, 'info');
    return false;
  }
  return true;
}

function toggleCommand(id: string, key: TextToggle, label: string, order: number, icon: CommandDef['icon']): CommandDef {
  return {
    id,
    label,
    menu: 'Type',
    group: '20-style',
    order,
    icon,
    keywords: ['text', 'type', 'character'],
    enabled: hasDoc,
    checked: () => !!primaryTextTarget() && !!currentTextView()[key],
    run: () => {
      if (!needTextLayer(`turn ${label} on or off`)) return;
      toggleText(key);
    },
  };
}

/** Type ▸ Paste Lorem Ipsum: inserts at the caret while editing, else adds a placeholder paragraph. */
function pasteLorem() {
  if (isEditing()) {
    const l = primaryTextTarget();
    insertAtCaret(l?.text.boxWidth ? LOREM : loremWords(10));
    return;
  }
  const s = activeSession();
  if (!s) return void toast('Open a document first', 'info');
  const st = useEditor.getState();
  const o = readTypeOptions();
  const text = textPropsFromOptions(o, st.primaryColor, st.secondaryColor, LOREM);
  text.fontSize = Math.max(14, Math.min(64, Math.round(s.doc.height / 28)));
  text.lineHeight = Math.max(text.lineHeight, 1.25);
  text.warp = { style: 'none', bend: 0, horizontal: 0, vertical: 0 };
  text.boxWidth = Math.round(s.doc.width * 0.6);
  const layer = makeTextLayer({ name: 'Lorem ipsum', text, x: Math.round(s.doc.width * 0.2), y: Math.round(s.doc.height * 0.3) });
  const above = s.activeLayerId;
  st.commit('Paste Lorem Ipsum', (d) => insertLayerDraft(d, layer, { aboveId: above && d.layers[above] ? above : null }), { activeLayerId: layer.id });
  viewport.requestRender();
}

export const typeCommands: CommandDef[] = [
  {
    id: 'type.characterPanel',
    label: 'Character Panel',
    menu: 'Type',
    group: '10-panels',
    order: 10,
    icon: PanelRight,
    keywords: ['font', 'text', 'typography', 'panel'],
    checked: () => isCharacterPanelOpen(useUI.getState()),
    run: () => useUI.getState().togglePanel(CHARACTER_PANEL_ID),
  },
  {
    id: 'type.editText',
    label: 'Edit Text',
    menu: 'Type',
    group: '10-panels',
    order: 20,
    icon: Pencil,
    keywords: ['text', 'type', 'caret', 'retype'],
    enabled: hasDoc,
    run: () => {
      if (!needTextLayer('edit its text')) return;
      const l = primaryTextTarget();
      if (l) editTextLayer(l.id, { selectAll: true });
    },
  },
  toggleCommand('type.fauxBold', 'fauxBold', 'Faux Bold', 10, Bold),
  toggleCommand('type.fauxItalic', 'fauxItalic', 'Faux Italic', 20, Italic),
  toggleCommand('type.uppercase', 'uppercase', 'All Caps', 30, CaseUpper),
  {
    id: 'type.sizeUp',
    label: 'Increase Font Size',
    menu: 'Type',
    group: '20-style',
    order: 40,
    shortcut: 'Shift+Ctrl+.',
    icon: AArrowUp,
    keywords: ['bigger', 'larger', 'font size'],
    run: () => stepFontSize(1),
  },
  {
    id: 'type.sizeDown',
    label: 'Decrease Font Size',
    menu: 'Type',
    group: '20-style',
    order: 50,
    shortcut: 'Shift+Ctrl+,',
    icon: AArrowDown,
    keywords: ['smaller', 'font size'],
    run: () => stepFontSize(-1),
  },
  {
    id: 'type.warp',
    label: 'Warp Text…',
    menu: 'Type',
    group: '30-warp',
    order: 10,
    icon: Spline,
    keywords: ['arc', 'arch', 'bulge', 'flag', 'wave', 'curve text', 'bend'],
    enabled: hasDoc,
    run: () => openWarpDialog(),
  },
  {
    id: 'type.rasterize',
    label: 'Rasterize Type Layer',
    menu: 'Type',
    group: '40-convert',
    order: 10,
    icon: ImageIcon,
    keywords: ['pixels', 'flatten text'],
    enabled: hasDoc,
    run: () => rasterizeSelectedText(),
  },
  {
    id: 'type.convertToShape',
    label: 'Convert to Shape',
    menu: 'Type',
    group: '40-convert',
    order: 20,
    icon: Shapes,
    keywords: ['outline', 'vector', 'path', 'create outlines'],
    enabled: hasDoc,
    run: () => convertSelectedTextToShape(),
  },
  {
    id: 'type.toggleParagraph',
    label: 'Convert Point ↔ Paragraph Text',
    menu: 'Type',
    group: '40-convert',
    order: 30,
    icon: Pilcrow,
    keywords: ['wrap', 'box', 'point text', 'paragraph text'],
    enabled: hasDoc,
    run: () => {
      if (!needTextLayer('convert it')) return;
      const l = primaryTextTarget();
      if (l) setParagraphMode(!l.text.boxWidth);
    },
  },
  {
    id: 'type.loremIpsum',
    label: 'Paste Lorem Ipsum',
    menu: 'Type',
    group: '50-insert',
    order: 10,
    icon: TextCursorInput,
    keywords: ['placeholder', 'dummy text'],
    enabled: hasDoc,
    run: () => pasteLorem(),
  },
];
