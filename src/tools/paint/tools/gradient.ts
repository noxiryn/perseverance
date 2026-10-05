/**
 * Gradient tool (G): drag a line to fill the layer (or selection) with a gradient. Live preview
 * while dragging (reduced resolution on big layers), full resolution + dither on release.
 * Non-pixel active layers get a new "Gradient" layer above them (created on the first real
 * drag, so plain clicks allocate nothing).
 */
import { Blend } from 'lucide-react';
import type { Rect } from '../../../core/types';
import type { ToolDef } from '../../../registry';
import { bitmaps } from '../../../core/bitmaps';
import { createCanvas, ctx2d } from '../../../core/canvas';
import { insertLayerDraft, makeRasterLayer, nextLayerName } from '../../../core/document';
import { rectIntersect } from '../../../core/geometry';
import { viewport } from '../../../editor/viewport';
import { activeSession, toolOptions, useEditor } from '../../../state/editor';
import { toast } from '../../../state/ui';
import { transformRect } from '../engine/dabs';
import { buildLUT, renderGradientPixels } from '../engine/gradient';
import { isModifierKey, watchStroke } from '../engine/guard';
import { CompositeSession } from '../engine/session';
import { maskGray, resolvePaintTarget, selectionInLocal, type PaintTarget } from '../engine/target';
import { GRADIENT_DEFAULTS, brushCompositeOp, effectiveGradient, type GradientToolOptions } from '../options';
import { GradientOptionsBar } from '../ui/OptionsBars';
import { handleBrushKeys, installLeaveTracking, removeLeaveTracking, trackHover } from './common';

interface GradActive {
  docId: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  o: GradientToolOptions;
  lut: Float32Array;
  /** Pixel/mask target resolved on pointerdown; null → a new "Gradient" layer on first drag. */
  target: PaintTarget | null;
  /** Layer the new "Gradient" layer goes above (when target is null). */
  aboveId: string | null;
  /** Created lazily once the drag passes the click threshold. */
  session: CompositeSession | null;
  newLayerId: string | null;
  region: Rect;
  raf: number;
  unwatch: () => void;
}

let active: GradActive | null = null;
let tmpCanvas: HTMLCanvasElement | null = null;
/**
 * Bitmap of a cancelled new-layer drag, kept for the next one instead of allocating another
 * doc-sized canvas (cancelled sessions restore it to fully transparent).
 */
let spareBitmap: string | null = null;

/** Drags shorter than this (screen px) are clicks: no gradient. */
const MIN_DRAG = 3;

function snapAngle(s: { x: number; y: number }, p: { x: number; y: number }) {
  const dx = p.x - s.x,
    dy = p.y - s.y;
  const len = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: s.x + Math.cos(a) * len, y: s.y + Math.sin(a) * len };
}

function dragLength(a: GradActive): number {
  return Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y) * viewport.zoom();
}

function render(a: GradActive, preview: boolean) {
  const s = a.session;
  if (!s) return;
  const r = a.region;
  const scale = preview ? Math.min(1, Math.sqrt(420_000 / Math.max(1, r.width * r.height))) : 1;
  const ow = Math.max(1, Math.ceil(r.width * scale));
  const oh = Math.max(1, Math.ceil(r.height * scale));
  const img = new ImageData(ow, oh);
  renderGradientPixels(img.data, ow, oh, r.x, r.y, scale, s.target.toDoc, {
    kind: a.o.kind,
    start: a.start,
    end: a.end,
    lut: a.lut,
    dither: !preview && a.o.dither,
  });
  if (!tmpCanvas || tmpCanvas.width < ow || tmpCanvas.height < oh) tmpCanvas = createCanvas(Math.max(ow, tmpCanvas?.width ?? 0), Math.max(oh, tmpCanvas?.height ?? 0));
  ctx2d(tmpCanvas).putImageData(img, 0, 0);
  s.clearBuffer(r);
  const ctx = s.bufferCtx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'copy';
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.drawImage(tmpCanvas, 0, 0, ow, oh, r.x, r.y, ow / scale, oh / scale);
  ctx.restore();
  s.markDirty(r);
}

