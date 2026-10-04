/**
 * Gradient tool (G): drag a line to fill the layer (or selection) with a gradient. Live preview
 * while dragging (reduced resolution on big layers), full resolution + dither on release.
 * Non-pixel active layers get a new "Gradient" layer above them.
 */
import { Blend } from 'lucide-react';
import type { Rect } from '../../../core/types';
import type { ToolDef, ToolPointerEvent } from '../../../registry';
import { bitmaps } from '../../../core/bitmaps';
import { createCanvas, ctx2d } from '../../../core/canvas';
import { insertLayerDraft, makeRasterLayer, nextLayerName } from '../../../core/document';
import { rectIntersect } from '../../../core/geometry';
import { viewport } from '../../../editor/viewport';
import { activeSession, toolOptions, useEditor } from '../../../state/editor';
import { toast } from '../../../state/ui';
import { transformRect } from '../engine/dabs';
import { buildLUT, renderGradientPixels } from '../engine/gradient';
import { CompositeSession } from '../engine/session';
import { maskGray, resolvePaintTarget, selectionInLocal, type PaintTarget } from '../engine/target';
import { GRADIENT_DEFAULTS, brushCompositeOp, effectiveGradient, type GradientToolOptions } from '../options';
import { GradientOptionsBar } from '../ui/OptionsBars';
import { handleBrushKeys, installLeaveTracking, removeLeaveTracking, trackHover } from './common';

interface GradActive {
  session: CompositeSession;
  target: PaintTarget;
  start: { x: number; y: number };
  end: { x: number; y: number };
  newLayerId: string | null;
  region: Rect;
  lut: Float32Array;
  o: GradientToolOptions;
  raf: number;
}

let active: GradActive | null = null;
let tmpCanvas: HTMLCanvasElement | null = null;

function snapAngle(s: { x: number; y: number }, p: { x: number; y: number }) {
  const dx = p.x - s.x,
    dy = p.y - s.y;
  const len = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: s.x + Math.cos(a) * len, y: s.y + Math.sin(a) * len };
}

function render(a: GradActive, preview: boolean) {
  const r = a.region;
  const scale = preview ? Math.min(1, Math.sqrt(420_000 / Math.max(1, r.width * r.height))) : 1;
  const ow = Math.max(1, Math.ceil(r.width * scale));
  const oh = Math.max(1, Math.ceil(r.height * scale));
  const img = new ImageData(ow, oh);
  renderGradientPixels(img.data, ow, oh, r.x, r.y, scale, a.target.toDoc, {
    kind: a.o.kind,
    start: a.start,
    end: a.end,
    lut: a.lut,
    dither: !preview && a.o.dither,
  });
  if (!tmpCanvas || tmpCanvas.width < ow || tmpCanvas.height < oh) tmpCanvas = createCanvas(Math.max(ow, tmpCanvas?.width ?? 0), Math.max(oh, tmpCanvas?.height ?? 0));
  ctx2d(tmpCanvas).putImageData(img, 0, 0);
  const s = a.session;
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

/** Paint target for the gradient, creating a new layer when the active one has no pixels. */
function gradientTarget(): { target: PaintTarget; newLayerId: string | null } | null {
  const s = activeSession();
  if (!s) {
    toast('Gradient: open or create a document first', 'info');
    return null;
  }
  const doc = s.doc;
  const layer = s.activeLayerId ? doc.layers[s.activeLayerId] : null;
  if (layer && ((s.editTarget === 'mask' && layer.mask) || layer.type === 'raster')) {
    const t = resolvePaintTarget({ toolName: 'Gradient', offerRasterize: false });
    return t ? { target: t, newLayerId: null } : null;
  }
  const bitmapId = bitmaps.create(doc.width, doc.height);
  const nl = makeRasterLayer({ name: nextLayerName(doc, 'Gradient'), bitmapId, width: doc.width, height: doc.height });
  useEditor.getState().preview((d) => insertLayerDraft(d, nl, { aboveId: layer?.id ?? null }));
  const canvas = bitmaps.get(bitmapId);
  return {
    newLayerId: nl.id,
    target: {
      docId: doc.id,
      layerId: nl.id,
      layerName: nl.name,
      kind: 'content',
      bitmapId,
      canvas,
      width: canvas.width,
      height: canvas.height,
      toLocal: null,
      toDoc: null,
      lockTransparency: false,
      selection: selectionInLocal(doc, canvas.width, canvas.height, null),
    },
  };
}

function finish(e: ToolPointerEvent | null, cancel = false) {
  const a = active;
  if (!a) return;
  active = null;
  if (a.raf) cancelAnimationFrame(a.raf);
  const tooShort = Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y) * viewport.zoom() < 3;
  if (cancel || tooShort) {
    a.session.cancel();
    if (a.newLayerId) useEditor.getState().cancelPreview();
    viewport.requestRender();
    viewport.requestOverlay();
    return;
  }
  render(a, false);
  const ok = a.session.commit('Gradient', a.newLayerId ? { activeLayerId: a.newLayerId } : undefined);
  if (!ok && a.newLayerId) useEditor.getState().cancelPreview();
  viewport.requestOverlay();
  void e;
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
    if (active) finish(null, true);
    removeLeaveTracking();
  },

  onPointerDown(e) {
    trackHover(e);
    if (e.button !== 0) return;
    if (active) finish(null, true);
    const res = gradientTarget();
    if (!res) return;
    const { target, newLayerId } = res;
    const o = toolOptions('gradient', GRADIENT_DEFAULTS);
    const g = effectiveGradient(o);
    const isMask = target.kind === 'mask';
    const stops = isMask ? g.stops.map((s) => ({ ...s, color: maskGray(s.color) })) : g.stops;
    const lut = buildLUT(stops, o.reverse !== !!g.reverse, isMask ? false : o.transparency);
    // Limit work to the selection bounds when there is a selection.
    const full: Rect = { x: 0, y: 0, width: target.width, height: target.height };
    let region: Rect = full;
    const sel = activeSession()?.doc.selection;
    if (sel && target.selection) {
      const b = transformRect(sel.bounds, target.toLocal);
      const grown = { x: Math.floor(b.x) - 1, y: Math.floor(b.y) - 1, width: Math.ceil(b.width) + 3, height: Math.ceil(b.height) + 3 };
      region = rectIntersect(grown, full) ?? full;
    }
    const session = new CompositeSession(target, {
      opacity: o.opacity,
      op: isMask ? 'source-over' : brushCompositeOp(o.blendMode),
    });
    active = {
      session,
      target,
      start: { x: e.docX, y: e.docY },
      end: { x: e.docX, y: e.docY },
      newLayerId,
      region,
      lut,
      o,
      raf: 0,
    };
  },

  onPointerMove(e) {
    trackHover(e);
    const a = active;
    if (!a) return;
    const p = { x: e.docX, y: e.docY };
    a.end = e.shiftKey ? snapAngle(a.start, p) : p;
    if (Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y) * viewport.zoom() >= 3) scheduleRender(a);
    viewport.requestOverlay();
  },

  onPointerUp(e) {
    trackHover(e);
    const a = active;
    if (!a) return;
    const p = { x: e.docX, y: e.docY };
    a.end = e.shiftKey ? snapAngle(a.start, p) : p;
    finish(e);
  },

  onHover(e) {
    trackHover(e);
  },

  onKeyDown(e) {
    if (e.key === 'Escape' && active) {
      finish(null, true);
      return true;
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
