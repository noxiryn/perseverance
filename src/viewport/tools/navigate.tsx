/**
 * Hand (H) and Zoom (Z) tools.
 *  - Hand: drag pans; double-click fits. Options: 100%, Fit Screen, Fill Screen.
 *  - Zoom: click zooms in, Alt-click zooms out, drag zooms to a rectangle. Options: in/out
 *    toggle, 100%, Fit, Fill.
 */
import { Hand, ZoomIn, ZoomOut } from 'lucide-react';
import type { Point } from '../../core/types';
import type { ToolDef, ToolPointerEvent } from '../../registry';
import { viewport } from '../../editor/viewport';
import { activeSession, toolOptions, useEditor, useToolOptions } from '../../state/editor';
import { Button, IconButton } from '../../ui/controls';
import { fitZoom, nextZoomStep, zoomToRect } from '../math/zoom';
import { Sep, setToolOptionSafe } from '../options/common';
import { requireDoc } from '../state';
import '../viewport.css';

/* ------------------------------------------------------------------ */
/* shared view actions                                                 */
/* ------------------------------------------------------------------ */

export function fitOnScreen() {
  if (!requireDoc('Fit on Screen')) return;
  viewport.fit();
}

export function fillScreen() {
  const s = activeSession();
  if (!s) return;
  const size = viewport.getSize();
  const z = fitZoom(s.doc.width, s.doc.height, size.width, size.height, 0, 'fill');
  useEditor.getState().setView({ zoom: z, panX: 0, panY: 0 });
}

export function actualPixels() {
  if (!requireDoc('Actual Pixels')) return;
  viewport.actualPixels();
}

export function zoomStep(dir: 1 | -1, anchor?: Point) {
  if (!requireDoc('Zoom')) return;
  viewport.zoomTo(nextZoomStep(viewport.zoom(), dir), anchor);
}