function scheduleRender(a: GradActive) {
  if (a.raf) return;
  a.raf = requestAnimationFrame(() => {
    a.raf = 0;
    if (active === a) render(a, true);
  });
}

/** Put a document's live doc back to its history head (drops a previewed new layer), even when it is not the active document. */
function cancelPreviewFor(docId: string) {
  const st = useEditor.getState();
  const s = st.sessions[docId];
  if (!s) return;
  const head = s.history.entries[s.history.index].doc;
  if (s.doc === head) return;
  if (st.activeDocId === docId) st.cancelPreview();
  else useEditor.setState({ sessions: { ...st.sessions, [docId]: { ...s, doc: head } } });
}

/** Insert the previewed "Gradient" layer and return its paint target (first real drag only). */
function createLayerTarget(a: GradActive): PaintTarget | null {
  const s = activeSession();
  if (!s || s.doc.id !== a.docId) return null;
  const doc = s.doc;
  let bitmapId = spareBitmap;
  spareBitmap = null;
  const spare = bitmapId ? bitmaps.tryGet(bitmapId) : null;
  if (!spare || spare.width !== doc.width || spare.height !== doc.height) bitmapId = bitmaps.create(doc.width, doc.height);
  const nl = makeRasterLayer({ name: nextLayerName(doc, 'Gradient'), bitmapId: bitmapId!, width: doc.width, height: doc.height });
  const aboveId = a.aboveId && doc.layers[a.aboveId] ? a.aboveId : null;
  useEditor.getState().preview((d) => insertLayerDraft(d, nl, { aboveId }));
  a.newLayerId = nl.id;
  const canvas = bitmaps.get(bitmapId!);
  return {
    docId: doc.id,
    layerId: nl.id,
    layerName: nl.name,
    kind: 'content',
    bitmapId: bitmapId!,
    canvas,
    width: canvas.width,
    height: canvas.height,
    toLocal: null,
    toDoc: null,
    lockTransparency: false,
    selection: selectionInLocal(doc, canvas.width, canvas.height, null),
  };
}

/** Create the live session on the first drag past the click threshold. */
function ensureSession(a: GradActive): boolean {
  if (a.session) return true;
  const target = a.target ?? createLayerTarget(a);
  if (!target) return false;
  // Limit work to the selection bounds when there is a selection.
  const full: Rect = { x: 0, y: 0, width: target.width, height: target.height };
  let region: Rect = full;
  const sel = useEditor.getState().sessions[a.docId]?.doc.selection;
  if (sel && target.selection) {
    const b = transformRect(sel.bounds, target.toLocal);
    const grown = { x: Math.floor(b.x) - 1, y: Math.floor(b.y) - 1, width: Math.ceil(b.width) + 3, height: Math.ceil(b.height) + 3 };
    region = rectIntersect(grown, full) ?? full;
  }
  a.region = region;
  a.session = new CompositeSession(target, {
    opacity: a.o.opacity,
    op: target.kind === 'mask' ? 'source-over' : brushCompositeOp(a.o.blendMode),
  });
  a.unwatch = watchStroke(a.session, (msg) => abort(a, msg));
  return true;
}

/** Forget a cancelled new layer (its bitmap is reused by the next drag). */
function dropNewLayer(a: GradActive) {
  if (!a.newLayerId) return;
  cancelPreviewFor(a.docId);
  if (a.session) spareBitmap = a.session.target.bitmapId;
}

function finish(cancel = false) {
  const a = active;
  if (!a) return;
  active = null;
  if (a.raf) cancelAnimationFrame(a.raf);
  a.unwatch();
  const s = a.session;
  if (!s) {
    // A click (no drag): nothing was created or painted.
    viewport.requestOverlay();
    return;
  }
  if (cancel || dragLength(a) < MIN_DRAG) {
    s.cancel();
    dropNewLayer(a);
    viewport.requestRender();
    viewport.requestOverlay();
    return;
  }
  render(a, false);
  const ok = s.commit('Gradient', a.newLayerId ? { activeLayerId: a.newLayerId } : undefined);
  if (!ok) dropNewLayer(a);
  viewport.requestOverlay();
}

