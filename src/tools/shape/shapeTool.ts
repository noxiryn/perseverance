/**
 * Shape tools (U): rectangle, ellipse, polygon, star, line, custom shape.
 * Drag to create a shape layer (Shift = constrain, Alt = from center) with a live preview;
 * a click without dragging creates a default-sized shape centered on the point.
 */
import type { ComponentType } from 'react';
import { Circle, Hexagon, Minus, Shapes, Square, Star } from 'lucide-react';
import type { ToolDef, ToolPointerEvent } from '../../registry';
import { shapePresets } from '../../registry';
import type { ShapeLayer, ShapeProps } from '../../core/types';
import { insertLayerDraft, makeShapeLayer, nextLayerName } from '../../core/document';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { clickBox, dragBox, lineGeometry, type Box } from './geometry';
import { KIND_LABEL, TOOL_KIND, fillFromOptions, readShapeOptions, shapeDefaults, strokeFromOptions, type ShapeToolId } from './options';
import { DEFAULT_SHAPE_PRESET } from './presets';
import { ShapeOptionsBar } from './ShapeOptionsBar';

interface DragState {
  toolId: ShapeToolId;
  docId: string;
  x0: number;
  y0: number;
  sx0: number;
  sy0: number;
  last: ToolPointerEvent;
  layerId: string | null;
  box: Box | null;
}

let drag: DragState | null = null;

function presetFor(toolId: ShapeToolId) {
  const o = readShapeOptions(toolId);
  return shapePresets.get(o.presetId) ?? shapePresets.get(DEFAULT_SHAPE_PRESET) ?? shapePresets.list()[0];
}

/** ShapeProps for a new shape of the tool's kind with the current options. */
export function newShapeProps(toolId: ShapeToolId, w: number, h: number): ShapeProps {
  const o = readShapeOptions(toolId);
  const { primaryColor, secondaryColor } = useEditor.getState();
  const kind = TOOL_KIND[toolId];
  const shape: ShapeProps = {
    kind,
    width: w,
    height: h,
    cornerRadius: kind === 'rect' || kind === 'polygon' || kind === 'star' ? Math.max(0, o.cornerRadius) : 0,
    sides: Math.max(kind === 'star' ? 2 : 3, Math.round(o.sides)),
    innerRatio: o.innerRatio,
    lineWidth: o.lineWidth,
    fill: fillFromOptions(o, primaryColor, secondaryColor),
    stroke: strokeFromOptions(o),
  };
  if (kind === 'path') {
    const p = presetFor(toolId);
    if (p) {
      shape.path = p.path;
      shape.viewBox = [...p.viewBox] as [number, number, number, number];
      shape.presetId = p.id;
    }
  }
  return shape;
}

function aspectFor(toolId: ShapeToolId): number {
  if (TOOL_KIND[toolId] !== 'path') return 1;
  const p = presetFor(toolId);
  return p ? p.viewBox[2] / p.viewBox[3] : 1;
}

function layerName(toolId: ShapeToolId): string {
  const s = activeSession();
  const base = TOOL_KIND[toolId] === 'path' ? (presetFor(toolId)?.name ?? 'Shape') : KIND_LABEL[TOOL_KIND[toolId]];
  return s ? nextLayerName(s.doc, base) : base;
}

/** Geometry (box + transform flip) for the current drag. */
function geometryFor(d: DragState, e: ToolPointerEvent): { box: Box; flipX: boolean } {
  const input = { x0: d.x0, y0: d.y0, x1: e.docX, y1: e.docY, shift: e.shiftKey, alt: e.altKey, aspect: aspectFor(d.toolId) };
  if (TOOL_KIND[d.toolId] === 'line') {
    const g = lineGeometry(input);
    return { box: g, flipX: g.flipX };
  }
  return { box: dragBox(input), flipX: false };
}

function applyGeometry(l: ShapeLayer, box: Box, flipX: boolean) {
  if (l.shape.kind === 'line') {
    // Exact extents: an axis-aligned line keeps a 0 side so it is drawn perfectly on-axis.
    l.shape.width = Math.max(0, box.w);
    l.shape.height = Math.max(0, box.h);
    if (l.shape.width === 0 && l.shape.height === 0) l.shape.width = 1;
  } else {
    l.shape.width = Math.max(1, box.w);
    l.shape.height = Math.max(1, box.h);
  }
  l.transform.x = box.x;
  l.transform.y = box.y;
  l.transform.scaleX = flipX ? -1 : 1;
  l.transform.scaleY = 1;
  l.transform.rotation = 0;
}

function updateDrag(e: ToolPointerEvent) {
  const d = drag;
  if (!d) return;
  d.last = e;
  const moved = Math.hypot(e.screenX - d.sx0, e.screenY - d.sy0);
  if (!d.layerId && moved < 3) return;
  const { box, flipX } = geometryFor(d, e);
  d.box = box;
  const st = useEditor.getState();
  if (!d.layerId) {
    const layer = makeShapeLayer({ name: layerName(d.toolId), shape: newShapeProps(d.toolId, Math.max(1, box.w), Math.max(1, box.h)) });
    applyGeometry(layer, box, flipX);
    d.layerId = layer.id;
    const above = activeSession()?.activeLayerId ?? null;
    st.preview((doc) => insertLayerDraft(doc, layer, { aboveId: above }));
  } else {
    const id = d.layerId;
    st.preview((doc) => {
      const l = doc.layers[id];
      if (l && l.type === 'shape') applyGeometry(l, box, flipX);
    });
  }
  viewport.requestRender();
  viewport.requestOverlay();
}

