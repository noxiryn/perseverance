/**
 * Type tool (T): click = point text, drag = paragraph box, click on a text layer = edit it with the
 * caret at the click. While editing, pointer gestures select text / resize the paragraph box and a
 * click outside commits.
 */
import { Type } from 'lucide-react';
import type { ToolDef, ToolPointerEvent } from '../../registry';
import { activeSession, activeLayer, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { isMac } from '../../platform';
import { textLayerAt } from './apply';
import { TYPE_DEFAULTS, TYPE_TOOL_ID } from './options';
import {
  beginEditLayer,
  beginNewText,
  cancelEditing,
  commitEditing,
  drawSessionOverlay,
  editingLayerId,
  focusTextarea,
  insertAtCaret,
  isEditing,
  sessionCursor,
  sessionDoubleClick,
  sessionPointerDown,
  sessionPointerMove,
  sessionPointerUp,
} from './session';
import { TypeOptionsBar } from './TypeOptionsBar';

interface CreateGesture {
  docId: string;
  start: { x: number; y: number };
  startScreen: { x: number; y: number };
  cur: { x: number; y: number };
  curScreen: { x: number; y: number };
  moved: boolean;
}

let gesture: CreateGesture | null = null;
let editPointer = false;

const DRAG_PX = 4;

function boxOf(g: CreateGesture) {
  const x = Math.min(g.start.x, g.cur.x);
  const y = Math.min(g.start.y, g.cur.y);
  return { x, y, width: Math.abs(g.cur.x - g.start.x), height: Math.abs(g.cur.y - g.start.y) };
}

function onPointerDown(e: ToolPointerEvent) {
  if (e.button !== 0) return;
  const s = activeSession();
  if (!s) {
    toast('Open or create a document to add text', 'info');
    return;
  }
  if (isEditing()) {
    if (sessionPointerDown(e)) {
      editPointer = true;
      return;
    }
    // Click outside the edited text commits it (like Photoshop); a click on another text layer
    // then continues editing that layer.
    const editing = editingLayerId();
    commitEditing();
    const after = activeSession();
    const other = after ? textLayerAt(after.doc, { x: e.docX, y: e.docY }, 4, null) : null;
    if (after && other && other !== editing && !after.doc.layers[other]?.locks.all) {
      if (beginEditLayer(other, { at: { x: e.docX, y: e.docY }, pointerId: e.native?.pointerId })) editPointer = true;
    }
    return;
  }
  const hit = textLayerAt(s.doc, { x: e.docX, y: e.docY }, 4, s.activeLayerId);
  if (hit) {
    const l = s.doc.layers[hit];
    if (l?.locks.all) {
      toast(`“${l.name}” is locked — unlock it to edit its text`, 'warning');
      return;
    }
    if (beginEditLayer(hit, { at: { x: e.docX, y: e.docY }, pointerId: e.native?.pointerId })) editPointer = true;
    return;
  }
  gesture = {
    docId: s.doc.id,
    start: { x: e.docX, y: e.docY },
    startScreen: { x: e.screenX, y: e.screenY },
    cur: { x: e.docX, y: e.docY },
    curScreen: { x: e.screenX, y: e.screenY },
    moved: false,
  };
}

function onPointerMove(e: ToolPointerEvent) {
  if (editPointer) {
    sessionPointerMove(e);
    return;
  }
  const g = gesture;
  if (!g) return;
  g.cur = { x: e.docX, y: e.docY };
  g.curScreen = { x: e.screenX, y: e.screenY };
  if (!g.moved && Math.hypot(e.screenX - g.startScreen.x, e.screenY - g.startScreen.y) > DRAG_PX) g.moved = true;
  viewport.requestOverlay();
}

function onPointerUp(e: ToolPointerEvent) {
  if (editPointer) {
    editPointer = false;
    sessionPointerUp();
    return;
  }
  const g = gesture;
  gesture = null;
  if (!g) return;
  viewport.requestOverlay();
  if (useEditor.getState().activeDocId !== g.docId) return;
  g.cur = { x: e.docX, y: e.docY };
  const box = boxOf(g);
  if (g.moved && box.width * viewport.zoom() >= 12) beginNewText(g.start, box);
  else beginNewText(g.start, null);
}

function onHover(e: ToolPointerEvent) {
  if (isEditing()) {
    viewport.setCursor(sessionCursor(e));
    return;
  }
  viewport.setCursor(null);
}

function onDoubleClick(e: ToolPointerEvent) {
  if (isEditing()) sessionDoubleClick(e);
}

/** Keys while the hidden textarea does NOT have focus (it handles its own keys otherwise). */
function onKeyDown(e: KeyboardEvent): boolean {
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  if (isEditing()) {
    if (e.key === 'Escape') {
      cancelEditing();
      return true;
    }
    if (e.key === 'Enter' && (ctrl || e.code === 'NumpadEnter')) {
      commitEditing();
      return true;
    }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') {
      // Undo while editing discards the edit instead of undoing the previous step.
      cancelEditing();
      return true;
    }
    if (!ctrl && !e.altKey && !e.metaKey) {
      if (e.key.length === 1 || e.key === 'Enter') {
        insertAtCaret(e.key === 'Enter' ? '\n' : e.key);
        return true;
      }
      if (e.key === 'Backspace' || e.key === 'Delete' || e.key.startsWith('Arrow')) {
        focusTextarea();
        try {
          if (e.key === 'Backspace') document.execCommand('delete');
          else if (e.key === 'Delete') document.execCommand('forwardDelete');
        } catch {
          /* ignore */
        }
        return true;
      }
    }
    return false;
  }
  if (e.key === 'Enter' && !ctrl && !e.altKey && !e.shiftKey) {
    const l = activeLayer();
    if (l && l.type === 'text') {
      beginEditLayer(l.id, { selectAll: true });
      return true;
    }
  }
  if (e.key === 'Escape' && gesture) {
    gesture = null;
    viewport.requestOverlay();
    return true;
  }
  return false;
}

