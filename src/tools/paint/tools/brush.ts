/** Brush (B), Pencil (B) and Eraser (E) tools. */
import { Brush, Eraser, Pencil } from 'lucide-react';
import { toolOptions } from '../../../state/editor';
import { COVERAGE, DabPainter, tipForPreset, type TipSpec } from '../engine/dabs';
import { hardConfig, strokeConfig } from '../engine/config';
import { paintColorFor } from '../engine/target';
import {
  BRUSH_DEFAULTS,
  ERASER_DEFAULTS,
  PENCIL_DEFAULTS,
  brushCompositeOp,
} from '../options';
import { BrushOptionsBar, EraserOptionsBar, PencilOptionsBar } from '../ui/OptionsBars';
import { brushCursor, colors, drawBrushOutline, handleBrushKeys, isSquareTip, stabilizerRadius } from './common';
import { createStampTool } from './stampTool';

export const brushTool = createStampTool({
  id: 'brush',
  name: 'Brush',
  label: 'Brush Tool',
  icon: Brush,
  group: 'brush',
  order: 70,
  shortcut: 'B',
  defaultOptions: BRUSH_DEFAULTS,
  OptionsBar: BrushOptionsBar,
  cursor: () => brushCursor(toolOptions('brush', BRUSH_DEFAULTS).size),
  setup(target) {
    const o = toolOptions('brush', BRUSH_DEFAULTS);
    const painter = new DabPainter({
      tip: tipForPreset(o.presetId, o.hardness),
      color: COVERAGE,
      base: target.toLocal,
      maxSize: o.size,
    });
    return {
      config: strokeConfig(o, stabilizerRadius(o.smoothing)),
      mode: {
        opacity: o.opacity,
        op: target.kind === 'mask' ? 'source-over' : brushCompositeOp(o.blendMode),
        color: paintColorFor(target, colors().primary),
      },
      draw: (ctx, d) => painter.draw(ctx, d),
      airbrush: o.airbrush,
    };
  },
  renderOverlay(ctx) {
    const o = toolOptions('brush', BRUSH_DEFAULTS);
    drawBrushOutline(ctx, { size: o.size, angle: o.angle, roundness: o.roundness, square: isSquareTip(o.presetId) });
  },
  onKeyDown: (e) => handleBrushKeys('brush', e, { size: 'size', hardness: 'hardness', digits: 'opacity' }),
});

export const pencilTool = createStampTool({
  id: 'pencil',
  name: 'Pencil',
  label: 'Pencil',
  icon: Pencil,
  group: 'brush',
  order: 70,
  shortcut: 'B',
  defaultOptions: PENCIL_DEFAULTS,
  OptionsBar: PencilOptionsBar,
  cursor: () => brushCursor(toolOptions('pencil', PENCIL_DEFAULTS).size),
  setup(target) {
    const o = toolOptions('pencil', PENCIL_DEFAULTS);
    const painter = new DabPainter({
      tip: { kind: 'pencil', square: o.shape === 'square' },
      color: COVERAGE,
      base: target.toLocal,
      maxSize: o.size,
    });
    return {
      config: hardConfig(o.size, stabilizerRadius(o.smoothing), o.pressureSize),
      mode: {
        opacity: o.opacity,
        op: target.kind === 'mask' ? 'source-over' : brushCompositeOp(o.blendMode),
        color: paintColorFor(target, colors().primary),
      },
      draw: (ctx, d) => painter.draw(ctx, d),
    };
  },
  renderOverlay(ctx) {
    const o = toolOptions('pencil', PENCIL_DEFAULTS);
    drawBrushOutline(ctx, { size: o.size, square: o.shape === 'square' });
  },
  onKeyDown: (e) => handleBrushKeys('pencil', e, { size: 'size', digits: 'opacity' }),
});

export const eraserTool = createStampTool({
  id: 'eraser',
  name: 'Eraser',
  label: 'Eraser',
  icon: Eraser,
  group: 'eraser',
  order: 90,
  shortcut: 'E',
  defaultOptions: ERASER_DEFAULTS,
  OptionsBar: EraserOptionsBar,
  cursor: () => brushCursor(toolOptions('eraser', ERASER_DEFAULTS).size),
  setup(target) {
    const o = toolOptions('eraser', ERASER_DEFAULTS);
    // On masks and transparency-locked layers the eraser paints the background color (like Photoshop).
    const paintsColor = target.kind === 'mask' || target.lockTransparency;
    const tip: TipSpec = o.mode === 'brush' ? tipForPreset(o.presetId, o.hardness) : { kind: 'pencil', square: o.mode === 'block' };
    const painter = new DabPainter({ tip, color: COVERAGE, base: target.toLocal, maxSize: o.size });
    return {
      config: o.mode === 'brush' ? strokeConfig(o, stabilizerRadius(o.smoothing)) : hardConfig(o.size, stabilizerRadius(o.smoothing), false),
      mode: {
        opacity: o.mode === 'block' ? 1 : o.opacity,
        op: paintsColor ? 'source-over' : 'destination-out',
        // destination-out only uses coverage; masks / locked layers get the background color.
        color: paintsColor ? paintColorFor(target, colors().secondary) : undefined,
      },
      draw: (ctx, d) => painter.draw(ctx, d),
    };
  },
  renderOverlay(ctx) {
    const o = toolOptions('eraser', ERASER_DEFAULTS);
    if (o.mode === 'brush') drawBrushOutline(ctx, { size: o.size, angle: o.angle, roundness: o.roundness, square: isSquareTip(o.presetId) });
    else drawBrushOutline(ctx, { size: o.size, square: o.mode === 'block' });
  },
  onKeyDown: (e) => handleBrushKeys('eraser', e, { size: 'size', hardness: 'hardness', digits: 'opacity' }),
});
