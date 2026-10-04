/**
 * Filter dialog: parameter editor + in-dialog preview (fit / 100%, before/after) + live
 * on-canvas preview (smart-filter preview or exact destructive preview in the bitmap).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Eye, LoaderCircle, RotateCcw, SquareSplitHorizontal, WandSparkles } from 'lucide-react';
import type { ParamValue, ParamValues } from '../../core/types';
import { filters, type FilterDef } from '../../registry';
import { defaultParams } from '../engine';
import { Button, Checkbox, Dialog, IconButton, ParamEditor } from '../../ui/controls';
import {
  BitmapPreview,
  SmartPreview,
  applySmart,
  effectiveMode,
  selectionAlpha,
  targetBitmapId,
  targetContext,
  targetSource,
  type ApplyMode,
  type FilterTarget,
} from './apply';
import { blendSelection } from './selectionBlend';
import { cropCanvas, fitImage, paramsKey, runOnCopy } from './preview';
import { rememberParams, rememberedParams, setLastFilter } from './memory';
import { toast } from '../../state/ui';
import './fxfilters.css';

const BOX_W = 480;
const BOX_H = 360;

export interface FilterDialogProps extends Record<string, unknown> {
  filterId: string;
  mode: 'auto' | ApplyMode;
  target: FilterTarget;
  /** Optional starting params (e.g. from the Filter Gallery). */
  initialParams?: ParamValues;
}

interface Base {
  img: ImageData;
  /** preview px per local px */
  k: number;
  cropX: number;
  cropY: number;
  sel: Uint8ClampedArray | null;
}

