/**
 * Destructive Image ▸ Adjustments dialog for the adjustments that have a dedicated editor
 * (Levels with the target's histogram, Curves, Color Balance, Selective Color, Exposure), and
 * for adjusting the layer mask of a non-pixel layer (which the generic filter dialog rejects).
 * Everything else goes through fx-filters' openFilterDialog(id, { mode: 'destructive' }).
 *
 * Live on-canvas preview: pixels are written into the bitmap (raster content or mask) and
 * restored on cancel; text / shape layers get the adjustment as a Smart Filter, like the generic
 * dialog does. OK records one undoable step. The dialog is draggable and starts beside the layer.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { RotateCcw, SlidersHorizontal, WandSparkles } from 'lucide-react';
import type { Document, Layer, ParamValues } from '../../core/types';
import { filters, type FilterDef } from '../../registry';
import { activeSession } from '../../state/editor';
import { openDialog, toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { getLayerBounds, renderLayerContent } from '../../render/compositor';
import { Button, Checkbox, Dialog, Select } from '../../ui/controls';
import { defaultParams, makeFilterContext } from '../engine';
import { AdjustmentParams, HISTOGRAM_IDS } from './AdjustmentParams';
import {
  activeRasterTarget,
  addSmartFilter,
  editRasterPixels,
  PixelPreview,
  runAdjustment,
  SmartFilterPreview,
  targetFilterContext,
  type RasterTarget,
} from './apply';
import { analysisMask, autoContrastParams, autoToneCurves } from './auto';
import { computeHistogram, readDownscaled, type Histogram } from './histogram';
import { NO_DOC_MESSAGE } from './layers';
import { matchPreset, presetsFor, sameParams } from './presets';
import './adjustments.css';

const DIALOG_W = 392;
/** Content width inside the dialog body (16px padding each side). */
const CONTENT_W = DIALOG_W - 32;

/** Adjustments that leave pixels unchanged at their default params (OK then records nothing). */
const IDENTITY_AT_DEFAULTS = new Set([
  'brightness-contrast',
  'levels',
  'curves',
  'exposure',
  'vibrance',
  'hue-saturation',
  'color-balance',
  'channel-mixer',
  'selective-color',
]);

export type DialogTarget = { mode: 'pixels'; target: RasterTarget } | { mode: 'smart'; doc: Document; layer: Layer };

/**
 * What the dialog edits for the active layer: its pixels or mask (destructive), or — for text and
 * shape layers, which stay editable — a Smart Filter. Toasts a helpful message and returns null
 * when nothing can be adjusted.
 */
export function resolveDialogTarget(def: FilterDef): DialogTarget | null {
  const s = activeSession();
  if (!s) {
    toast(NO_DOC_MESSAGE, 'info');
    return null;
  }
  const layer = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!layer) {
    toast(`Select a layer to apply ${def.name}.`, 'info');
    return null;
  }
  const action = `apply ${def.name}`;
  if ((s.editTarget === 'mask' && layer.mask) || layer.type === 'raster') {
    const target = activeRasterTarget(action);
    return target ? { mode: 'pixels', target } : null;
  }
  if (layer.type === 'text' || layer.type === 'shape') {
    if (layer.locks.all) {
      toast(`“${layer.name}” is locked. Unlock it in the Layers panel to ${action}.`, 'warning');
      return null;
    }
    const doc = s.history.entries[s.history.index]?.doc ?? s.doc;
    return { mode: 'smart', doc, layer };
  }
  const what = layer.type === 'group' ? 'a group' : layer.type === 'adjustment' ? 'an adjustment layer' : 'a fill layer';
  toast(`${def.name} can't be applied to ${what}. Use Layer ▸ New Adjustment Layer ▸ ${def.name} instead.`, 'warning');
  return null;
}

/** Open the dialog for `def` on the active layer (resolves when it closes). */
export async function openAdjustmentDialog(def: FilterDef): Promise<void> {
  const target = resolveDialogTarget(def);
  if (!target) return;
  await openDialog<unknown, AdjustmentDialogProps>(AdjustmentDialog, { filterId: def.id, target });
}

export interface AdjustmentDialogProps extends Record<string, unknown> {
  filterId: string;
  target: DialogTarget;
}