function finishDrag(e: ToolPointerEvent | null) {
  const d = drag;
  drag = null;
  if (!d) return;
  const st = useEditor.getState();
  if (st.activeDocId !== d.docId) {
    if (d.layerId) st.cancelPreview();
    return;
  }
  const label = `${TOOL_KIND[d.toolId] === 'path' ? 'Custom Shape' : KIND_LABEL[TOOL_KIND[d.toolId]]} Tool`;
  if (d.layerId) {
    st.commit(label, undefined, { activeLayerId: d.layerId });
  } else if (e) {
    // Click without drag → default-sized shape centered on the click.
    const s = activeSession();
    if (!s) return;
    const size = Math.max(16, Math.round(Math.min(s.doc.width, s.doc.height) * 0.2));
    const kind = TOOL_KIND[d.toolId];
    let box: Box;
    if (kind === 'line') box = { x: d.x0 - size / 2, y: d.y0, w: size, h: 0 };
    else box = clickBox(d.x0, d.y0, size, aspectFor(d.toolId));
    const layer = makeShapeLayer({ name: layerName(d.toolId), shape: newShapeProps(d.toolId, box.w, box.h) });
    applyGeometry(layer, box, false);
    const above = s.activeLayerId;
    st.commit(label, (doc) => insertLayerDraft(doc, layer, { aboveId: above }), { activeLayerId: layer.id });
  }
  viewport.requestRender();
  viewport.requestOverlay();
}

function cancelDrag() {
  if (!drag) return;
  if (drag.layerId) useEditor.getState().cancelPreview();
  drag = null;
  viewport.requestRender();
  viewport.requestOverlay();
}

function drawOverlay(ctx: CanvasRenderingContext2D) {
  const d = drag;
  if (!d || !d.box || !d.layerId) return;
  const b = d.box;
  const a = viewport.docToScreen({ x: b.x, y: b.y });
  const c = viewport.docToScreen({ x: b.x + b.w, y: b.y + b.h });
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
  ctx.lineDashOffset = 3.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
  ctx.setLineDash([]);
  // Size readout next to the cursor.
  const label =
    TOOL_KIND[d.toolId] === 'line'
      ? `${Math.round(Math.hypot(d.last.docX - d.x0, d.last.docY - d.y0))} px`
      : `W ${Math.round(b.w)}  H ${Math.round(b.h)}`;
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  const tw = ctx.measureText(label).width;
  const lx = d.last.screenX + 14;
  const ly = d.last.screenY + 14;
  ctx.fillStyle = 'rgba(20,20,20,0.92)';
  ctx.beginPath();
  ctx.roundRect(lx, ly, tw + 12, 20, 4);
  ctx.fill();
  ctx.fillStyle = '#f2f2f2';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, lx + 6, ly + 10);
  ctx.restore();
}

const CROSSHAIR = 'crosshair';

function makeShapeTool(id: ShapeToolId, name: string, icon: ComponentType<{ size?: number; strokeWidth?: number }>): ToolDef {
  return {
    id,
    name,
    shortcut: 'U',
    icon,
    group: 'shape',
    order: 140,
    cursor: CROSSHAIR,
    OptionsBar: ShapeOptionsBar,
    defaultOptions: shapeDefaults(id),
    onPointerDown(e) {
      if (e.button !== 0) return;
      const s = activeSession();
      if (!s) {
        toast('Open or create a document to draw shapes', 'info');
        return;
      }
      if (drag) cancelDrag();
      drag = { toolId: id, docId: s.doc.id, x0: e.docX, y0: e.docY, sx0: e.screenX, sy0: e.screenY, last: e, layerId: null, box: null };
    },
    onPointerMove(e) {
      if (drag && drag.toolId === id) updateDrag(e);
    },
    onPointerUp(e) {
      if (!drag || drag.toolId !== id) return;
      if (drag.layerId) updateDrag(e);
      finishDrag(e);
    },
    onKeyDown(e) {
      if (!drag) return false;
      if (e.key === 'Escape') {
        cancelDrag();
        return true;
      }
      if ((e.key === 'Shift' || e.key === 'Alt') && drag.layerId) {
        updateDrag({ ...drag.last, shiftKey: e.key === 'Shift' ? true : drag.last.shiftKey, altKey: e.key === 'Alt' ? true : drag.last.altKey });
        return true;
      }
      return false;
    },
    onKeyUp(e) {
      if (!drag || !drag.layerId) return false;
      if (e.key === 'Shift' || e.key === 'Alt') {
        updateDrag({ ...drag.last, shiftKey: e.key === 'Shift' ? false : drag.last.shiftKey, altKey: e.key === 'Alt' ? false : drag.last.altKey });
        return true;
      }
      return false;
    },
    onDeactivate() {
      if (drag) finishDrag(null);
    },
    renderOverlay: drawOverlay,
  };
}

export const shapeTools: ToolDef[] = [
  makeShapeTool('shape-rect', 'Rectangle', Square),
  makeShapeTool('shape-ellipse', 'Ellipse', Circle),
  makeShapeTool('shape-polygon', 'Polygon', Hexagon),
  makeShapeTool('shape-star', 'Star', Star),
  makeShapeTool('shape-line', 'Line', Minus),
  makeShapeTool('shape-custom', 'Custom Shape', Shapes),
];

/** Is a shape drag in progress (for tests/debugging). */
export function isShapeDragging() {
  return !!drag;
}