/** The guard discarded the gradient (history or document changed underneath it). */
function abort(a: GradActive, message: string) {
  if (active !== a) return;
  active = null;
  if (a.raf) cancelAnimationFrame(a.raf);
  dropNewLayer(a);
  toast(message, 'warning');
  viewport.requestOverlay();
}

export const gradientTool: ToolDef = {
  id: 'gradient',
  name: 'Gradient',
  shortcut: 'G',
  icon: Blend,
  group: 'gradient',
  order: 100,
  cursor: 'crosshair',
  OptionsBar: GradientOptionsBar,
  defaultOptions: GRADIENT_DEFAULTS,

  onActivate() {
    installLeaveTracking();
  },
  onDeactivate() {
    if (active) finish(true);
    removeLeaveTracking();
  },

  onPointerDown(e) {
    trackHover(e);
    if (e.button !== 0) return;
    if (active) finish(true);
    const s = activeSession();
    if (!s) {
      toast('Gradient: open or create a document first', 'info');
      return;
    }
    const layer = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
    let target: PaintTarget | null = null;
    if (layer && ((s.editTarget === 'mask' && layer.mask) || layer.type === 'raster')) {
      target = resolvePaintTarget({ toolName: 'Gradient', offerRasterize: false });
      if (!target) return;
    }
    // Otherwise a new "Gradient" layer is created above the active one — but only once the
    // pointer actually drags (a plain click allocates nothing).
    const o = toolOptions('gradient', GRADIENT_DEFAULTS);
    const g = effectiveGradient(o);
    const isMask = target?.kind === 'mask';
    const stops = isMask ? g.stops.map((st) => ({ ...st, color: maskGray(st.color) })) : g.stops;
    const lut = buildLUT(stops, o.reverse !== !!g.reverse, isMask ? false : o.transparency);
    active = {
      docId: s.doc.id,
      start: { x: e.docX, y: e.docY },
      end: { x: e.docX, y: e.docY },
      o,
      lut,
      target,
      aboveId: layer?.id ?? null,
      session: null,
      newLayerId: null,
      region: { x: 0, y: 0, width: 0, height: 0 },
      raf: 0,
      unwatch: () => {},
    };
  },

  onPointerMove(e) {
    trackHover(e);
    const a = active;
    if (!a) return;
    const p = { x: e.docX, y: e.docY };
    a.end = e.shiftKey ? snapAngle(a.start, p) : p;
    if (dragLength(a) >= MIN_DRAG) {
      if (!ensureSession(a)) {
        active = null;
        viewport.requestOverlay();
        return;
      }
      scheduleRender(a);
    }
    viewport.requestOverlay();
  },

  onPointerUp(e) {
    trackHover(e);
    const a = active;
    if (!a) return;
    const p = { x: e.docX, y: e.docY };
    a.end = e.shiftKey ? snapAngle(a.start, p) : p;
    if (dragLength(a) >= MIN_DRAG && !ensureSession(a)) {
      active = null;
      viewport.requestOverlay();
      return;
    }
    finish();
  },

  onHover(e) {
    trackHover(e);
  },

  onKeyDown(e) {
    if (active && !isModifierKey(e)) {
      if (e.key === 'Escape') {
        finish(true);
        return true;
      }
      if (handleBrushKeys('gradient', e, { digits: 'opacity' })) return true;
      // Commit before the shell runs a command (undo, clear, document switch…).
      finish();
      return false;
    }
    return handleBrushKeys('gradient', e, { digits: 'opacity' });
  },

  renderOverlay(ctx) {
    const a = active;
    if (!a) return;
    const s = viewport.docToScreen(a.start);
    const t = viewport.docToScreen(a.end);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    for (const [p, filled] of [
      [s, false],
      [t, true],
    ] as const) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = filled ? '#fff' : 'rgba(0,0,0,0.6)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = filled ? 'rgba(0,0,0,0.7)' : '#fff';
      ctx.stroke();
    }
    ctx.restore();
  },
};