/** Histogram of what the adjustment will receive (computed once, from the unmodified pixels). */
function targetHistogram(t: DialogTarget, preview: PixelPreview | null): Histogram | null {
  try {
    if (t.mode === 'pixels' && preview) {
      const img = preview.before;
      const step = Math.max(1, Math.floor((img.width * img.height) / 600_000));
      return computeHistogram(img, { mask: analysisMask(img, t.target.mask), step });
    }
    if (t.mode === 'smart') {
      const img = readDownscaled(renderLayerContent(t.doc, t.layer), 640);
      return computeHistogram(img, { mask: analysisMask(img) });
    }
  } catch (err) {
    console.warn('[adjustments] histogram failed', err);
  }
  return null;
}

/** Start beside the adjusted layer (on the side of the screen it doesn't occupy). */
function initialOffset(t: DialogTarget): { x: number; y: number } {
  const room = Math.max(0, Math.round((window.innerWidth - DIALOG_W) / 2) - 24);
  let side = 1;
  try {
    const doc = t.mode === 'pixels' ? t.target.doc : t.doc;
    const layer = t.mode === 'pixels' ? t.target.layer : t.layer;
    const b = t.mode === 'pixels' && t.target.kind === 'mask' ? null : getLayerBounds(doc, layer.id);
    const el = viewport.element();
    if (b && el) {
      const r = el.getBoundingClientRect();
      const c = viewport.docToScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      if (r.left + c.x > window.innerWidth / 2) side = -1;
    }
  } catch {
    /* viewport not mounted: default to the right */
  }
  return { x: Math.round(room * 0.8) * side, y: 0 };
}

