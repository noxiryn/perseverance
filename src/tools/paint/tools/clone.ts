/**
 * Clone Stamp (S): Alt-click to set the source, then paint copies of it. Aligned keeps one
 * fixed offset for all strokes; otherwise each stroke restarts from the source point. Samples
 * the current layer (as it was when the stroke started) or all visible layers.
 */
import { Stamp } from 'lucide-react';
import { createCanvas, ctx2d } from '../../../core/canvas';
import { viewport } from '../../../editor/viewport';
import { renderDocument } from '../../../render/compositor';
import { activeSession, toolOptions } from '../../../state/editor';
import { toast } from '../../../state/ui';
import { COVERAGE, DabPainter, tipForPreset } from '../engine/dabs';
import type { PaintTarget } from '../engine/target';
import { CLONE_DEFAULTS, brushCompositeOp } from '../options';
import { CloneOptionsBar } from '../ui/OptionsBars';
import { strokeConfig } from '../engine/config';
import { brushCursor, drawBrushOutline, drawCrosshair, handleBrushKeys, hover, isSquareTip, stabilizerRadius } from './common';
import { createStampTool } from './stampTool';
import { cloneSource, setCloneSource } from './cloneState';

/** Live offset while painting (for the overlay). */
let painting: { offset: { x: number; y: number }; pos: { x: number; y: number } } | null = null;
let altDown = false;

/** Reset the Alt (set source) state — also when the window loses focus mid-press (Alt+Tab). */
function releaseAlt() {
  if (!altDown) return;
  altDown = false;
  viewport.setCursor(null);
}

/** Reused doc-sized canvas holding the merged document for "All Layers" sampling. */
let mergedSource: HTMLCanvasElement | null = null;

/**
 * Fill image + image → layer-local matrix for the clone source.
 *  - Current layer: the session's stroke-start copy of the layer itself ('before'), mapped
 *    local → doc → shifted by the clone offset → local. No allocation, and pixels of a moved or
 *    scaled layer that lie outside the document can still be cloned.
 *  - All layers: a doc-space render of the visible document (copied, since the compositor's
 *    canvas changes while we paint).
 */
function cloneFill(target: PaintTarget, sample: 'current' | 'all', offset: { x: number; y: number }): { image: HTMLCanvasElement | 'before'; matrix: DOMMatrix } | null {
  const shift = new DOMMatrix().translateSelf(-offset.x, -offset.y);
  const toLocal = target.toLocal ?? new DOMMatrix();
  if (sample === 'all' && target.kind === 'content') {
    const doc = activeSession()?.doc;
    if (!doc) return null;
    let merged: HTMLCanvasElement;
    try {
      merged = renderDocument(doc, { background: true });
    } catch (err) {
      console.error('[paint] clone sample failed', err);
      toast('Clone Stamp: could not sample all layers', 'error');
      return null;
    }
    if (!mergedSource || mergedSource.width !== doc.width || mergedSource.height !== doc.height) mergedSource = createCanvas(doc.width, doc.height);
    const ctx = ctx2d(mergedSource);
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(merged, 0, 0, doc.width, doc.height);
    ctx.restore();
    return { image: mergedSource, matrix: toLocal.multiply(shift) };
  }
  // local → doc → source offset → local
  const matrix = target.toDoc ? toLocal.multiply(shift).multiply(target.toDoc) : toLocal.multiply(shift);
  return { image: 'before', matrix };
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
    const fill = cloneFill(target, o.sample, offset);
    if (!fill) return null;
    // The stroke buffer collects tip coverage only; the composite fills it with the source image
    // shifted by the clone offset (exact colors even at soft, low-flow edges).
    const painter = new DabPainter({ tip: tipForPreset(o.presetId, o.hardness), color: COVERAGE, base: target.toLocal, maxSize: o.size });
    painting = { offset, pos: { x: e.docX, y: e.docY } };

    return {
      config: strokeConfig(o, stabilizerRadius(o.smoothing)),
      mode: {
        opacity: o.opacity,
        op: target.kind === 'mask' ? 'source-over' : brushCompositeOp(o.blendMode),
        fill,
      },
      draw: (ctx, d) => painter.draw(ctx, d),
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

  onActivate() {
    window.addEventListener('blur', releaseAlt);
  },

  onDeactivate() {
    window.removeEventListener('blur', releaseAlt);
    releaseAlt();
  },

  renderOverlay(ctx) {
    const o = toolOptions('clone-stamp', CLONE_DEFAULTS);
    drawBrushOutline(ctx, { size: o.size, angle: o.angle, roundness: o.roundness, square: isSquareTip(o.presetId) });
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
      releaseAlt();
      return true;
    }
    return false;
  },
});
