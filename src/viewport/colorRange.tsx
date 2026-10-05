/**
 * Select ▸ Color Range.
 *
 * When the canvas viewport is mounted this is a NON-MODAL floating panel over the canvas: while
 * it is open, clicking the canvas samples colors with an eyedropper (Shift adds, Alt subtracts)
 * and the would-be selection is previewed live on the canvas (quick mask / grayscale / mattes)
 * and in the panel thumbnail. Without a viewport (e.g. panel harness) the same UI opens as a
 * modal dialog that samples from its thumbnail.
 *
 * Fuzziness/preset changes are evaluated at preview resolution (fast); OK evaluates the full
 * resolution composite once and commits one undoable "Color Range" selection step.
 */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Minus, Pipette, Plus, X } from 'lucide-react';
import type { Document } from '../core/types';
import type { ToolPointerEvent } from '../registry';
import { createCanvas, ctx2d } from '../core/canvas';
import type { SelectionMode } from '../editor/selection';
import { viewport } from '../editor/viewport';
import { renderDocument } from '../render/compositor';
import { activeDoc, toolOptions, useEditor } from '../state/editor';
import { openDialog, toast, useUI } from '../state/ui';
import { isTypingTarget } from '../ui/shortcuts';
import { settleTransform } from './transform/controller';
import { Button, Checkbox, Dialog, IconButton, Select, Slider } from '../ui/controls';
import { colorRangeWeights, type ColorRangeParams, type ColorRangePreset } from './math/colorRange';
import { averageColor, hexToRgb, rgbToHex } from './math/color';
import { commitAlphaSelection, readComposite } from './selectOps';
import { CURSORS } from './draw';
import { setInputOverride, vpState, type InputOverride } from './state';
import './viewport.css';

type Rgb = { r: number; g: number; b: number };
export type CanvasPreview = 'none' | 'quickmask' | 'grayscale' | 'black' | 'white';
type Picker = 'pick' | 'add' | 'subtract';

const RANGE_OPTIONS: { value: ColorRangePreset; label: string }[] = [
  { value: 'sampled', label: 'Sampled Colors' },
  { value: 'reds', label: 'Reds' },
  { value: 'yellows', label: 'Yellows' },
  { value: 'greens', label: 'Greens' },
  { value: 'cyans', label: 'Cyans' },
  { value: 'blues', label: 'Blues' },
  { value: 'magentas', label: 'Magentas' },
  { value: 'highlights', label: 'Highlights' },
  { value: 'midtones', label: 'Midtones' },
  { value: 'shadows', label: 'Shadows' },
  { value: 'skin', label: 'Skin Tones' },
];

const PREVIEW_OPTIONS: { value: CanvasPreview; label: string }[] = [
  { value: 'quickmask', label: 'Quick Mask' },
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'black', label: 'Black Matte' },
  { value: 'white', label: 'White Matte' },
  { value: 'none', label: 'None' },
];

/** Long side of the preview-resolution buffers. */
const PREVIEW_MAX = 720;
const THUMB_W = 216;
const THUMB_H = 160;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface CRState {
  open: boolean;
  /** 'panel' = floating over the canvas, 'dialog' = modal fallback. */
  host: 'panel' | 'dialog' | null;
  preset: ColorRangePreset;
  samples: Rgb[];
  negatives: Rgb[];
  fuzziness: number;
  invert: boolean;
  mode: SelectionMode;
  picker: Picker;
  canvasPreview: CanvasPreview;
  thumbView: 'selection' | 'image';
  hover: string | null;
  /** Panel position (CSS px inside the viewport); null = default (top-right). */
  pos: { x: number; y: number } | null;
  /** Bumped when the sampling source is rebuilt (document changed). */
  srcRev: number;
}

export const useColorRange = create<CRState>()(() => ({
  open: false,
  host: null,
  preset: 'sampled',
  samples: [],
  negatives: [],
  fuzziness: 40,
  invert: false,
  mode: 'new',
  picker: 'pick',
  canvasPreview: 'quickmask',
  thumbView: 'selection',
  hover: null,
  pos: null,
  srcRev: 0,
}));

interface Source {
  doc: Document;
  full: Uint8ClampedArray;
  w: number;
  h: number;
  preview: Uint8ClampedArray;
  pw: number;
  ph: number;
  /** Preview-resolution composite. */
  image: HTMLCanvasElement;
}

