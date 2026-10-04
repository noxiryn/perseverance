/**
 * Move tool (V): drag layers (groups move children; locks respected; Shift constrains; Alt-drag
 * duplicates; Ctrl toggles auto-select), smart-guide snapping, arrow-key nudge, transform
 * controls (scale/rotate handles), and routing for an active Free Transform session.
 */
import { Move } from 'lucide-react';
import type { Document, ID, Layer, Point, Rect, Transform } from '../../core/types';
import type { ToolDef, ToolPointerEvent } from '../../registry';
import { insertLayerDraft, isTransformable } from '../../core/document';
import { viewport } from '../../editor/viewport';
import { activeSession, toolOptions, useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { TransformSession, type Hit } from '../transform/session';
import { activeTransform, cancelTransform, commitTransform } from '../transform/controller';
import { cloneLayerTree, layerCorners, pickLayer, topGroupOf, topLevelIds, transformableLeaves } from '../layers';
import { clearSmartGuides, collectSnapTargets, snapRect, type SnapTargets } from '../snap';
import { drawLabel } from '../draw';
import { fmtPx, toastOnce, vpState } from '../state';
import { nudgeLayers } from './moveOps';
import { MoveOptionsBar } from '../options/MoveOptions';

export const MOVE_DEFAULTS = { autoSelect: false, autoSelectTarget: 'layer' as 'layer' | 'group' };

interface MoveDrag {
  kind: 'move';
  q0: Point;
  screen0: Point;
  moved: boolean;
  selection: ID[];
  leaves: ID[];
  starts: Map<ID, Transform>;
  bounds: Rect | null;
  targets: SnapTargets | null;
  duplicate: boolean;
  duplicated: boolean;
  cloneRoots: ID[];
  dx: number;
  dy: number;
  last: Point;
}

interface TransformDrag {
  kind: 'transform';
  session: TransformSession;
  persistent: boolean;
}

let drag: MoveDrag | TransformDrag | null = null;

/* ---------------- transform controls cache ---------------- */

let controls: { key: string; doc: Document; session: TransformSession | null } | null = null;

function selectedIds(): ID[] {
  const s = activeSession();
  if (!s) return [];
  return s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
}

/** Transform-controls session for the current layer selection (cached per doc state). */
function controlsSession(): TransformSession | null {
  const s = activeSession();
  if (!s || !useUI.getState().view.transformControls) return null;
  const ids = selectedIds();
  const key = ids.join(',');
  if (controls && controls.doc === s.doc && controls.key === key) return controls.session;
  const res = ids.length ? TransformSession.forLayers(s.doc, ids, 'immediate') : null;
  controls = { key, doc: s.doc, session: res && typeof res !== 'string' ? res : null };
  return controls.session;
}

/* ---------------- helpers ---------------- */

function unionOfCorners(doc: Document, ids: ID[]): Rect | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const id of ids) {
    const l = doc.layers[id];
    if (!isTransformable(l)) continue;
    for (const p of layerCorners(l)) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function explain(doc: Document, ids: ID[]): string {
  const { locked, other } = transformableLeaves(doc, ids);
  if (locked.length) return 'The layer is locked. Unlock its position to move it.';
  if (other.length) return 'Fill and adjustment layers cover the whole canvas and cannot be moved.';
  return 'Select a layer to move (or turn on Auto-Select).';
}

function autoSelectAt(e: ToolPointerEvent): boolean {
  const s = activeSession();
  if (!s) return false;
  const id = pickLayer(s.doc, e.docX, e.docY);
  if (!id) return false;
  const opts = toolOptions('move', MOVE_DEFAULTS);
  const target = opts.autoSelectTarget === 'group' ? topGroupOf(s.doc, id) : id;
  const st = useEditor.getState();
  if (e.shiftKey) st.setActiveLayer(target, 'toggle');
  else if (!s.selectedLayerIds.includes(target) || s.activeLayerId !== target) st.setActiveLayer(target, 'replace');
  return true;
}

/* ---------------- pointer handlers ---------------- */

function onPointerDown(e: ToolPointerEvent) {
  const s = activeSession();
  if (!s || e.button !== 0) return;
  const screen = { x: e.screenX, y: e.screenY };

  // Active Free Transform / Transform Selection session owns the input.
  const ses = activeTransform();
  if (ses) {
    const hit = ses.hitTest(screen);
    if (ses.begin(hit, e)) drag = { kind: 'transform', session: ses, persistent: true };
    return;
  }

  const opts = toolOptions('move', MOVE_DEFAULTS);
  const auto = opts.autoSelect !== e.ctrlKey;

  // Transform controls (handles / rotation zone) on the current selection.
  const ctl = controlsSession();
  if (ctl && !e.altKey) {
    const hit: Hit = ctl.hitTest(screen);
    if (hit.kind === 'handle' || hit.kind === 'rotate') {
      // A fresh session so the snapshot matches the current document.
      const fresh = TransformSession.forLayers(s.doc, selectedIds(), 'immediate');
      if (typeof fresh !== 'string' && fresh.begin(hit, e)) {
        drag = { kind: 'transform', session: fresh, persistent: false };
        return;
      }
    }
  }

  if (auto) autoSelectAt(e);
  const cur = activeSession()!;
  const sel = topLevelIds(cur.doc, selectedIds());
  if (!sel.length) {
    toastOnce('Select a layer to move (or turn on Auto-Select).', 'info');
    return;
  }
  const { movable } = transformableLeaves(cur.doc, sel);
  if (!movable.length) {
    toastOnce(explain(cur.doc, sel));
    return;
  }
  const starts = new Map<ID, Transform>();
  for (const id of movable) {
    const l = cur.doc.layers[id];
    if (isTransformable(l)) starts.set(id, { ...l.transform });
  }
  drag = {
    kind: 'move',
    q0: { x: e.docX, y: e.docY },
    screen0: screen,
    moved: false,
    selection: sel,
    leaves: movable,
    starts,
    bounds: unionOfCorners(cur.doc, movable),
    targets: null,
    duplicate: e.altKey,
    duplicated: false,
    cloneRoots: [],
    dx: 0,
    dy: 0,
    last: { x: e.docX, y: e.docY },
  };
}

function startDuplicate(d: MoveDrag) {
  const s = activeSession();
  if (!s) return;
  const doc = s.doc;
  const clones: { layers: Layer[]; rootId: ID; above: ID }[] = d.selection.map((id) => ({ ...cloneLayerTree(doc, id), above: id }));
  useEditor.getState().preview((draft) => {
    for (const c of clones) {
      for (const l of c.layers) if (l.id !== c.rootId) draft.layers[l.id] = l;
      const root = c.layers.find((l) => l.id === c.rootId)!;
      insertLayerDraft(draft, root, { aboveId: c.above });
    }
  });
  const after = activeSession()!.doc;
  d.cloneRoots = clones.map((c) => c.rootId);
  const { movable } = transformableLeaves(after, d.cloneRoots);
  d.leaves = movable;
  d.starts = new Map();
  for (const id of movable) {
    const l = after.layers[id];
    if (isTransformable(l)) d.starts.set(id, { ...l.transform });
  }
  d.duplicated = true;
}

function onPointerMove(e: ToolPointerEvent) {
  if (!drag) return;
  if (drag.kind === 'transform') {
    drag.session.move(e);
    return;
  }
  const d = drag;
  if (!d.moved) {
    if (Math.hypot(e.screenX - d.screen0.x, e.screenY - d.screen0.y) < 3) return;
    d.moved = true;
    const s = activeSession();
    if (s) d.targets = collectSnapTargets(s.doc, { exclude: new Set(d.selection) });
    if (d.duplicate) startDuplicate(d);
  }
  let dx = e.docX - d.q0.x;
  let dy = e.docY - d.q0.y;
  if (e.shiftKey) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  if (d.bounds && d.targets) {
    const r = { ...d.bounds, x: d.bounds.x + dx, y: d.bounds.y + dy };
    const sn = snapRect(r, { targets: d.targets, axes: { x: !e.shiftKey || dx !== 0, y: !e.shiftKey || dy !== 0 } });
    dx += sn.dx;
    dy += sn.dy;
  }
  // Whole pixels at ≥100% feel better (no blurry half-pixel positions); finer when zoomed in.
  const z = viewport.zoom();
  const q = z >= 4 ? 0.25 : 1;
  dx = Math.round(dx / q) * q;
  dy = Math.round(dy / q) * q;
  d.dx = dx;
  d.dy = dy;
  d.last = { x: e.docX, y: e.docY };
  const leaves = d.leaves;
  const starts = d.starts;
  useEditor.getState().preview((draft) => {
    for (const id of leaves) {
      const l = draft.layers[id];
      const st = starts.get(id);
      if (!l || !st || !isTransformable(l)) continue;
      l.transform.x = st.x + dx;
      l.transform.y = st.y + dy;
    }
  });
  viewport.requestOverlay();
}

function onPointerUp() {
  const d = drag;
  drag = null;
  clearSmartGuides();
  if (!d) return;
  if (d.kind === 'transform') {
    const moved = d.session.end();
    if (!d.persistent) {
      if (moved) d.session.commit();
      else d.session.cancel();
    }
    viewport.requestOverlay();
    return;
  }
  if (!d.moved) return;
  const st = useEditor.getState();
  if (d.duplicated) {
    st.commit(d.cloneRoots.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer', undefined, {
      selectedLayerIds: d.cloneRoots,
      activeLayerId: d.cloneRoots[d.cloneRoots.length - 1],
    });
  } else if (d.dx !== 0 || d.dy !== 0) st.commit('Move');
  else st.cancelPreview();
  viewport.requestOverlay();
}