function ViewButtons() {
  return (
    <>
      <Button size="small" onClick={actualPixels} title="Actual pixels (Ctrl+1)">
        100%
      </Button>
      <Button size="small" onClick={fitOnScreen} title="Fit on screen (Ctrl+0)">
        Fit Screen
      </Button>
      <Button size="small" onClick={fillScreen} title="Fill the viewport with the document">
        Fill Screen
      </Button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Hand                                                                */
/* ------------------------------------------------------------------ */

let handLast: Point | null = null;

export const handTool: ToolDef = {
  id: 'hand',
  name: 'Hand Tool',
  shortcut: 'H',
  icon: Hand,
  group: 'hand',
  order: 150,
  cursor: () => (handLast ? 'grabbing' : 'grab'),
  OptionsBar: () => (
    <div className="viewport-opts">
      <ViewButtons />
      <Sep />
      <span className="viewport-opts-hint">Drag to pan · Double-click to fit · Hold Space with any tool</span>
    </div>
  ),
  onPointerDown(e) {
    if (e.button !== 0) return;
    handLast = { x: e.screenX, y: e.screenY };
    viewport.setCursor('grabbing');
  },
  onPointerMove(e) {
    if (!handLast) return;
    const dx = e.screenX - handLast.x;
    const dy = e.screenY - handLast.y;
    handLast = { x: e.screenX, y: e.screenY };
    if (dx || dy) viewport.panBy(dx, dy);
  },
  onPointerUp() {
    handLast = null;
    viewport.setCursor(null);
  },
  onDoubleClick() {
    fitOnScreen();
  },
  onDeactivate() {
    handLast = null;
  },
};

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

export const ZOOM_DEFAULTS = { mode: 'in' as 'in' | 'out' };

function zoomCursor(out: boolean): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="10" cy="10" r="6.5" fill="rgba(255,255,255,0.25)" stroke="#000" stroke-width="3"/><circle cx="10" cy="10" r="6.5" fill="none" stroke="#fff" stroke-width="1.4"/><path d="M15 15l6 6" stroke="#000" stroke-width="4" stroke-linecap="round"/><path d="M15 15l6 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M7 10h6${out ? '' : 'M10 7v6'}" stroke="#000" stroke-width="3"/><path d="M7.5 10h5${out ? '' : 'M10 7.5v5'}" stroke="#fff" stroke-width="1.3"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 10 10, ${out ? 'zoom-out' : 'zoom-in'}`;
}
const CURSOR_IN = zoomCursor(false);
const CURSOR_OUT = zoomCursor(true);

interface ZoomDrag {
  a: Point;
  b: Point;
  screenA: Point;
  screenB: Point;
  out: boolean;
  moved: boolean;
}
let zdrag: ZoomDrag | null = null;

function isOut(e: { altKey: boolean }): boolean {
  const mode = toolOptions('zoom', ZOOM_DEFAULTS).mode;
  return (mode === 'out') !== e.altKey;
}

export const zoomTool: ToolDef = {
  id: 'zoom',
  name: 'Zoom Tool',
  shortcut: 'Z',
  icon: ZoomIn,
  group: 'zoom',
  order: 160,
  cursor: () => (toolOptions('zoom', ZOOM_DEFAULTS).mode === 'out' ? CURSOR_OUT : CURSOR_IN),
  OptionsBar: ZoomOptions,
  defaultOptions: { ...ZOOM_DEFAULTS },
  onPointerDown(e: ToolPointerEvent) {
    if (e.button !== 0) return;
    const p = { x: e.docX, y: e.docY };
    const sp = { x: e.screenX, y: e.screenY };
    zdrag = { a: p, b: p, screenA: sp, screenB: sp, out: isOut(e), moved: false };
  },
  onPointerMove(e) {
    if (!zdrag) return;
    zdrag.b = { x: e.docX, y: e.docY };
    zdrag.screenB = { x: e.screenX, y: e.screenY };
    if (Math.hypot(zdrag.screenB.x - zdrag.screenA.x, zdrag.screenB.y - zdrag.screenA.y) > 4) zdrag.moved = true;
    viewport.requestOverlay();
  },
  onPointerUp() {
    const d = zdrag;
    zdrag = null;
    viewport.requestOverlay();
    const s = activeSession();
    if (!d || !s) return;
    if (!d.moved) {
      zoomStep(d.out ? -1 : 1, d.screenA);
      return;
    }
    const r = {
      x: Math.min(d.a.x, d.b.x),
      y: Math.min(d.a.y, d.b.y),
      width: Math.abs(d.b.x - d.a.x),
      height: Math.abs(d.b.y - d.a.y),
    };
    if (r.width < 1 || r.height < 1) return;
    const size = viewport.getSize();
    if (d.out) {
      // Zoom out so the current view fits into the dragged rectangle.
      const factor = Math.min(Math.abs(d.screenB.x - d.screenA.x) / size.width, Math.abs(d.screenB.y - d.screenA.y) / size.height);
      viewport.zoomBy(Math.max(0.05, factor), { x: (d.screenA.x + d.screenB.x) / 2, y: (d.screenA.y + d.screenB.y) / 2 });
      return;
    }
    useEditor.getState().setView(zoomToRect(r, s.doc.width, s.doc.height, size.width, size.height));
  },
  onHover(e) {
    viewport.setCursor(isOut(e) ? CURSOR_OUT : CURSOR_IN);
  },
  onKeyDown(e) {
    if (e.key === 'Alt') viewport.setCursor(toolOptions('zoom', ZOOM_DEFAULTS).mode === 'out' ? CURSOR_IN : CURSOR_OUT);
    return false;
  },
  onKeyUp(e) {
    if (e.key === 'Alt') viewport.setCursor(null);
    return false;
  },
  onDeactivate() {
    zdrag = null;
  },
  renderOverlay(ctx) {
    if (!zdrag?.moved) return;
    const a = zdrag.screenA;
    const b = zdrag.screenB;
    const x = Math.round(Math.min(a.x, b.x)) + 0.5;
    const y = Math.round(Math.min(a.y, b.y)) + 0.5;
    const w = Math.round(Math.abs(b.x - a.x));
    const h = Math.round(Math.abs(b.y - a.y));
    ctx.fillStyle = 'rgba(139,124,246,0.10)';
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x, y, w, h);
  },
};

function ZoomOptions() {
  const o = useToolOptions('zoom', ZOOM_DEFAULTS);
  return (
    <div className="viewport-opts">
      <div className="viewport-seg" role="radiogroup" aria-label="Zoom direction">
        <IconButton icon={ZoomIn} size="sm" iconSize={14} active={o.mode === 'in'} title="Zoom in" onClick={() => setToolOptionSafe('zoom', 'mode', 'in')} />
        <IconButton icon={ZoomOut} size="sm" iconSize={14} active={o.mode === 'out'} title="Zoom out (or hold Alt)" onClick={() => setToolOptionSafe('zoom', 'mode', 'out')} />
      </div>
      <Sep />
      <ViewButtons />
      <Sep />
      <span className="viewport-opts-hint">Click to zoom · Alt-click to zoom out · Drag to zoom into an area</span>
    </div>
  );
}
