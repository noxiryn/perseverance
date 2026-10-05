/**
 * Magic Wand (W): select similar colors (tolerance, contiguous, sample all layers or the current
 * layer, anti-alias) with the usual selection modes.
 */
import { WandSparkles } from 'lucide-react';
import type { ToolDef } from '../../registry';
import { colorSelectMask, deselect, type SelectionMode } from '../../editor/selection';
import { viewport } from '../../editor/viewport';
import { activeSession, toolOptions, useToolOptions } from '../../state/editor';
import { Checkbox, NumberField } from '../../ui/controls';
import { renderDocument } from '../../render/compositor';
import { layerPixels } from '../selectOps';
import { CURSORS } from '../draw';
import { toastOnce } from '../state';
import {
  beginOutlineDrag,
  commitOutlineDrag,
  commitSelectionMask,
  drawOutlineDrag,
  modeFromEvent,
  pointInSelection,
  updateOutlineDrag,
  endOutlineDragVisual,
  handleSelectionNudgeKey,
  type OutlineDrag,
} from './selectCommon';
import { SelectionModeButtons, Sep, setToolOptionSafe } from '../options/common';

export const WAND_DEFAULTS = {
  mode: 'new' as SelectionMode,
  tolerance: 32,
  contiguous: true,
  sampleAll: false,
  antiAlias: true,
};

let outline: OutlineDrag | null = null;

function cursorFor(mode: SelectionMode): string {
  if (mode === 'new') return CURSORS.wand;
  return CURSORS.crosshairPlus(mode === 'add' ? '+' : mode === 'subtract' ? '-' : '×');
}

export const magicWandTool: ToolDef = {
  id: 'magic-wand',
  name: 'Magic Wand',
  shortcut: 'W',
  icon: WandSparkles,
  group: 'wand',
  order: 40,
  cursor: CURSORS.wand,
  OptionsBar: WandOptions,
  defaultOptions: { ...WAND_DEFAULTS },
  onPointerDown(e) {
    const s = activeSession();
    if (!s || e.button !== 0) return;
    const o = toolOptions('magic-wand', WAND_DEFAULTS);
    const mode = modeFromEvent(e, o.mode);
    const doc = s.doc;
    if (e.docX < 0 || e.docY < 0 || e.docX >= doc.width || e.docY >= doc.height) {
      if (mode === 'new') deselect();
      return;
    }
    if (mode === 'new' && o.mode === 'new' && pointInSelection(doc, e.docX, e.docY) && e.native.detail < 2) {
      // Could become a drag that moves the outline; decide on move/up.
      outline = beginOutlineDrag(e);
      return;
    }
    runWand(e.docX, e.docY, mode);
  },
  onPointerMove(e) {
    if (outline) updateOutlineDrag(outline, e);
  },
  onPointerUp(e) {
    if (!outline) return;
    const o = outline;
    outline = null;
    if (!commitOutlineDrag(o)) runWand(o.start.x, o.start.y, 'new');
    viewport.requestOverlay();
    void e;
  },
  onHover(e) {
    const s = activeSession();
    const o = toolOptions('magic-wand', WAND_DEFAULTS);
    const mode = modeFromEvent(e, o.mode);
    if (s && mode === 'new' && o.mode === 'new' && pointInSelection(s.doc, e.docX, e.docY)) viewport.setCursor('move');
    else viewport.setCursor(mode === 'new' ? null : cursorFor(mode));
  },
  onKeyDown(e) {
    if (outline) return false;
    return handleSelectionNudgeKey(e);
  },
  onDeactivate() {
    outline = null;
    endOutlineDragVisual();
  },
  renderOverlay(ctx) {
    if (outline?.moved) drawOutlineDrag(ctx, outline);
  },
};

function runWand(x: number, y: number, mode: SelectionMode) {
  const s = activeSession();
  if (!s) return;
  const doc = s.doc;
  const o = toolOptions('magic-wand', WAND_DEFAULTS);
  let source: HTMLCanvasElement | null = null;
  try {
    if (o.sampleAll) source = renderDocument(doc);
    else {
      const id = s.activeLayerId;
      if (!id) {
        toastOnce('Select a layer to sample, or enable “Sample All Layers”.', 'info');
        return;
      }
      // The layer's own pixels (masked), without effects such as drop shadows or strokes.
      source = layerPixels(doc, id, { mask: true });
      if (!source) {
        toastOnce('The active layer has no pixels to sample. Enable “Sample All Layers” to use the composite.', 'info');
        return;
      }
    }
  } catch (err) {
    console.error('[magic-wand] sampling failed', err);
    toastOnce('Could not sample the image.', 'error');
    return;
  }
  if (source.width !== doc.width || source.height !== doc.height) {
    toastOnce('Could not sample the image (unexpected size).', 'error');
    return;
  }
  const mask = colorSelectMask(doc, source, x, y, o.tolerance, o.contiguous, o.antiAlias);
  commitSelectionMask(doc, mask, mode, 'Magic Wand');
}

function WandOptions() {
  const o = useToolOptions('magic-wand', WAND_DEFAULTS);
  const set = (k: string, v: unknown) => setToolOptionSafe('magic-wand', k, v);
  return (
    <div className="viewport-opts">
      <SelectionModeButtons toolId="magic-wand" value={o.mode} />
      <Sep />
      <NumberField scrubLabel="Tolerance" value={o.tolerance} min={0} max={255} step={1} width={48} onChange={(v) => set('tolerance', v)} />
      <Checkbox checked={o.antiAlias} onChange={(v) => set('antiAlias', v)} label="Anti-alias" />
      <Checkbox checked={o.contiguous} onChange={(v) => set('contiguous', v)} label="Contiguous" title="Only select connected pixels" />
      <Checkbox checked={o.sampleAll} onChange={(v) => set('sampleAll', v)} label="Sample All Layers" title="Sample the visible composite instead of the active layer" />
    </div>
  );
}