export function FilterDialog({ filterId, mode, target, initialParams, close }: FilterDialogProps & { close: (r?: unknown) => void }) {
  const def = filters.get(filterId) as FilterDef;
  const [params, setParams] = useState<ParamValues>(() => ({ ...rememberedParams(def), ...(initialParams ?? {}) }));
  const startMode = effectiveMode(target, mode);
  const [smart, setSmart] = useState(startMode === 'smart');
  const [live, setLive] = useState(true);
  const [zoom100, setZoom100] = useState(false);
  const [before, setBefore] = useState(false);
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [applying, setApplying] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const finished = useRef(false);
  const applyMode: ApplyMode = smart ? 'smart' : 'destructive';
  const canToggle = target.canSmart && target.canDestructive;

  /* ---------------- sources (snapshotted at open, before any live preview) ---------------- */
  // the destructive source must be captured before the bitmap preview writes into the bitmap
  const [sources] = useState<Partial<Record<ApplyMode, HTMLCanvasElement>>>(() =>
    target.canDestructive ? { destructive: targetSource(target, 'destructive') } : {},
  );
  const getSource = useCallback(
    (m: ApplyMode) => {
      let s = sources[m];
      if (!s) {
        s = targetSource(target, m);
        sources[m] = s;
      }
      return s;
    },
    [sources, target],
  );

  const srcSize = useMemo(() => {
    const s = getSource(applyMode);
    return { w: s.width, h: s.height };
  }, [getSource, applyMode]);
  const [focus, setFocus] = useState(() => ({ x: srcSize.w / 2, y: srcSize.h / 2 }));

  /* ---------------- preview base (fit or 100% crop) ---------------- */
  const fitCache = useRef<Partial<Record<ApplyMode, Base>>>({});
  const cropCache = useRef<{ key: string; base: Base } | null>(null);
  const lastRender = useRef<{ base: Base; key: string; out: ImageData } | null>(null);
  const getBase = useCallback((): Base => {
    const src = getSource(applyMode);
    const useSel = applyMode === 'destructive';
    if (!zoom100) {
      let b = fitCache.current[applyMode];
      if (!b) {
        const f = fitImage(src, BOX_W, BOX_H);
        b = { img: f.img, k: f.k, cropX: 0, cropY: 0, sel: useSel ? selectionAlpha(target, f.img.width, f.img.height, f.k) : null };
        fitCache.current[applyMode] = b;
      }
      return b;
    }
    const w = Math.min(BOX_W, src.width),
      h = Math.min(BOX_H, src.height);
    const cx = Math.round(Math.max(0, Math.min(src.width - w, focus.x - w / 2)));
    const cy = Math.round(Math.max(0, Math.min(src.height - h, focus.y - h / 2)));
    const key = `${applyMode}|${cx},${cy}`;
    if (cropCache.current?.key === key) return cropCache.current.base;
    const base = { img: cropCanvas(src, cx, cy, w, h), k: 1, cropX: cx, cropY: cy, sel: useSel ? selectionAlpha(target, w, h, 1, cx, cy) : null };
    cropCache.current = { key, base };
    return base;
  }, [applyMode, focus, getSource, target, zoom100]);

  /* ---------------- in-dialog preview rendering ---------------- */
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    setBusy(true);
    raf.current = requestAnimationFrame(() => {
      const base = getBase();
      const cv = canvasRef.current;
      if (!cv) return;
      if (cv.width !== base.img.width || cv.height !== base.img.height) {
        cv.width = base.img.width;
        cv.height = base.img.height;
      }
      const ctx = cv.getContext('2d')!;
      if (before || holding) {
        ctx.putImageData(base.img, 0, 0);
        setBusy(false);
        return;
      }
      const key = paramsKey(filterId, params);
      const cached = lastRender.current;
      if (cached && cached.base === base && cached.key === key) {
        ctx.putImageData(cached.out, 0, 0);
        setBusy(false);
        return;
      }
      const fctx = targetContext(target, base.k, base.cropX, base.cropY);
      const { out, ms } = runOnCopy(def, params, base.img, fctx);
      if (base.sel) blendSelection(base.img.data, out.data, base.sel);
      ctx.putImageData(out, 0, 0);
      lastRender.current = { base, key, out };
      setSlow(ms > 90);
      setBusy(false);
    });
    return () => cancelAnimationFrame(raf.current);
  }, [params, getBase, before, holding, def, target, filterId]);

  /* ---------------- live on-canvas preview ---------------- */
  const smartPrev = useMemo(() => new SmartPreview(target.layer.id, filterId), [target.layer.id, filterId]);
  const bmpPrev = useMemo(() => {
    const id = targetBitmapId(target);
    return target.canDestructive && id ? new BitmapPreview(id, target) : null;
  }, [target]);
  const liveTimer = useRef<number | undefined>(undefined);
  const lastLiveMs = useRef(0);

  useEffect(() => {
    window.clearTimeout(liveTimer.current);
    if (!live) {
      smartPrev.clear();
      bmpPrev?.restore();
      return;
    }
    if (smart) bmpPrev?.restore();
    else smartPrev.clear();
    // throttle full-resolution previews by how long the previous one took
    const delay = Math.min(450, 40 + lastLiveMs.current * 0.8);
    liveTimer.current = window.setTimeout(() => {
      const t0 = performance.now();
      try {
        if (smart) smartPrev.update(params);
        else bmpPrev?.update(def, params, paramsKey(filterId, params, 'd'));
      } catch (err) {
        console.error('[fx-filters] live preview failed', err);
      }
      lastLiveMs.current = performance.now() - t0;
    }, delay);
    return () => window.clearTimeout(liveTimer.current);
  }, [params, smart, live, smartPrev, bmpPrev, def, filterId]);

  // revert previews if the dialog goes away without OK (Esc, backdrop click, close button)
  useEffect(
    () => () => {
      window.clearTimeout(liveTimer.current);
      if (!finished.current) {
        smartPrev.clear();
        bmpPrev?.restore();
      }
    },
    [smartPrev, bmpPrev],
  );

  /* ---------------- actions ---------------- */
  const cancel = useCallback(() => {
    if (applying) return;
    finished.current = true;
    window.clearTimeout(liveTimer.current);
    smartPrev.clear();
    bmpPrev?.restore();
    close();
  }, [applying, bmpPrev, close, smartPrev]);

  const ok = useCallback(() => {
    if (applying) return;
    setApplying(true);
    window.clearTimeout(liveTimer.current);
    // let the "Applying…" state paint before a potentially long full-resolution run
    window.setTimeout(() => {
      try {
        if (smart) {
          bmpPrev?.restore();
          smartPrev.clear();
          applySmart(def, params, target.layer.id);
        } else {
          smartPrev.clear();
          const done = bmpPrev ? bmpPrev.commit(def, params, paramsKey(filterId, params, 'd')) : false;
          if (!done) toast('The selection doesn’t overlap this layer — nothing was filtered.', 'warning');
        }
        finished.current = true;
        rememberParams(filterId, params);
        setLastFilter({ filterId, params, mode: smart ? 'smart' : 'destructive' });
        close('ok');
      } catch (err) {
        console.error('[fx-filters] apply failed', err);
        toast(`${def.name} failed: ${(err as Error).message}`, 'error');
        setApplying(false);
      }
    }, 20);
  }, [applying, bmpPrev, close, def, filterId, params, smart, smartPrev, target.layer.id]);

  const onChange = useCallback((_k: string, _v: ParamValue, all: ParamValues) => setParams(all), []);
  const reset = () => setParams(defaultParams(def.params));

  /* ---------------- preview pointer interaction ---------------- */
  const onPreviewDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setHolding(true);
    const startX = e.clientX,
      startY = e.clientY;
    const f0 = focus;
    const move = (ev: PointerEvent) => {
      if (!zoom100) return;
      setFocus({ x: f0.x - (ev.clientX - startX), y: f0.y - (ev.clientY - startY) });
    };
    const up = () => {
      setHolding(false);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onPreviewDouble = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!zoom100) {
      // zoom to 100% at the double-clicked point
      const cv = canvasRef.current;
      const base = fitCache.current[applyMode];
      if (cv && base) {
        const r = cv.getBoundingClientRect();
        setFocus({ x: (e.clientX - r.left) / base.k, y: (e.clientY - r.top) / base.k });
      }
    }
    setZoom100(!zoom100);
  };

  /* ---------------- dialog dragging ---------------- */
  const onHeadDown = (e: RPointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.ui-dialog-head') || t.closest('button')) return;
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

  const Icon = def.icon ?? WandSparkles;
  const hint =
    target.kind === 'mask'
      ? target.destructiveNote
      : !target.canDestructive || !target.canSmart
        ? target.destructiveNote
        : smart
          ? 'Non-destructive: stays editable in the Layers panel.'
          : target.layer.type === 'raster' && target.layer.generator
            ? 'Bakes into the pixels — regenerating this layer will discard it.'
            : 'Bakes the filter into the layer pixels' + (target.doc.selection ? ' inside the selection.' : '.');

  return (
    <div className="fxf-dialog" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }} onPointerDownCapture={onHeadDown}>
      <Dialog
        title={
          <span className="fxf-title">
            <Icon size={15} strokeWidth={1.75} />
            {def.name}
            <span className="fxf-title-target">
              {target.kind === 'mask' ? 'Layer mask' : target.layer.name}
            </span>
          </span>
        }
        width={860}
        onClose={cancel}
        onSubmit={ok}
        footer={
          <div className="fxf-foot">
            <Checkbox checked={live} onChange={setLive} label="Preview" title="Live preview on the canvas" />
            <Checkbox
              checked={smart}
              disabled={!canToggle || applying}
              onChange={setSmart}
              label="Smart Filter (non-destructive)"
              title={canToggle ? 'Keep the filter editable in the Layers panel' : target.destructiveNote}
            />
            <span className="fxf-hint">{hint}</span>
            <Button onClick={reset} disabled={applying} icon={RotateCcw} title="Reset to defaults">
              Reset
            </Button>
            <Button onClick={cancel} disabled={applying}>
              Cancel
            </Button>
            <Button variant="primary" onClick={ok} disabled={applying}>
              {applying ? 'Applying…' : 'OK'}
            </Button>
          </div>
        }
      >
        <div className="fxf-body">
          <div className="fxf-preview-col">
            <div
              className={`fxf-preview${zoom100 ? ' pan' : ''}`}
              style={{ width: BOX_W, height: BOX_H }}
              onPointerDown={onPreviewDown}
              onDoubleClick={onPreviewDouble}
              title={zoom100 ? 'Drag to pan · hold to compare · double-click to fit' : 'Hold to see the original · double-click for 100%'}
            >
              <canvas ref={canvasRef} className="fxf-preview-canvas" />
              {(before || holding) && <span className="fxf-badge">Before</span>}
              {busy && slow && (
                <span className="fxf-spinner">
                  <LoaderCircle size={16} />
                </span>
              )}
            </div>
            <div className="fxf-preview-bar">
              <div className="fxf-seg">
                <button className={!zoom100 ? 'active' : ''} onClick={() => setZoom100(false)}>
                  Fit
                </button>
                <button className={zoom100 ? 'active' : ''} onClick={() => setZoom100(true)}>
                  100%
                </button>
              </div>
              <IconButton icon={before ? Eye : SquareSplitHorizontal} size="sm" active={before} title="Toggle before / after" onClick={() => setBefore(!before)} />
              <span className="fxf-dim">
                {srcSize.w} × {srcSize.h}px{target.doc.selection && applyMode === 'destructive' ? ' · selection' : ''}
              </span>
            </div>
            {def.description && <p className="fxf-desc">{def.description}</p>}
          </div>
          <div className="fxf-params">
            {def.params.length ? (
              <ParamEditor defs={def.params} values={params} onChange={onChange} />
            ) : (
              <div className="fxf-empty">This filter has no settings.</div>
            )}
          </div>
        </div>
        {applying && (
          <div className="fxf-applying">
            <LoaderCircle size={22} />
            <span>Applying {def.name}…</span>
          </div>
        )}
      </Dialog>
    </div>
  );
}