function onActivate() {
  if (isEditing()) {
    focusTextarea();
    viewport.requestOverlay();
  }
}

function onDeactivate() {
  gesture = null;
  editPointer = false;
  // A temporary tool (Space = hand) keeps the edit alive; a real tool switch commits it.
  if (useEditor.getState().previousTool === TYPE_TOOL_ID) return;
  if (isEditing()) commitEditing();
}

function renderOverlay(ctx: CanvasRenderingContext2D) {
  if (isEditing()) {
    drawSessionOverlay(ctx);
    return;
  }
  const g = gesture;
  if (!g || !g.moved) return;
  const b = boxOf(g);
  const a = viewport.docToScreen({ x: b.x, y: b.y });
  const c = viewport.docToScreen({ x: b.x + b.width, y: b.y + b.height });
  const x = Math.round(a.x) + 0.5;
  const y = Math.round(a.y) + 0.5;
  const w = Math.round(c.x - a.x);
  const h = Math.round(c.y - a.y);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeRect(x, y, w, h);
  ctx.lineDashOffset = 3.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  const label = `W ${Math.round(b.width)}  H ${Math.round(b.height)}`;
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  const tw = ctx.measureText(label).width;
  const lx = g.curScreen.x + 14;
  const ly = g.curScreen.y + 14;
  ctx.fillStyle = 'rgba(20,20,20,0.92)';
  ctx.beginPath();
  ctx.roundRect(lx, ly, tw + 12, 20, 4);
  ctx.fill();
  ctx.fillStyle = '#f2f2f2';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, lx + 6, ly + 10);
  ctx.restore();
}

export const typeTool: ToolDef = {
  id: TYPE_TOOL_ID,
  name: 'Type Tool',
  shortcut: 'T',
  icon: Type,
  group: 'type',
  order: 130,
  cursor: 'text',
  OptionsBar: TypeOptionsBar,
  defaultOptions: { ...TYPE_DEFAULTS },
  onActivate,
  onDeactivate,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onHover,
  onDoubleClick,
  onKeyDown,
  renderOverlay,
};