let source: Source | null = null;

function buildSource(doc: Document): Source | null {
  let comp: HTMLCanvasElement;
  try {
    comp = renderDocument(doc);
  } catch (err) {
    console.error('[color range] render failed', err);
    return null;
  }
  const s = Math.min(1, PREVIEW_MAX / Math.max(doc.width, doc.height));
  const pw = Math.max(1, Math.round(doc.width * s));
  const ph = Math.max(1, Math.round(doc.height * s));
  const image = createCanvas(pw, ph);
  const ictx = ctx2d(image);
  ictx.imageSmoothingQuality = 'high';
  ictx.drawImage(comp, 0, 0, pw, ph);
  return {
    doc,
    full: readComposite(comp, doc.width, doc.height),
    w: doc.width,
    h: doc.height,
    preview: readComposite(comp, pw, ph),
    pw,
    ph,
    image,
  };
}

function params(st: CRState = useColorRange.getState()): ColorRangeParams {
  return { preset: st.preset, samples: st.samples, negatives: st.negatives, fuzziness: st.fuzziness, invert: st.invert };
}

/* ---------------- preview buffers (cached per params) ---------------- */

let previewKey = '';
let previewAlpha: Uint8ClampedArray | null = null;
const overlayCache: { key: string; canvas: HTMLCanvasElement | null } = { key: '', canvas: null };

function keyOf(st: CRState): string {
  return JSON.stringify([st.srcRev, st.preset, st.samples, st.negatives, st.fuzziness, st.invert]);
}

function currentPreviewAlpha(): Uint8ClampedArray | null {
  if (!source) return null;
  const st = useColorRange.getState();
  const key = keyOf(st);
  if (previewAlpha && key === previewKey) return previewAlpha;
  const p = params(st);
  previewAlpha = p.preset === 'sampled' && !p.samples.length && !p.invert ? new Uint8ClampedArray(source.pw * source.ph) : colorRangeWeights(source.preview, source.pw * source.ph, p);
  previewKey = key;
  return previewAlpha;
}

