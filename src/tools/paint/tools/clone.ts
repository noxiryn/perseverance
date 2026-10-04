/**
 * Clone Stamp (S): Alt-click to set the source, then paint copies of it. Aligned keeps one
 * fixed offset for all strokes; otherwise each stroke restarts from the source point. Samples
 * the current layer (as it was before the stroke) or all visible layers.
 */
import { Stamp } from 'lucide-react';
import type { Rect } from '../../../core/types';
import { createCanvas, ctx2d } from '../../../core/canvas';
import { viewport } from '../../../editor/viewport';
import { renderDocument } from '../../../render/compositor';
import { activeSession, toolOptions } from '../../../state/editor';
import { toast } from '../../../state/ui';
import { DabPainter, tipForPreset } from '../engine/dabs';
import type { PaintTarget } from '../engine/target';
import { CLONE_DEFAULTS, brushCompositeOp } from '../options';
import { CloneOptionsBar } from '../ui/OptionsBars';
import { strokeConfig } from '../engine/config';
import { brushCursor, drawBrushOutline, drawCrosshair, handleBrushKeys, hover, stabilizerRadius } from './common';
import { createStampTool } from './stampTool';
import { cloneSource, setCloneSource } from './cloneState';

/** Live offset while painting (for the overlay). */
let painting: { offset: { x: number; y: number }; pos: { x: number; y: number } } | null = null;
let altDown = false;

let dabCanvas: HTMLCanvasElement | null = null;
function dabScratch(n: number) {
  if (!dabCanvas || dabCanvas.width < n || dabCanvas.height < n) dabCanvas = createCanvas(Math.max(n, 64), Math.max(n, 64));
  return dabCanvas;
}

/** Doc-space canvas with the pixels to clone from. */
function buildSource(target: PaintTarget, sample: 'current' | 'all'): HTMLCanvasElement | null {
  const s = activeSession();
  if (!s) return null;
  const doc = s.doc;
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  if (sample === 'all' && target.kind === 'content') {
    try {
      ctx.drawImage(renderDocument(doc, { background: true }), 0, 0);
    } catch (err) {
      console.error('[paint] clone sample failed', err);
      return null;
    }
    return c;
  }
  const m = target.toDoc;
  if (m) ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(target.canvas, 0, 0);
  return c;
}

export const cloneTool = createStampTool({
  id: 'clone-stamp',
  name: 'Clone Stamp',
  label: 'Clone Stamp',
  icon: Stamp,
  group: 'stamp',
  order: 80,
  shortcut: 'S',
  defaultOptions: CLONE_DEFAULTS,
  OptionsBar: CloneOptionsBar,
  cursor: () => (altDown ? 'crosshair' : brushCursor(toolOptions('clone-stamp', CLONE_DEFAULTS).size)),

  preDown(e) {
    const s = activeSession();
    if (!s) return false;
    if (e.altKey) {
      setCloneSource({ docId: s.doc.id, source: { x: e.docX, y: e.docY }, offset: null });
      toast('Clone source set — paint to copy from it', 'info', 1800);
      return true;
    }
    if (!cloneSource()) {
      toast('Clone Stamp: Alt-click to define a source point first', 'info');
      return true;
    }
    return false;
  },

  setup(target, e) {
    const st = cloneSource();
    if (!st) return null;
    const o = toolOptions('clone-stamp', CLONE_DEFAULTS);
    let offset: { x: number; y: number };
    if (o.aligned && st.offset) offset = st.offset;
    else {
      offset = { x: st.source.x - e.docX, y: st.source.y - e.docY };
      if (o.aligned) st.offset = offset;
    }
    const src = buildSource(target, o.sample);
    if (!src) return null;
    const painter = new DabPainter({ tip: tipForPreset(o.presetId, o.hardness), color: '#ffffff', base: target.toLocal, maxSize: o.size });
    const white = painter.whiteStamp!;
    painting = { offset, pos: { x: e.docX, y: e.docY } };

    const draw = (ctx: CanvasRenderingContext2D, d: { x: number; y: number; size: number; angle: number; roundness: number; alpha: number }): Rect => {
      const n = Math.max(2, Math.ceil(d.size) + 2);
      const dc = dabScratch(n);
      const dctx = ctx2d(dc);
      const ox = d.x - n / 2,
        oy = d.y - n / 2;
      dctx.save();
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.globalCompositeOperation = 'copy';
      dctx.drawImage(src, ox + offset.x, oy + offset.y, n, n, 0, 0, n, n);
      // Keep only the tip shape.
      dctx.globalCompositeOperation = 'destination-in';
      const rad = (d.angle * Math.PI) / 180;
      dctx.setTransform(Math.cos(rad), Math.sin(rad), -Math.sin(rad) * d.roundness, Math.cos(rad) * d.roundness, n / 2, n / 2);
      dctx.drawImage(white, -d.size / 2, -d.size / 2, d.size, d.size);
      dctx.restore();
      // Clear outside the n×n square in case the scratch canvas is larger.
      const b = painter.base;
      if (b) ctx.setTransform(b.a, b.b, b.c, b.d, b.a * ox + b.c * oy + b.e, b.b * ox + b.d * oy + b.f);
      else ctx.setTransform(1, 0, 0, 1, ox, oy);
      ctx.globalAlpha = d.alpha;
      ctx.drawImage(dc, 0, 0, n, n, 0, 0, n, n);
      return painter.bounds(d);
    };

    return {
      config: strokeConfig(o, stabilizerRadius(o.smoothing)),
      mode: { opacity: o.opacity, op: target.kind === 'mask' ? 'source-over' : brushCompositeOp(o.blendMode) },
      draw,
      dispose: () => {
        painting = null;
      },
    };
  },

  onStrokeMove(p) {
    if (painting) painting.pos = { x: p.x, y: p.y };
  },

  onStrokeEnd() {
    painting = null;
  },

  renderOverlay(ctx) {
    const o = toolOptions('clone-stamp', CLONE_DEFAULTS);
    drawBrushOutline(ctx, { size: o.size, angle: o.angle, roundness: o.roundness });
    const st = cloneSource();
    if (!st) return;
    if (painting) drawCrosshair(ctx, { x: painting.pos.x + painting.offset.x, y: painting.pos.y + painting.offset.y });
    else if (o.aligned && st.offset && hover.inside) drawCrosshair(ctx, { x: hover.x + st.offset.x, y: hover.y + st.offset.y });
    else drawCrosshair(ctx, st.source);
  },

  onKeyDown(e) {
    if (e.key === 'Alt') {
      // Own the Alt key so it doesn't focus the menu bar; show the source cursor.
      altDown = true;
      viewport.setCursor('crosshair');
      return true;
    }
    return handleBrushKeys('clone-stamp', e, { size: 'size', hardness: 'hardness', digits: 'opacity' });
  },

  onKeyUp(e) {
    if (e.key === 'Alt') {
      altDown = false;
      viewport.setCursor(null);
      return true;
    }
    return false;
  },
});