function onDoubleClick(e: ToolPointerEvent) {
  const ses = activeTransform();
  if (!ses) return;
  if (ses.hitTest({ x: e.screenX, y: e.screenY }).kind === 'inside') commitTransform();
}

let lastHover = 0;
function onHover(e: ToolPointerEvent) {
  const screen = { x: e.screenX, y: e.screenY };
  const ses = activeTransform();
  if (ses) {
    viewport.setCursor(ses.cursorFor(ses.hitTest(screen), e));
    return;
  }
  const ctl = controlsSession();
  const hit = ctl ? ctl.hitTest(screen) : null;
  viewport.setCursor(ctl && hit && (hit.kind === 'handle' || hit.kind === 'rotate') && !e.altKey ? ctl.cursorFor(hit, e) : null);
  // Hover outline of the layer that auto-select would pick.
  const now = performance.now();
  if (now - lastHover < 30) return;
  lastHover = now;
  const s = activeSession();
  const auto = toolOptions('move', MOVE_DEFAULTS).autoSelect !== e.ctrlKey;
  const next = s && auto ? pickLayer(s.doc, e.docX, e.docY) : null;
  if (next !== vpState.hoverLayerId) {
    vpState.hoverLayerId = next;
    viewport.requestOverlay();
  }
}

function onKeyDown(e: KeyboardEvent): boolean {
  const ses = activeTransform();
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (ses) {
    if (e.key === 'Enter') {
      commitTransform();
      return true;
    }
    if (e.key === 'Escape') {
      cancelTransform();
      return true;
    }
    if (arrows[e.key] && !e.ctrlKey && !e.metaKey) {
      const k = e.shiftKey ? 10 : 1;
      ses.nudge(arrows[e.key][0] * k, arrows[e.key][1] * k);
      return true;
    }
    return false;
  }
  if (arrows[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey && activeSession()) {
    const k = e.shiftKey ? 10 : 1;
    nudgeLayers(arrows[e.key][0] * k, arrows[e.key][1] * k);
    return true;
  }
  return false;
}

function onDeactivate() {
  if (drag?.kind === 'transform' && !drag.persistent) drag.session.cancel();
  if (drag?.kind === 'move' && drag.moved) useEditor.getState().cancelPreview();
  drag = null;
  vpState.hoverLayerId = null;
  if (activeTransform()) commitTransform();
  clearSmartGuides();
}

function renderOverlay(ctx: CanvasRenderingContext2D) {
  const s = activeSession();
  if (!s) return;
  const ses = activeTransform();
  if (ses) {
    ses.render(ctx);
    return;
  }
  if (drag?.kind === 'transform') {
    drag.session.render(ctx);
    return;
  }
  const extras = useUI.getState().view.extras;
  // Hover outline (auto-select preview)
  const hov = vpState.hoverLayerId;
  if (hov && extras && !drag && !selectedIds().includes(hov)) {
    const l = s.doc.layers[hov];
    if (isTransformable(l)) {
      const pts = layerCorners(l).map((p) => viewport.docToScreen(p));
      ctx.save();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(139,124,246,0.9)';
      ctx.stroke();
      ctx.restore();
    }
  }
  const ctl = controlsSession();
  if (ctl) ctl.render(ctx, { handles: !(drag?.kind === 'move' && drag.moved) });
  if (drag?.kind === 'move' && drag.moved) {
    drawLabel(ctx, [`ΔX: ${fmtPx(drag.dx)} px`, `ΔY: ${fmtPx(drag.dy)} px`], viewport.docToScreen(drag.last));
  }
}

export const moveTool: ToolDef = {
  id: 'move',
  name: 'Move Tool',
  shortcut: 'V',
  icon: Move,
  group: 'move',
  order: 10,
  cursor: 'default',
  OptionsBar: MoveOptionsBar,
  defaultOptions: { ...MOVE_DEFAULTS },
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onHover,
  onDoubleClick,
  onKeyDown,
  onDeactivate,
  renderOverlay,
};