/** Preview-resolution canvas for the on-canvas preview mode (null for 'none'). */
function overlayCanvas(): HTMLCanvasElement | null {
  const st = useColorRange.getState();
  if (!source || st.canvasPreview === 'none') return null;
  const alpha = currentPreviewAlpha();
  if (!alpha) return null;
  const key = `${keyOf(st)}|${st.canvasPreview}`;
  if (overlayCache.key === key && overlayCache.canvas) return overlayCache.canvas;
  const { pw, ph, preview } = source;
  const c = overlayCache.canvas && overlayCache.canvas.width === pw && overlayCache.canvas.height === ph ? overlayCache.canvas : createCanvas(pw, ph);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(pw, ph);
  const d = img.data;
  const mode = st.canvasPreview;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    const a = alpha[i];
    if (mode === 'quickmask') {
      d[j] = 255;
      d[j + 1] = 0;
      d[j + 2] = 0;
      d[j + 3] = (255 - a) >> 1;
    } else if (mode === 'grayscale') {
      d[j] = d[j + 1] = d[j + 2] = a;
      d[j + 3] = 255;
    } else {
      const bg = mode === 'white' ? 255 : 0;
      const k = a / 255;
      d[j] = preview[j] * k + bg * (1 - k);
      d[j + 1] = preview[j + 1] * k + bg * (1 - k);
      d[j + 2] = preview[j + 2] * k + bg * (1 - k);
      d[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  overlayCache.key = key;
  overlayCache.canvas = c;
  return c;
}

/* ---------------- sampling ---------------- */

function sampleAt(x: number, y: number): Rgb | null {
  if (!source) return null;
  const size = Math.max(1, Number(toolOptions('eyedropper', { sampleSize: 1 }).sampleSize) || 1);
  const c = averageColor(source.full, source.w, source.h, Math.floor(x), Math.floor(y), Math.max(3, size));
  return c ? { r: c.r, g: c.g, b: c.b } : null;
}

function pickerFor(e: { shiftKey: boolean; altKey: boolean }): Picker {
  return e.altKey ? 'subtract' : e.shiftKey ? 'add' : useColorRange.getState().picker;
}

function applySample(c: Rgb, kind: Picker) {
  useColorRange.setState((st) => {
    if (kind === 'add') return { preset: 'sampled', samples: [...st.samples, c].slice(-16) };
    if (kind === 'subtract') return { preset: 'sampled', negatives: [...st.negatives, c].slice(-16) };
    return { preset: 'sampled', samples: [c], negatives: [] };
  });
}

/* ---------------- canvas input override (panel host) ---------------- */

let dragging: { kind: Picker } | null = null;
let lastHover = 0;

const override: InputOverride = {
  id: 'color-range',
  cursor(m) {
    const k = pickerFor(m);
    return k === 'pick' ? CURSORS.eyedropper : CURSORS.crosshairPlus(k === 'add' ? '+' : '-');
  },
  onPointerDown(e: ToolPointerEvent) {
    if (e.button !== 0) return;
    const c = sampleAt(e.docX, e.docY);
    if (!c) return;
    const kind = pickerFor(e);
    dragging = { kind };
    applySample(c, kind);
  },
  onPointerMove(e) {
    // Dragging with the plain eyedropper scrubs the sampled color live.
    if (!dragging || dragging.kind !== 'pick') return;
    const c = sampleAt(e.docX, e.docY);
    if (c) applySample(c, 'pick');
  },
  onPointerUp() {
    dragging = null;
  },
  onHover(e) {
    const now = performance.now();
    if (now - lastHover < 40) return;
    lastHover = now;
    const c = sampleAt(e.docX, e.docY);
    const hex = c ? rgbToHex(c.r, c.g, c.b) : null;
    if (hex !== useColorRange.getState().hover) useColorRange.setState({ hover: hex });
  },
  renderOverlay(ctx) {
    const doc = activeDoc();
    if (!source || !doc || doc.id !== source.doc.id) return;
    const c = overlayCanvas();
    if (!c) return;
    const p0 = viewport.docToScreen({ x: 0, y: 0 });
    const p1 = viewport.docToScreen({ x: doc.width, y: doc.height });
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.restore();
  },
};

/* ---------------- open / close ---------------- */

let unsubs: (() => void)[] = [];
let rebuildTimer = 0;

function resetSession() {
  const primary = hexToRgb(useEditor.getState().primaryColor);
  useColorRange.setState({
    samples: primary ? [primary] : [],
    negatives: [],
    picker: 'pick',
    hover: null,
    thumbView: 'selection',
  });
}

function teardown() {
  unsubs.forEach((u) => u());
  unsubs = [];
  if (rebuildTimer) window.clearTimeout(rebuildTimer);
  rebuildTimer = 0;
  if (vpState.inputOverride === override) setInputOverride(null);
  dragging = null;
  source = null;
  previewAlpha = null;
  previewKey = '';
  overlayCache.key = '';
  overlayCache.canvas = null;
  viewport.requestOverlay();
}

/** Select ▸ Color Range… */
export async function openColorRange() {
  const doc = activeDoc();
  if (!doc) {
    toast('Open or create a document to use Color Range.', 'info');
    return;
  }
  if (useColorRange.getState().open) return;
  settleTransform();
  source = buildSource(activeDoc() ?? doc);
  if (!source) {
    toast('Could not read the image for Color Range.', 'error');
    return;
  }
  resetSession();
  const host: CRState['host'] = viewport.element() ? 'panel' : 'dialog';
  useColorRange.setState((s) => ({ open: true, host, srcRev: s.srcRev + 1 }));

  // Keep the overlay and sources in sync with the editor.
  unsubs.push(useColorRange.subscribe(() => viewport.requestOverlay()));
  unsubs.push(
    useEditor.subscribe((st, prev) => {
      if (st.activeDocId !== prev.activeDocId) {
        closeColorRange(false);
        return;
      }
      const d = st.activeDocId ? st.sessions[st.activeDocId]?.doc : null;
      if (!d) {
        closeColorRange(false);
        return;
      }
      if (source && d !== source.doc) {
        // The document changed underneath (undo, another panel…): re-sample after it settles.
        if (rebuildTimer) window.clearTimeout(rebuildTimer);
        rebuildTimer = window.setTimeout(() => {
          rebuildTimer = 0;
          const cur = activeDoc();
          if (!cur || !useColorRange.getState().open) return;
          const next = buildSource(cur);
          if (next) {
            source = next;
            useColorRange.setState((s) => ({ srcRev: s.srcRev + 1 }));
          }
        }, 160);
      }
    }),
  );

  if (host === 'panel') {
    setInputOverride(override);
    viewport.requestOverlay();
    return;
  }
  await openDialog(ColorRangeDialog);
  // The modal resolves on close (OK commits inside).
  if (useColorRange.getState().open) closeColorRange(false);
}

/** Close the Color Range UI; `apply` commits the selection first. Returns false if it stays open. */
export function closeColorRange(apply: boolean): boolean {
  const st = useColorRange.getState();
  if (!st.open) return true;
  if (apply && source) {
    const p = params(st);
    if (p.preset === 'sampled' && !p.samples.length && !p.invert) {
      toast('Sample at least one color (click the canvas) or choose a preset range.', 'info');
      return false;
    }
    const alpha = colorRangeWeights(source.full, source.w * source.h, p);
    commitAlphaSelection(alpha, st.mode, 'Color Range');
  }
  useColorRange.setState({ open: false, host: null, hover: null });
  teardown();
  return true;
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function Thumbnail() {
  const st = useColorRange();
  const ref = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: THUMB_W, h: THUMB_H });

  useEffect(() => {
    const c = ref.current;
    if (!c || !source) return;
    const s = Math.min(THUMB_W / source.pw, THUMB_H / source.ph);
    const w = Math.max(1, Math.round(source.pw * s));
    const h = Math.max(1, Math.round(source.ph * s));
    if (w !== dims.w || h !== dims.h) setDims({ w, h });
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = ctx2d(c);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (st.thumbView === 'image') {
      ctx.drawImage(source.image, 0, 0, w, h);
      return;
    }
    const alpha = currentPreviewAlpha();
    if (!alpha) return;
    const g = createCanvas(source.pw, source.ph);
    const gctx = ctx2d(g);
    const img = gctx.createImageData(source.pw, source.ph);
    const d = img.data;
    for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
      d[j] = d[j + 1] = d[j + 2] = alpha[i];
      d[j + 3] = 255;
    }
    gctx.putImageData(img, 0, 0);
    ctx.drawImage(g, 0, 0, w, h);
  }, [st.thumbView, st.preset, st.samples, st.negatives, st.fuzziness, st.invert, st.srcRev, dims.w, dims.h]);

  const docPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!source) return null;
    return { x: ((e.clientX - r.left) / r.width) * source.w, y: ((e.clientY - r.top) / r.height) * source.h };
  };

  return (
    <div className="viewport-cr-preview" style={{ width: THUMB_W, height: THUMB_H }}>
      <canvas
        ref={ref}
        width={dims.w}
        height={dims.h}
        style={{ width: dims.w, height: dims.h }}
        onPointerDown={(e) => {
          const p = docPoint(e);
          const c = p ? sampleAt(p.x, p.y) : null;
          if (c) applySample(c, pickerFor(e));
        }}
        onPointerMove={(e) => {
          const p = docPoint(e);
          const c = p ? sampleAt(p.x, p.y) : null;
          useColorRange.setState({ hover: c ? rgbToHex(c.r, c.g, c.b) : null });
        }}
        onPointerLeave={() => useColorRange.setState({ hover: null })}
      />
    </div>
  );
}

