/**
 * Type module: Type tool (T), Character panel, Type menu and the text Properties section.
 * Imported by src/features.ts.
 */
import { CaseSensitive } from 'lucide-react';
import { commands, panels, propertiesSections, tools } from '../../registry';
import type { Document, Point, TextLayer } from '../../core/types';
import { DEFAULT_TEXT, flattenIds, isEffectivelyVisible } from '../../core/document';
import { activeDoc, activeSession, useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { hitTestLayer } from '../../render/compositor';
import * as viewportModule from '../../viewport';
import { applyTextChange, primaryTextTarget } from './apply';
import { CharacterPanel } from './CharacterPanel';
import { typeCommands } from './commands';
import { frameContains, textFrame } from './frame';
import { CHARACTER_PANEL_ID } from './panelState';
import { editTextLayer } from './session';
import { TextProperties } from './TextProperties';
import { typeTool } from './typeTool';
import { openWarpDialog } from './WarpDialog';

tools.register(typeTool);
commands.registerMany(typeCommands);

function resetCharacter() {
  applyTextChange(
    {
      text: {
        lineHeight: DEFAULT_TEXT.lineHeight,
        letterSpacing: 0,
        scaleX: 1,
        scaleY: 1,
        fauxBold: false,
        fauxItalic: false,
        uppercase: false,
        antiAlias: true,
      },
    },
    'commit',
    'Reset Character',
    { lineHeight: DEFAULT_TEXT.lineHeight, letterSpacing: 0, scaleX: 1, scaleY: 1, fauxBold: false, fauxItalic: false, uppercase: false, antiAlias: true },
  );
}

panels.register({
  id: CHARACTER_PANEL_ID,
  title: 'Character',
  icon: CaseSensitive,
  component: CharacterPanel,
  defaultSlot: 'strip',
  order: 30,
  menu: () => {
    const l = primaryTextTarget();
    return [
      { label: 'Edit Text on Canvas', run: () => l && editTextLayer(l.id, { selectAll: true }), disabled: !l || l.locks.all },
      { label: 'Warp Text…', run: openWarpDialog, disabled: !l },
      { label: 'Reset Character', run: resetCharacter },
    ];
  },
});

propertiesSections.register({
  id: 'text-props',
  order: 20,
  title: 'Character',
  appliesTo: (layerId) => activeDoc()?.layers[layerId]?.type === 'text',
  component: TextProperties,
});

/* ------------------------------------------------------------------ */
/* Double-click a text layer with the Move tool → edit it               */
/* ------------------------------------------------------------------ */

function containsPoint(l: TextLayer, p: Point): boolean {
  const frame = textFrame(l);
  const k = Math.max(1e-6, Math.hypot(frame.M[0], frame.M[1]));
  return frameContains(frame, l.text, p, 4 / (viewport.zoom() * k));
}

/**
 * Text layer a move-tool double-click should edit: the hit layer when it is text, else the active
 * text layer under the pointer, else the topmost text layer whose box contains the point and that
 * is not covered by the hit layer (clicks between glyphs fall through to layers below).
 */
function textLayerForDoubleClick(doc: Document, p: Point, activeId: string | null): string | null {
  const hit = hitTestLayer(doc, p.x, p.y);
  if (hit && doc.layers[hit]?.type === 'text') return hit;
  const a = activeId ? doc.layers[activeId] : null;
  if (a && a.type === 'text' && isEffectivelyVisible(doc, a.id) && containsPoint(a, p)) return a.id;
  const ids = flattenIds(doc);
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i] === hit) break;
    const l = doc.layers[ids[i]];
    if (!l || l.type !== 'text' || l.locks.all || !isEffectivelyVisible(doc, l.id)) continue;
    if (containsPoint(l, p)) return l.id;
  }
  return null;
}

/**
 * Is the move tool's free transform running? `activeTransform` is not a documented cross-module
 * contract, so it is looked up defensively: if the viewport module renames or drops it, the
 * double-click simply edits text (instead of breaking the build or throwing).
 */
function freeTransformActive(): boolean {
  const fn = (viewportModule as unknown as Record<string, unknown>).activeTransform;
  if (typeof fn !== 'function') return false;
  try {
    return !!(fn as () => unknown)();
  } catch {
    return false;
  }
}

function onMoveDoubleClick(e: MouseEvent) {
  const st = useEditor.getState();
  if (st.activeTool !== 'move') return;
  const host = viewport.element();
  if (!host || !(e.target instanceof Node) || !host.contains(e.target)) return;
  if (freeTransformActive()) return; // the move tool commits its free transform on double-click
  const s = activeSession();
  if (!s || !s.view.zoom) return;
  const r = host.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  if (useUI.getState().view.rulers && (sx < 18 || sy < 18)) return;
  const p = viewport.screenToDoc({ x: sx, y: sy });
  const id = textLayerForDoubleClick(s.doc, p, s.activeLayerId);
  if (!id) return;
  const layer = s.doc.layers[id];
  if (!layer || layer.locks.all) return;
  e.stopPropagation();
  e.preventDefault();
  editTextLayer(id, { at: p });
}

type DblWindow = Window & { __perseveranceTypeDblClick?: (e: MouseEvent) => void };
const w = window as DblWindow;
if (w.__perseveranceTypeDblClick) window.removeEventListener('dblclick', w.__perseveranceTypeDblClick, true);
w.__perseveranceTypeDblClick = onMoveDoubleClick;
window.addEventListener('dblclick', onMoveDoubleClick, true);

export { editTextLayer, beginEditLayer, beginNewText, commitEditing, cancelEditing, isEditing, editingLayerId, useTypeEditing } from './session';
export { TEXT_STYLES, getTextStyle } from './styles';
export { openWarpDialog } from './WarpDialog';
export { rasterizeTextLayer, textToShape } from './convert';
