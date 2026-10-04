/**
 * Lasso (freehand) and Polygonal Lasso (L). Polygon: click points; double-click, Enter or
 * clicking the start point closes; Backspace removes the last point; Esc cancels; Shift snaps
 * segments to 45°. Same selection modes + feather as the marquee.
 */
import { Lasso, LassoSelect } from 'lucide-react';
import type { Point } from '../../core/types';
import type { ToolDef, ToolPointerEvent } from '../../registry';
import { deselect, polygonMask, type SelectionMode } from '../../editor/selection';
import { viewport } from '../../editor/viewport';
import { activeSession, toolOptions, useToolOptions } from '../../state/editor';
import { Checkbox, NumberField } from '../../ui/controls';
import { strokeAnts } from '../outline';
import { CURSORS } from '../draw';
import {
  beginOutlineDrag,
  commitOutlineDrag,
  commitSelectionMask,
  drawOutlineDrag,
  hardenMask,
  modeFromEvent,
  pointInSelection,
  updateOutlineDrag,
  endOutlineDragVisual,
  handleSelectionNudgeKey,
  type OutlineDrag,
} from './selectCommon';
import { SelectionModeButtons, Sep, setToolOptionSafe } from '../options/common';
import { isTemporarilySuspended } from '../state';

export const LASSO_DEFAULTS = { mode: 'new' as SelectionMode, feather: 0, antiAlias: true };

function commitPolygon(pts: Point[], mode: SelectionMode, toolId: string, label: string) {
  const s = activeSession();
  if (!s) return;
  if (pts.length < 3) {
    if (mode === 'new') deselect();
    return;
  }
  const o = toolOptions(toolId, LASSO_DEFAULTS);
  let mask = polygonMask(s.doc, pts);
  if (!o.antiAlias) mask = hardenMask(mask);
  commitSelectionMask(s.doc, mask, mode, label, { feather: o.feather });
}

function polyPath(pts: Point[], close: boolean, extra?: Point): Path2D {
  const p = new Path2D();
  pts.forEach((pt, i) => {
    const sp = viewport.docToScreen(pt);
    if (i) p.lineTo(sp.x, sp.y);
    else p.moveTo(sp.x, sp.y);
  });
  if (extra) {
    const sp = viewport.docToScreen(extra);
    p.lineTo(sp.x, sp.y);
  }
  if (close) p.closePath();
  return p;
}

/* ---------------- freehand lasso ---------------- */

