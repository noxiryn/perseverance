/**
 * Guides: drawing, hit testing, and dragging (new guides from the rulers; the move tool drags
 * existing ones — releasing over a ruler or outside the canvas deletes the guide).
 */
import type { Document, Guide, Point } from '../core/types';
import { uid } from '../core/ids';
import { viewport } from '../editor/viewport';
import { activeSession, useEditor } from '../state/editor';
import { useUI } from '../state/ui';
import { collectSnapTargets, computeValueSnap, snapEnabled, snapThreshold, type SnapCandidate } from './snap';
import { minorStep } from './rulers';
import { drawLabel } from './draw';
import { GUIDE_COLOR, RULER, fmtPx, vpState, type GuideDrag } from './state';

/** Guide under a screen point (within `tol` CSS px), topmost last-added first. */
export function hitGuide(doc: Document, screen: Point, tol = 4): Guide | null {
  const o = viewport.origin();
  const z = viewport.zoom();
  for (let i = doc.guides.length - 1; i >= 0; i--) {
    const g = doc.guides[i];
    if (g.orientation === 'vertical') {
      if (Math.abs(o.x + g.position * z - screen.x) <= tol) return g;
    } else if (Math.abs(o.y + g.position * z - screen.y) <= tol) return g;
  }
  return null;
}

interface DragCtx {
  cands: SnapCandidate[];
  startPos: number;
}
let dragCtx: DragCtx | null = null;

/** Start dragging a new guide out of a ruler (`top` ruler → horizontal guide). */
export function beginNewGuide(from: 'top' | 'left', screen: Point) {
  const s = activeSession();
  if (!s) return;
  if (!useUI.getState().view.guides) useUI.getState().toggleView('guides', true);
  const orientation = from === 'top' ? 'horizontal' : 'vertical';
  vpState.guideDrag = { id: null, orientation, position: 0, remove: true };
  prepare(s.doc, orientation, 0);
  updateGuideDrag(screen, false);
}

/** Start moving an existing guide (move tool). */
export function beginMoveGuide(g: Guide) {
  const s = activeSession();
  if (!s) return;
  vpState.guideDrag = { id: g.id, orientation: g.orientation, position: g.position, remove: false };
  prepare(s.doc, g.orientation, g.position);
  viewport.requestOverlay();
}

function prepare(doc: Document, orientation: Guide['orientation'], startPos: number) {
  const t = collectSnapTargets(doc, { guides: false });
  dragCtx = { cands: orientation === 'vertical' ? t.x : t.y, startPos };
}

export function updateGuideDrag(screen: Point, shift: boolean) {
  const d = vpState.guideDrag;
  const s = activeSession();
  if (!d || !s) return;
  const p = viewport.screenToDoc(screen);
  let pos = d.orientation === 'vertical' ? p.x : p.y;
  if (shift) {
    const step = minorStep(viewport.zoom());
    pos = Math.round(pos / step) * step;
  } else if (snapEnabled() && dragCtx) {
    pos = computeValueSnap(pos, dragCtx.cands, snapThreshold());
  }
  const z = viewport.zoom();
  pos = z >= 4 ? Math.round(pos * 4) / 4 : Math.round(pos);
  d.position = pos;
  const overRuler = d.orientation === 'vertical' ? screen.x < RULER : screen.y < RULER;
  const outside = d.orientation === 'vertical' ? pos < 0 || pos > s.doc.width : pos < 0 || pos > s.doc.height;
  d.remove = (useUI.getState().view.rulers && overRuler) || (d.id !== null && outside) || (d.id === null && overRuler);
  viewport.requestOverlay();
}

export function endGuideDrag() {
  const d = vpState.guideDrag;
  vpState.guideDrag = null;
  dragCtx = null;
  viewport.requestOverlay();
  const s = activeSession();
  if (!d || !s) return;
  const st = useEditor.getState();
  if (d.id === null) {
    if (d.remove) return;
    const g: Guide = { id: uid('g_'), orientation: d.orientation, position: d.position };
    st.commit('New Guide', (draft) => {
      draft.guides.push(g);
    });
    return;
  }
  const id = d.id;
  if (d.remove) {
    st.commit('Delete Guide', (draft) => {
      draft.guides = draft.guides.filter((x) => x.id !== id);
    });
    return;
  }
  const orig = s.doc.guides.find((x) => x.id === id);
  if (!orig || orig.position === d.position) return;
  st.commit('Move Guide', (draft) => {
    const g = draft.guides.find((x) => x.id === id);
    if (g) g.position = d.position;
  });
}

export function cancelGuideDrag() {
  vpState.guideDrag = null;
  dragCtx = null;
  viewport.requestOverlay();
}

/** Draw all guides (and the one being dragged). Screen-space context. */
export function drawGuides(ctx: CanvasRenderingContext2D, doc: Document, size: { width: number; height: number }, show: boolean) {
  const o = viewport.origin();
  const z = viewport.zoom();
  const d: GuideDrag | null = vpState.guideDrag;
  ctx.save();
  ctx.lineWidth = 1;
  if (show) {
    ctx.strokeStyle = GUIDE_COLOR;
    ctx.beginPath();
    for (const g of doc.guides) {
      if (d && d.id === g.id) continue;
      if (g.orientation === 'vertical') {
        const x = Math.round(o.x + g.position * z) + 0.5;
        if (x < -1 || x > size.width + 1) continue;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.height);
      } else {
        const y = Math.round(o.y + g.position * z) + 0.5;
        if (y < -1 || y > size.height + 1) continue;
        ctx.moveTo(0, y);
        ctx.lineTo(size.width, y);
      }
    }
    ctx.stroke();
  }
  if (d) {
    ctx.strokeStyle = d.remove ? 'rgba(41,196,255,0.45)' : GUIDE_COLOR;
    if (d.remove) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    let at: Point;
    if (d.orientation === 'vertical') {
      const x = Math.round(o.x + d.position * z) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.height);
      at = { x, y: (vpState.pointer?.y ?? 40) - 10 };
    } else {
      const y = Math.round(o.y + d.position * z) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(size.width, y);
      at = { x: (vpState.pointer?.x ?? 40) - 6, y };
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const text = d.remove && d.id !== null ? 'Delete guide' : `${d.orientation === 'vertical' ? 'X' : 'Y'}: ${fmtPx(d.position)} px`;
    if (!(d.remove && d.id === null)) drawLabel(ctx, text, at);
  }
  ctx.restore();
}
