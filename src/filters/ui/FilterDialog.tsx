/**
 * Filter dialog: parameter editor + in-dialog preview (fit / 100%, before/after) + live
 * on-canvas preview through the store's preview() (see livePreview.ts).
 *
 * In-dialog preview geometry matches what OK produces:
 *  - destructive: the layer's own pixels (or its mask) in local space, limited to the selection;
 *    the 100% view is cropped from the full-resolution result (computed once per settings and
 *    reused by OK);
 *  - smart: rendered by the compositor in document space exactly like the canvas (same padding,
 *    image box and stacking on top of the existing smart filters), cropped to the layer bounds.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Eye, LoaderCircle, RotateCcw, SquareSplitHorizontal, WandSparkles } from 'lucide-react';
import type { Layer, ParamValue, ParamValues, Rect } from '../../core/types';
import { uid } from '../../core/ids';
import { filters, type FilterDef } from '../../registry';
import { defaultParams } from '../engine';
import { Button, Checkbox, Dialog, IconButton, ParamEditor } from '../../ui/controls';
import {
  applyDestructive,
  applySmart,
  cropImageData,
  effectiveMode,
  lastModeFor,
  noChangeMessage,
  runDestructiveOn,
  selectionAlpha,
  targetSource,
  type ApplyMode,
  type FilterTarget,
} from './apply';
import { diffBounds } from './selectionBlend';
import { DestructivePreview, MaskPreview, SmartPreview } from './livePreview';
import { cropCanvas, fitImage, paramsKey } from './preview';
import { rememberParams, rememberedParams, setLastFilter } from './memory';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { getLayerBounds, renderLayerToDoc } from '../../render/compositor';
import './fxfilters.css';

const BOX_W = 480;
const BOX_H = 360;
const DIALOG_W = 860;

export interface FilterDialogProps extends Record<string, unknown> {
  filterId: string;
  mode: 'auto' | ApplyMode;
  target: FilterTarget;
  /** Optional starting params (e.g. from the Filter Gallery). */
  initialParams?: ParamValues;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smart-mode frame: the layer's document bounds clipped to the canvas (doc px, integer). */