function makeLasso(): ToolDef {
  const id = 'lasso';
  let pts: Point[] | null = null;
  let mode: SelectionMode = 'new';
  let outline: OutlineDrag | null = null;
  let screen0: Point = { x: 0, y: 0 };
  let moved = false;

  return {
    id,
    name: 'Lasso Tool',
    shortcut: 'L',
    icon: Lasso,
    group: 'lasso',
    order: 30,
    cursor: CURSORS.lasso,
    OptionsBar: () => <LassoOptions id={id} />,
    defaultOptions: { ...LASSO_DEFAULTS },
    onPointerDown(e) {
      const s = activeSession();
      if (!s || e.button !== 0) return;
      const o = toolOptions(id, LASSO_DEFAULTS);
      mode = modeFromEvent(e, o.mode);
      if (mode === 'new' && o.mode === 'new' && pointInSelection(s.doc, e.docX, e.docY)) {
        outline = beginOutlineDrag(e);
        return;
      }
      pts = [{ x: e.docX, y: e.docY }];
      screen0 = { x: e.screenX, y: e.screenY };
      moved = false;
    },
    onPointerMove(e) {
      if (outline) {
        updateOutlineDrag(outline, e);
        return;
      }
      if (!pts) return;
      if (!moved && Math.hypot(e.screenX - screen0.x, e.screenY - screen0.y) < 3) return;
      moved = true;
      const last = pts[pts.length - 1];
      const minStep = 0.75 / viewport.zoom();
      const evs = e.native.getCoalescedEvents?.() ?? [];
      if (evs.length > 1) {
        const el = viewport.element();
        const r = el?.getBoundingClientRect();
        for (const ev of evs) {
          const p = r ? viewport.screenToDoc({ x: ev.clientX - r.left, y: ev.clientY - r.top }) : { x: e.docX, y: e.docY };
          const l = pts[pts.length - 1];
          if (Math.hypot(p.x - l.x, p.y - l.y) >= minStep) pts.push(p);
        }
      } else if (Math.hypot(e.docX - last.x, e.docY - last.y) >= minStep) pts.push({ x: e.docX, y: e.docY });
      viewport.requestOverlay();
    },
    onPointerUp() {
      if (outline) {
        const o = outline;
        outline = null;
        if (!commitOutlineDrag(o)) deselect();
        viewport.requestOverlay();
        return;
      }
      const p = pts;
      pts = null;
      viewport.requestOverlay();
      if (!p) return;
      if (!moved) {
        if (mode === 'new') deselect();
        return;
      }
      commitPolygon(p, mode, id, 'Lasso');
    },
    onHover(e) {
      const s = activeSession();
      const o = toolOptions(id, LASSO_DEFAULTS);
      const inside = s && modeFromEvent(e, o.mode) === 'new' && o.mode === 'new' && pointInSelection(s.doc, e.docX, e.docY);
      viewport.setCursor(inside ? 'move' : null);
    },
    onKeyDown(e) {
      if (e.key === 'Escape' && pts) {
        pts = null;
        viewport.requestOverlay();
        return true;
      }
      if (!pts && !outline) return handleSelectionNudgeKey(e);
      return false;
    },
    onDeactivate() {
      if (isTemporarilySuspended(id)) return; // Space-pan keeps the stroke going
      pts = null;
      outline = null;
      endOutlineDragVisual();
    },
    renderOverlay(ctx) {
      if (outline) {
        drawOutlineDrag(ctx, outline);
        return;
      }
      if (!pts || pts.length < 2) return;
      strokeAnts(ctx, polyPath(pts, false));
    },
  };
}

/* ---------------- polygonal lasso ---------------- */