function Controls({ panel }: { panel: boolean }) {
  const st = useColorRange();
  const set = (p: Partial<CRState>) => useColorRange.setState(p);
  return (
    <div className="viewport-cr-side">
      <div className="viewport-dlg-row">
        <span className="ui-label">Select</span>
        <Select value={st.preset} width={140} options={RANGE_OPTIONS} onChange={(v) => set({ preset: v })} />
      </div>
      {st.preset === 'sampled' && (
        <>
          <div className="viewport-dlg-row">
            <span className="ui-label">Eyedropper</span>
            <div className="viewport-seg">
              <IconButton icon={Pipette} size="sm" active={st.picker === 'pick'} title="Sample a color" onClick={() => set({ picker: 'pick' })} />
              <IconButton icon={Plus} size="sm" active={st.picker === 'add'} title="Add to sample (Shift)" onClick={() => set({ picker: 'add' })} />
              <IconButton icon={Minus} size="sm" active={st.picker === 'subtract'} title="Subtract from sample (Alt)" onClick={() => set({ picker: 'subtract' })} />
            </div>
          </div>
          <div className="viewport-dlg-row">
            <span className="ui-label">Fuzziness</span>
            <Slider value={st.fuzziness} min={0} max={200} step={1} onChange={(v) => set({ fuzziness: v })} width={140} />
          </div>
          <div className="viewport-cr-samples">
            {st.samples.map((c, i) => (
              <button
                key={`p${i}`}
                className="viewport-cr-swatch"
                style={{ background: rgbToHex(c.r, c.g, c.b) }}
                title={`Sampled ${rgbToHex(c.r, c.g, c.b)} — click to remove`}
                onClick={() => set({ samples: st.samples.filter((_, j) => j !== i) })}
              />
            ))}
            {st.negatives.map((c, i) => (
              <button
                key={`n${i}`}
                className="viewport-cr-swatch neg"
                style={{ background: rgbToHex(c.r, c.g, c.b) }}
                title={`Excluded ${rgbToHex(c.r, c.g, c.b)} — click to remove`}
                onClick={() => set({ negatives: st.negatives.filter((_, j) => j !== i) })}
              >
                <X size={9} />
              </button>
            ))}
            <Button
              size="small"
              variant="ghost"
              title="Add the foreground color as a sample"
              onClick={() => {
                const c = hexToRgb(useEditor.getState().primaryColor);
                if (c) set({ samples: [...st.samples, c].slice(-16) });
              }}
            >
              + Foreground
            </Button>
          </div>
        </>
      )}
      <Checkbox checked={st.invert} onChange={(v) => set({ invert: v })} label="Invert" />
      <div className="viewport-dlg-row">
        <span className="ui-label">Mode</span>
        <Select
          value={st.mode}
          width={140}
          options={[
            { value: 'new', label: 'New Selection' },
            { value: 'add', label: 'Add to Selection' },
            { value: 'subtract', label: 'Subtract' },
            { value: 'intersect', label: 'Intersect' },
          ]}
          onChange={(v) => set({ mode: v })}
        />
      </div>
      {panel && (
        <div className="viewport-dlg-row">
          <span className="ui-label">Canvas Preview</span>
          <Select value={st.canvasPreview} width={140} options={PREVIEW_OPTIONS} onChange={(v) => set({ canvasPreview: v })} />
        </div>
      )}
    </div>
  );
}