export function AdjustmentDialog({ filterId, target, close }: AdjustmentDialogProps & { close: (r?: unknown) => void }) {
  const def = filters.get(filterId) as FilterDef;
  const defaults = useMemo(() => defaultParams(def.params), [def]);
  const [params, setParams] = useState<ParamValues>(defaults);
  const [live, setLive] = useState(true);
  const [applying, setApplying] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [offset, setOffset] = useState(() => initialOffset(target));
  const finished = useRef(false);

  // Snapshot the pixels before any live preview writes into the bitmap.
  const pixelPreview = useMemo(() => (target.mode === 'pixels' ? new PixelPreview(target.target) : null), [target]);
  const smartPreview = useMemo(() => (target.mode === 'smart' ? new SmartFilterPreview(target.layer.id, def.id) : null), [target, def.id]);
  const fctx = useMemo(
    () =>
      target.mode === 'pixels'
        ? targetFilterContext(target.target)
        : makeFilterContext({ docWidth: target.doc.width, docHeight: target.doc.height }),
    [target],
  );
  const needsHistogram = HISTOGRAM_IDS.has(def.id);
  const histogram = useMemo(() => (needsHistogram ? targetHistogram(target, pixelPreview) : null), [needsHistogram, target, pixelPreview]);
  const presets = useMemo(() => presetsFor(def.id), [def.id]);
  const current = matchPreset(def, params, presets);

  /* ---------------- live on-canvas preview (throttled by the cost of the last run) ---------------- */
  const lastMs = useRef(0);
  useEffect(() => {
    if (!live) {
      pixelPreview?.restore();
      smartPreview?.clear();
      return;
    }
    const timer = window.setTimeout(
      () => {
        const t0 = performance.now();
        try {
          pixelPreview?.update((img) => runAdjustment(def, img, params, fctx));
          smartPreview?.update(params);
        } catch (err) {
          console.error('[adjustments] live preview failed', err);
        }
        lastMs.current = performance.now() - t0;
      },
      Math.min(250, lastMs.current * 0.6),
    );
    return () => window.clearTimeout(timer);
  }, [params, live, def, fctx, pixelPreview, smartPreview]);

  // Revert the preview if the dialog goes away without OK (Esc, backdrop click, close button).
  useEffect(
    () => () => {
      if (finished.current) return;
      pixelPreview?.restore();
      smartPreview?.clear();
    },
    [pixelPreview, smartPreview],
  );

  /* ---------------- actions ---------------- */
  const cancel = useCallback(() => {
    if (applying) return;
    finished.current = true;
    pixelPreview?.restore();
    smartPreview?.clear();
    close();
  }, [applying, close, pixelPreview, smartPreview]);

  const ok = useCallback(() => {
    if (applying) return;
    setApplying(true);
    finished.current = true;
    try {
      pixelPreview?.restore();
      smartPreview?.clear();
      const unchanged = IDENTITY_AT_DEFAULTS.has(def.id) && sameParams(def, params, defaults);
      if (!unchanged) {
        if (target.mode === 'pixels') editRasterPixels(target.target, def.name, (img) => runAdjustment(def, img, params, fctx));
        else addSmartFilter(def, params, target.layer.id);
      }
      close('ok');
    } catch (err) {
      console.error('[adjustments] apply failed', err);
      toast(`${def.name} failed: ${(err as Error).message}`, 'error');
      finished.current = false;
      setApplying(false);
    }
  }, [applying, close, def, defaults, fctx, params, pixelPreview, smartPreview, target]);

  const replace = (next: ParamValues) => {
    setParams({ ...defaults, ...structuredClone(next) });
    setEpoch((n) => n + 1);
  };
  const applyPreset = (name: string) => {
    if (name === '__custom') return;
    if (name === 'Default') return replace({});
    const p = presets.find((x) => x.name === name);
    if (p) replace(p.params);
  };
  const auto = () => {
    if (!histogram || !histogram.count) return toast('Nothing to analyse: the layer is empty.', 'info');
    if (def.id === 'levels') {
      const p = autoContrastParams(histogram);
      if (!p) return toast('Levels: the layer already uses its full tonal range.', 'info');
      replace({ ...params, ...p, gamma: 1, outBlack: 0, outWhite: 255 });
    } else {
      const c = autoToneCurves(histogram);
      if (!c) return toast('Curves: the layer already uses its full tonal range.', 'info');
      replace({ curves: c });
    }
  };

  /* ---------------- dialog dragging (by the title bar) ---------------- */
  const onHeadDown = (e: RPointerEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (e.button !== 0 || !el.closest('.ui-dialog-head') || el.closest('button')) return;
    const sx = e.clientX - offset.x,
      sy = e.clientY - offset.y;
    const move = (ev: PointerEvent) => setOffset({ x: ev.clientX - sx, y: ev.clientY - sy });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const Icon = def.icon ?? SlidersHorizontal;
  const layer = target.mode === 'pixels' ? target.target.layer : target.layer;
  const onMask = target.mode === 'pixels' && target.target.kind === 'mask';
  const hasSelection = target.mode === 'pixels' && !!target.target.mask;
  const hint =
    target.mode === 'smart'
      ? `${layer.type === 'text' ? 'Text' : 'Shape'} layers stay editable: added as a Smart Filter.`
      : onMask
        ? `Adjusts the layer mask${hasSelection ? ' inside the selection' : ''}.`
        : layer.type === 'raster' && layer.generator
          ? 'Bakes into the pixels — regenerating this layer will discard it.'
          : `Bakes into the layer pixels${hasSelection ? ' inside the selection' : ''}.`;

  const presetOptions = [
    ...(current === null ? [{ value: '__custom', label: 'Custom' }] : []),
    { value: 'Default', label: 'Default' },
    ...presets.map((p) => ({ value: p.name, label: p.name })),
  ];

  return (
    <div className="adjustments-dialog" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }} onPointerDownCapture={onHeadDown}>
      <Dialog
        title={
          <span className="adjustments-dialog-title">
            <Icon size={15} strokeWidth={1.75} />
            {def.name}
            <span className="target">{onMask ? `${layer.name} · mask` : layer.name}</span>
          </span>
        }
        width={DIALOG_W}
        onClose={cancel}
        onSubmit={ok}
        footer={
          <div className="adjustments-dialog-foot">
            <Checkbox checked={live} onChange={setLive} label="Preview" title="Live preview on the canvas" />
            <span className="adjustments-dialog-hint" title={hint}>
              {hint}
            </span>
            <Button onClick={cancel} disabled={applying}>
              Cancel
            </Button>
            <Button variant="primary" onClick={ok} disabled={applying}>
              OK
            </Button>
          </div>
        }
      >
        <div className="adjustments-dialog-body">
          <div className="adjustments-preset-row">
            <span className="ui-label">Preset</span>
            <Select value={current ?? '__custom'} options={presetOptions} onChange={applyPreset} width="100%" title="Adjustment preset" />
            {needsHistogram && (
              <Button size="small" icon={WandSparkles} onClick={auto} title="Compute automatically from the histogram">
                Auto
              </Button>
            )}
            <Button size="small" icon={RotateCcw} onClick={() => replace({})} title="Reset to defaults" aria-label="Reset to defaults" />
          </div>
          <AdjustmentParams
            key={epoch}
            def={def}
            values={params}
            onChange={setParams}
            onCommit={setParams}
            histogram={needsHistogram ? histogram : null}
            width={CONTENT_W}
          />
        </div>
      </Dialog>
    </div>
  );
}