function makePolyLasso(): ToolDef {
  const id = 'polygon-lasso';
  let pts: Point[] = [];
  let mode: SelectionMode = 'new';
  let hover: Point | null = null;
  let hoverScreen: Point | null = null;
  let outline: OutlineDrag | null = null;
  let lastClick = 0;
  let lastClickAt: Point = { x: -1e9, y: -1e9 };

  const constrain = (p: Point, shift: boolean): Point => {
    if (!shift || !pts.length) return p;
    const a = pts[pts.length - 1];
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const len = Math.hypot(dx, dy);
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  };

  const nearStart = (screen: Point) => {
    if (pts.length < 3) return false;
    const s = viewport.docToScreen(pts[0]);
    return Math.hypot(s.x - screen.x, s.y - screen.y) <= 8;
  };

  const close = () => {
    const p = pts;
    pts = [];
    hover = null;
    viewport.requestOverlay();
    commitPolygon(p, mode, id, 'Polygonal Lasso');
  };

  const cancel = () => {
    pts = [];
    hover = null;
    viewport.requestOverlay();
  };

  return {
    id,
    name: 'Polygonal Lasso Tool',
    shortcut: 'L',
    icon: LassoSelect,
    group: 'lasso',
    order: 30,
    cursor: CURSORS.polyLasso,
    OptionsBar: () => <LassoOptions id={id} />,
    defaultOptions: { ...LASSO_DEFAULTS },
    onPointerDown(e) {
      const s = activeSession();
      if (!s || e.button !== 0) return;
      const screen = { x: e.screenX, y: e.screenY };
      const now = performance.now();
      // The second click of a double-click (same spot, quick) must not add a duplicate vertex;
      // quick clicks at different spots are separate vertices.
      const isDouble = now - lastClick < 400 && Math.hypot(screen.x - lastClickAt.x, screen.y - lastClickAt.y) < 6;
      lastClick = now;
      lastClickAt = screen;
      if (!pts.length) {
        const o = toolOptions(id, LASSO_DEFAULTS);
        mode = modeFromEvent(e, o.mode);
        if (mode === 'new' && o.mode === 'new' && pointInSelection(s.doc, e.docX, e.docY)) {
          outline = beginOutlineDrag(e);
          return;
        }
        pts = [{ x: e.docX, y: e.docY }];
        hover = pts[0];
        viewport.requestOverlay();
        return;
      }
      if (nearStart(screen)) {
        close();
        return;
      }
      if (isDouble) return; // the dblclick handler closes
      pts.push(constrain({ x: e.docX, y: e.docY }, e.shiftKey));
      viewport.requestOverlay();
    },
    onPointerMove(e) {
      if (outline) updateOutlineDrag(outline, e);
    },
    onPointerUp() {
      if (outline) {
        const o = outline;
        outline = null;
        if (!commitOutlineDrag(o)) deselect();
        viewport.requestOverlay();
      }
    },
    onHover(e) {
      hoverScreen = { x: e.screenX, y: e.screenY };
      if (pts.length) {
        hover = constrain({ x: e.docX, y: e.docY }, e.shiftKey);
        viewport.setCursor(nearStart(hoverScreen) ? CURSORS.crosshairPlus('') : null);
        viewport.requestOverlay();
      } else {
        const s = activeSession();
        const o = toolOptions(id, LASSO_DEFAULTS);
        const inside = s && modeFromEvent(e, o.mode) === 'new' && o.mode === 'new' && pointInSelection(s.doc, e.docX, e.docY);
        viewport.setCursor(inside ? 'move' : null);
      }
    },
    onDoubleClick() {
      if (pts.length >= 3) close();
      else if (pts.length) cancel();
    },
    onKeyDown(e) {
      if (!pts.length) return outline ? false : handleSelectionNudgeKey(e);
      if (e.key === 'Enter') {
        close();
        return true;
      }
      if (e.key === 'Escape') {
        cancel();
        return true;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        pts.pop();
        if (!pts.length) hover = null;
        viewport.requestOverlay();
        return true;
      }
      return false;
    },
    onDeactivate() {
      if (isTemporarilySuspended(id)) return; // Space-pan keeps the points placed so far
      cancel();
      outline = null;
      endOutlineDragVisual();
    },
    renderOverlay(ctx) {
      if (outline) {
        drawOutlineDrag(ctx, outline);
        return;
      }
      if (!pts.length) return;
      strokeAnts(ctx, polyPath(pts, false, hover ?? undefined));
      // vertices
      ctx.save();
      for (let i = 0; i < pts.length; i++) {
        const sp = viewport.docToScreen(pts[i]);
        ctx.fillStyle = i === 0 ? '#8b7cf6' : '#ffffff';
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, i === 0 ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (hoverScreen && nearStart(hoverScreen)) {
        const sp = viewport.docToScreen(pts[0]);
        ctx.strokeStyle = '#8b7cf6';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

function LassoOptions({ id }: { id: string }) {
  const o = useToolOptions(id, LASSO_DEFAULTS);
  return (
    <div className="viewport-opts">
      <SelectionModeButtons toolId={id} value={o.mode} />
      <Sep />
      <NumberField scrubLabel="Feather" value={o.feather} min={0} max={250} step={1} unit="px" width={56} onChange={(v) => setToolOptionSafe(id, 'feather', v)} />
      <Checkbox checked={o.antiAlias} onChange={(v) => setToolOptionSafe(id, 'antiAlias', v)} label="Anti-alias" />
      {id === 'polygon-lasso' && (
        <>
          <Sep />
          <span className="viewport-opts-hint">Click to add points · Double-click / Enter to close · Backspace removes a point · Esc cancels</span>
        </>
      )}
    </div>
  );
}

export const lassoTool = makeLasso();
export const polygonLassoTool = makePolyLasso();