function ThumbFooter() {
  const thumbView = useColorRange((s) => s.thumbView);
  const hover = useColorRange((s) => s.hover);
  return (
    <div className="viewport-dlg-row" style={{ marginTop: 8 }}>
      <div className="viewport-seg viewport-seg-text">
        <button className={`viewport-seg-btn${thumbView === 'selection' ? ' active' : ''}`} onClick={() => useColorRange.setState({ thumbView: 'selection' })}>
          Selection
        </button>
        <button className={`viewport-seg-btn${thumbView === 'image' ? ' active' : ''}`} onClick={() => useColorRange.setState({ thumbView: 'image' })}>
          Image
        </button>
      </div>
      <span className="viewport-dlg-note" style={{ marginLeft: 'auto' }}>
        {hover ? (
          <>
            <span className="viewport-cr-chip" style={{ background: hover }} /> {hover}
          </>
        ) : (
          'Hover to inspect'
        )}
      </span>
    </div>
  );
}

/** Another piece of UI that owns Enter/Escape is open (dialog, command palette, menu, popover). */
function otherUiOwnsKeys(panel: HTMLElement | null): boolean {
  const ui = useUI.getState();
  if (ui.dialogs.length > 0 || ui.commandPaletteOpen) return true;
  for (const el of document.querySelectorAll('[role="menu"], [role="dialog"], .ui-menu, .ui-popover')) {
    if (!panel?.contains(el)) return true;
  }
  return false;
}

/**
 * Whether a key event is aimed at the Color Range panel: it comes from inside the panel, or focus
 * rests on the canvas / nothing in particular. Keys typed into other UI (a layer rename field,
 * the command palette, a dialog, a menu…) are left alone.
 */
export function keyTargetsPanel(e: KeyboardEvent, panel: HTMLElement | null): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const t = e.target instanceof Node ? e.target : null;
  if (panel && t && panel.contains(t)) return !otherUiOwnsKeys(panel);
  if (otherUiOwnsKeys(panel)) return false;
  const ae = document.activeElement;
  if (!ae || ae === document.body || ae === document.documentElement) return true;
  if (isTypingTarget(ae)) return false;
  const vp = viewport.element();
  return !!vp && vp.contains(ae);
}