function smartFrameOf(t: FilterTarget): Rect {
  const doc = t.doc;
  let b: Rect | null = null;
  try {
    b = getLayerBounds(doc, t.layer.id);
  } catch {
    b = null;
  }
  if (!b) b = { x: 0, y: 0, width: doc.width, height: doc.height };
  const x0 = Math.max(0, Math.floor(b.x)),
    y0 = Math.max(0, Math.floor(b.y));
  const x1 = Math.min(doc.width, Math.ceil(b.x + b.width)),
    y1 = Math.min(doc.height, Math.ceil(b.y + b.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    return { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.max(1, Math.ceil(b.width)), height: Math.max(1, Math.ceil(b.height)) };
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** 100% view window (frame-relative px) centred on the focus fraction. */
function windowRect(fw: number, fh: number, focus: { x: number; y: number }): Rect {
  const w = Math.min(BOX_W, fw),
    h = Math.min(BOX_H, fh);
  const x = Math.round(Math.max(0, Math.min(fw - w, focus.x * fw - w / 2)));
  const y = Math.round(Math.max(0, Math.min(fh - h, focus.y * fh - h / 2)));
  return { x, y, width: w, height: h };
}

/** Canvas → ImageData of its full area. */
function canvasData(c: HTMLCanvasElement): ImageData {
  return cropCanvas(c, 0, 0, c.width, c.height);
}

/**
 * Start the dialog beside the filtered layer (on the side of the screen it doesn't occupy), so
 * the live on-canvas preview stays visible.
 */
function initialOffset(target: FilterTarget): { x: number; y: number } {
  const room = Math.max(0, Math.round((window.innerWidth - DIALOG_W) / 2) - 12);
  let side = 1;
  try {
    const b = target.kind === 'content' ? getLayerBounds(target.doc, target.layer.id) : null;
    const el = viewport.element();
    if (b && el) {
      const r = el.getBoundingClientRect();
      const c = viewport.docToScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      if (r.left + c.x > window.innerWidth / 2) side = -1;
    }
  } catch {
    /* viewport not mounted: default to the right */
  }
  return { x: room * side, y: 0 };
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
  const [offset, setOffset] = useState(() => initialOffset(target));
  /** Centre of the 100% view as a fraction of the frame. */
  const [focus, setFocus] = useState({ x: 0.5, y: 0.5 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const finished = useRef(false);
  const applyMode: ApplyMode = smart ? 'smart' : 'destructive';
  const canToggle = target.canSmart && target.canDestructive;
  const key = paramsKey(filterId, params);

  /* ---------------- sources & frames ---------------- */
  // raw local pixels (layer bitmap or mask) for destructive application
  const localSrc = useMemo(() => (target.canDestructive ? targetSource(target, 'destructive') : null), [target]);
  const smartFrame = useMemo(() => smartFrameOf(target), [target]);
  const frame: Rect = applyMode === 'destructive' && localSrc ? { x: 0, y: 0, width: localSrc.width, height: localSrc.height } : smartFrame;

  // destructive: fitted base (+ selection) and full-resolution source (+ selection), lazily
  const fitBase = useRef<{ img: ImageData; k: number; sel: Uint8ClampedArray | null } | null>(null);
  const fullBase = useRef<{ img: ImageData; sel: Uint8ClampedArray | null } | null>(null);
  const fitAfter = useRef<{ key: string; img: ImageData } | null>(null);
  /** Full-resolution destructive result for one settings key (shared by the 100% view and OK). */
  const fullAfter = useRef<{ key: string; out: ImageData; rect: Rect | null } | null>(null);

  const getFitBase = useCallback(() => {
    if (!fitBase.current && localSrc) {
      const f = fitImage(localSrc, BOX_W, BOX_H);
      fitBase.current = { img: f.img, k: f.k, sel: selectionAlpha(target, f.img.width, f.img.height, f.k) };
    }
    return fitBase.current!;
  }, [localSrc, target]);
  const getFullBase = useCallback(() => {
    if (!fullBase.current && localSrc) {
      const img = canvasData(localSrc);
      fullBase.current = { img, sel: selectionAlpha(target, img.width, img.height, 1) };
    }
    return fullBase.current!;
  }, [localSrc, target]);
  const getFullAfter = useCallback(
    (k: string, p: ParamValues) => {
      if (fullAfter.current?.key !== k) {
        const b = getFullBase();
        const out = runDestructiveOn(def, p, target, b.img, 1, 0, 0, b.sel);
        fullAfter.current = { key: k, out, rect: diffBounds(b.img.data, out.data, out.width, out.height) };
      }
      return fullAfter.current;
    },
    [def, getFullBase, target],
  );

  // smart: compositor renders (doc space) of the layer with / without the new filter
  const previewInstId = useMemo(() => uid('fxdlg_'), []);
  const layerWith = useCallback(
    (p: ParamValues): Layer => ({ ...target.layer, filters: [...target.layer.filters, { id: previewInstId, filterId, enabled: true, params: structuredClone(p) }] }) as Layer,
    [filterId, previewInstId, target.layer],
  );
  const smartRender = useCallback(
    (layer: Layer, scale: number) => {
      try {
        return renderLayerToDoc(target.doc, layer, { scale, effects: false, mask: false });
      } catch (err) {
        console.error('[fx-filters] preview render failed', err);
        return null;
      }
    },
    [target.doc],
  );
  const smartBefore = useRef(new Map<number, HTMLCanvasElement | null>());
  const smartAfterFull = useRef<{ key: string; canvas: HTMLCanvasElement | null } | null>(null);
  const smartFitK = Math.min(1, BOX_W / smartFrame.width, BOX_H / smartFrame.height);
  const getSmartBefore = useCallback(
    (scale: number) => {
      if (!smartBefore.current.has(scale)) smartBefore.current.set(scale, smartRender(target.layer, scale));
      return smartBefore.current.get(scale) ?? null;
    },
    [smartRender, target.layer],
  );
  /** Crop a doc-space render at `scale` to a doc rect (transparent when the render is empty). */
  const cropDoc = (c: HTMLCanvasElement | null, r: Rect, scale: number): ImageData => {
    const w = Math.max(1, Math.round(r.width * scale)),
      h = Math.max(1, Math.round(r.height * scale));
    if (!c) return new ImageData(w, h);
    return cropCanvas(c, Math.round(r.x * scale), Math.round(r.y * scale), w, h);
  };

  /** Is the current view's "after" image already computed (cheap to show)? */
  const viewReady = (): boolean => {
    if (!zoom100) return false;
    return applyMode === 'destructive' ? fullAfter.current?.key === key : smartAfterFull.current?.key === key;
  };

  /** The preview image for the current view. */
  const computeView = (showBefore: boolean): ImageData => {
    if (applyMode === 'destructive' && localSrc) {
      if (!zoom100) {
        const b = getFitBase();
        if (showBefore) return b.img;
        if (fitAfter.current?.key !== key) fitAfter.current = { key, img: runDestructiveOn(def, params, target, b.img, b.k, 0, 0, b.sel) };
        return fitAfter.current.img;
      }
      const win = windowRect(frame.width, frame.height, focus);
      return cropImageData(showBefore ? getFullBase().img : getFullAfter(key, params).out, win);
    }
    if (!zoom100) {
      if (showBefore) return cropDoc(getSmartBefore(smartFitK), smartFrame, smartFitK);
      return cropDoc(smartRender(layerWith(params), smartFitK), smartFrame, smartFitK);
    }
    const win = windowRect(smartFrame.width, smartFrame.height, focus);
    const r = { x: smartFrame.x + win.x, y: smartFrame.y + win.y, width: win.width, height: win.height };
    if (showBefore) return cropDoc(getSmartBefore(1), r, 1);
    if (smartAfterFull.current?.key !== key) smartAfterFull.current = { key, canvas: smartRender(layerWith(params), 1) };
    return cropDoc(smartAfterFull.current.canvas, r, 1);
  };

  /* ---------------- in-dialog preview rendering ---------------- */
  const raf = useRef(0);
  const heavyTimer = useRef<number | undefined>(undefined);
  /** Time the last "after" preview took (drives the live preview delay). */
  const previewMs = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    window.clearTimeout(heavyTimer.current);
    const showBefore = before || holding;
    const run = () => {
      const cv = canvasRef.current;
      if (!cv) return;
      const t0 = performance.now();
      let img: ImageData;
      try {
        img = computeView(showBefore);
      } catch (err) {
        console.error('[fx-filters] preview failed', err);
        setBusy(false);
        return;
      }
      if (cv.width !== img.width || cv.height !== img.height) {
        cv.width = img.width;
        cv.height = img.height;
      }
      cv.getContext('2d')!.putImageData(img, 0, 0);
      const ms = performance.now() - t0;
      if (!showBefore && !zoom100) previewMs.current = ms;
      if (!showBefore) setSlow(ms > 90);
      setBusy(false);
    };
    if (zoom100 && !showBefore && !viewReady()) {
      // full-resolution result: wait until the settings stop changing, show the spinner meanwhile
      setBusy(true);
      setSlow(true);
      heavyTimer.current = window.setTimeout(run, 180);
    } else {
      setBusy(true);
      raf.current = requestAnimationFrame(run);
    }
    return () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(heavyTimer.current);
    };
    // computeView reads everything below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, applyMode, zoom100, focus, before, holding]);

  /* ---------------- live on-canvas preview ---------------- */
  const smartPrev = useMemo(() => new SmartPreview(target.layer.id, filterId), [target.layer.id, filterId]);
  const destPrev = useMemo(() => (target.kind === 'content' && target.canDestructive && localSrc ? new DestructivePreview(target, localSrc) : null), [target, localSrc]);
  const maskPrev = useMemo(() => (target.kind === 'mask' && localSrc ? new MaskPreview(target, localSrc) : null), [target, localSrc]);
  const liveTimer = useRef<number | undefined>(undefined);
  const lastLiveMs = useRef(0);
  const clearLive = useCallback(() => {
    window.clearTimeout(liveTimer.current);
    smartPrev.clear();
    destPrev?.clear();
    maskPrev?.clear();
  }, [destPrev, maskPrev, smartPrev]);

  useEffect(() => {
    window.clearTimeout(liveTimer.current);
    if (!live) {
      clearLive();
      return;
    }
    // one preview at a time (each clear() reverts the store's preview state)
    if (smart) {
      destPrev?.clear();
      maskPrev?.clear();
    } else smartPrev.clear();
    // the renderer computes at view scale; pace updates by how heavy the filter is
    const isMask = !smart && target.kind === 'mask';
    const delay = isMask ? Math.min(600, 80 + lastLiveMs.current * 1.2) : Math.min(300, 30 + previewMs.current * 1.5);
    liveTimer.current = window.setTimeout(() => {
      const t0 = performance.now();
      try {
        if (smart) smartPrev.update(params);
        else if (target.kind === 'mask') maskPrev?.update(def, params);
        else destPrev?.update(def, params);
      } catch (err) {
        console.error('[fx-filters] live preview failed', err);
      }
      lastLiveMs.current = performance.now() - t0;
    }, delay);
    return () => window.clearTimeout(liveTimer.current);
  }, [params, smart, live, smartPrev, destPrev, maskPrev, def, target.kind, clearLive]);

  // revert previews if the dialog goes away without OK (Esc, close button); release the internal filter
  useEffect(
    () => () => {
      window.clearTimeout(liveTimer.current);
      if (!finished.current) {
        smartPrev.clear();
        maskPrev?.clear();
      }
      destPrev?.dispose();
      maskPrev?.dispose();
    },
    [smartPrev, destPrev, maskPrev],
  );

  /* ---------------- actions ---------------- */
  const cancel = useCallback(() => {
    if (applying) return;
    finished.current = true;
    clearLive();
    close();
  }, [applying, clearLive, close]);

  const ok = useCallback(() => {
    if (applying) return;
    setApplying(true);
    window.clearTimeout(liveTimer.current);
    window.clearTimeout(heavyTimer.current);
    // let the "Applying…" state paint before a potentially long full-resolution run
    window.setTimeout(() => {
      try {
        // previews must be reverted before committing (commit builds on the current state)
        clearLive();
        if (smart) applySmart(def, params, target.layer.id);
        else {
          const pre = fullAfter.current?.key === key ? fullAfter.current : undefined;
          const done = applyDestructive(def, params, target, pre ? { out: pre.out, rect: pre.rect } : undefined);
          if (!done) toast(noChangeMessage(def, target), 'warning');
        }
        finished.current = true;
        rememberParams(filterId, params);
        setLastFilter({ filterId, params, mode: lastModeFor(target, smart ? 'smart' : 'destructive') });
        close('ok');
      } catch (err) {
        console.error('[fx-filters] apply failed', err);
        toast(`${def.name} failed: ${(err as Error).message}`, 'error');
        setApplying(false);
      }
    }, 20);
  }, [applying, clearLive, close, def, filterId, key, params, smart, target]);

  /**
   * Enter: OK — except on a focused button (activate that button, as the browser would) or a
   * select (let it open). Text fields have already been committed by the Dialog.
   */
  const submit = useCallback(() => {
    const a = document.activeElement;
    if (a instanceof HTMLButtonElement) {
      if (!a.disabled) a.click();
      return;
    }
    if (a instanceof HTMLSelectElement) return;
    ok();
  }, [ok]);

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
    const fw = Math.max(1, frame.width),
      fh = Math.max(1, frame.height);
    const move = (ev: PointerEvent) => {
      if (!zoom100) return;
      setFocus({ x: clamp01(f0.x - (ev.clientX - startX) / fw), y: clamp01(f0.y - (ev.clientY - startY) / fh) });
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
      if (cv) {
        const r = cv.getBoundingClientRect();
        setFocus({ x: clamp01((e.clientX - r.left) / Math.max(1, r.width)), y: clamp01((e.clientY - r.top) / Math.max(1, r.height)) });
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
            <span className="fxf-title-target">{target.kind === 'mask' ? `Layer mask of “${target.layer.name}”` : target.layer.name}</span>
          </span>
        }
        width={DIALOG_W}
        onClose={cancel}
        onSubmit={submit}
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
                {frame.width} × {frame.height}px{target.doc.selection && applyMode === 'destructive' ? ' · selection' : ''}
              </span>
            </div>
            {def.description && <p className="fxf-desc">{def.description}</p>}
          </div>
          <div className="fxf-params">
            {def.params.length ? <ParamEditor defs={def.params} values={params} onChange={onChange} /> : <div className="fxf-empty">This filter has no settings.</div>}
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