/**
 * Escape cancels and Enter commits while the panel is open. Capture phase, so the panel (which
 * floats over the canvas) wins over canvas tool shortcuts — but only for keys aimed at it.
 */
function useKeys(active: boolean, panelRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      const panel = panelRef.current;
      if (!keyTargetsPanel(e, panel)) return;
      const t = e.target as HTMLElement | null;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeColorRange(false);
        return;
      }
      // Enter on a focused button inside the panel activates that button (e.g. Cancel).
      if (t && panel?.contains(t) && (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      e.stopPropagation();
      // Commit a value typed into a field (fuzziness) before applying.
      const ae = document.activeElement as HTMLElement | null;
      if (ae && panel?.contains(ae)) ae.blur();
      closeColorRange(true);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [active, panelRef]);
}

/** Floating, draggable, non-modal panel rendered inside the viewport. */
export function ColorRangePanel() {
  const open = useColorRange((s) => s.open && s.host === 'panel');
  const pos = useColorRange((s) => s.pos);
  const ref = useRef<HTMLDivElement>(null);
  useKeys(open, ref);

  // Keep the panel inside the viewport when it (or the viewport) resizes.
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const fix = () => {
      const p = useColorRange.getState().pos;
      if (!p) return;
      const x = Math.max(8, Math.min(p.x, parent.clientWidth - el.offsetWidth - 8));
      const y = Math.max(8, Math.min(p.y, parent.clientHeight - el.offsetHeight - 8));
      if (x !== p.x || y !== p.y) useColorRange.setState({ pos: { x, y } });
    };
    const ro = new ResizeObserver(fix);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [open]);

  if (!open) return null;

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    e.preventDefault();
    const pr = parent.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const off = { x: e.clientX - er.left, y: e.clientY - er.top };
    const move = (ev: PointerEvent) => {
      const x = Math.max(8, Math.min(ev.clientX - pr.left - off.x, pr.width - er.width - 8));
      const y = Math.max(8, Math.min(ev.clientY - pr.top - off.y, pr.height - er.height - 8));
      useColorRange.setState({ pos: { x, y } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y } : { right: 12, top: 12 };
  return (
    <div ref={ref} className="ui-dialog viewport-crp" style={style} data-viewport-ui="" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ui-dialog-head viewport-crp-head" onPointerDown={startDrag}>
        <span style={{ flex: 1 }}>Color Range</span>
        <button className="ui-icon-btn" onClick={() => closeColorRange(false)} title="Cancel (Esc)">
          <X size={15} />
        </button>
      </div>
      <div className="ui-dialog-body viewport-crp-body">
        <div className="viewport-cr">
          <div>
            <Thumbnail />
            <ThumbFooter />
          </div>
          <Controls panel />
        </div>
      </div>
      <div className="ui-dialog-foot viewport-crp-foot">
        <span className="viewport-dlg-note viewport-crp-hint">Click the canvas to sample · Shift adds · Alt subtracts · Space pans</span>
        <Button onClick={() => closeColorRange(false)}>Cancel</Button>
        <Button variant="primary" onClick={() => closeColorRange(true)}>
          OK
        </Button>
      </div>
    </div>
  );
}

/** Modal fallback (no canvas viewport mounted). Closes itself when the session ends. */
export function ColorRangeDialog({ close }: { close: (r?: boolean) => void }) {
  const open = useColorRange((s) => s.open);
  useEffect(() => {
    if (!open) close();
  }, [open, close]);
  return (
    <Dialog
      title="Color Range"
      width={600}
      onClose={() => closeColorRange(false)}
      onSubmit={() => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        closeColorRange(true);
      }}
      footer={
        <>
          <Button onClick={() => closeColorRange(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => closeColorRange(true)}>
            OK
          </Button>
        </>
      }
    >
      <div className="viewport-cr">
        <div>
          <Thumbnail />
          <ThumbFooter />
        </div>
        <Controls panel={false} />
      </div>
      <div className="viewport-dlg-note" style={{ marginTop: 10 }}>
        White areas in the preview will be selected. Click the preview to sample; Shift-click adds colors, Alt-click removes them.
      </div>
    </Dialog>
  );
}
