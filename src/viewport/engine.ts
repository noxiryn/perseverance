/**
 * ViewportEngine — owns the two stacked canvases of <Viewport/> (document + overlay):
 *  - DPR-aware sizing (ResizeObserver, device-pixel content box when available),
 *  - a requestAnimationFrame loop driven by store changes, bitmap touches and explicit requests,
 *  - document drawing (checkerboard, cached composite, shadow, zoom-dependent smoothing),
 *  - overlay drawing (grid, pixel grid, ants, view overlays, guides, tool overlay, smart guides, rulers),
 *  - pointer/wheel input → pan/zoom, ruler guides, and ToolPointerEvent dispatch.
 */
import type { Document, Point, Rect } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { rectUnion } from '../core/geometry';
import { installViewport, viewport } from '../editor/viewport';
import { tools, viewOverlays, type ToolDef, type ToolPointerEvent } from '../registry';
import { onRenderSettle, renderDocumentLive } from '../render/compositor';
import { activeSession, useEditor } from '../state/editor';
import { useUI } from '../state/ui';
import { isTypingTarget } from '../ui/shortcuts';
import { getPref, subscribePrefs } from '../ui/shell/prefs';
import { antsAnimatedThisFrame, resetAntsAnimationFlag } from './outline';
import { drawGrid, drawPixelGrid, drawSelection } from './overlays';
import { drawRulers, rulerAt } from './rulers';
import { beginMoveGuide, beginNewGuide, cancelGuideDrag, drawGuides, endGuideDrag, hitGuide, updateGuideDrag } from './guides';
import { drawSmartGuides } from './snap';
import { normalizePan, wheelZoomFactor } from './math/zoom';
import { activeTransform } from './transform/controller';
import { PERSISTENT_OVERLAY_TOOLS, onInputOverrideChange, vpState, type InputOverride } from './state';

type Drag =
  | { kind: 'pan'; pointerId: number; last: Point }
  | { kind: 'guide'; pointerId: number }
  | { kind: 'tool'; pointerId: number; tool: ToolDef }
  | { kind: 'override'; pointerId: number; override: InputOverride };

/** Default transparency checkerboard square (CSS px); the shell's 'checkerSize' preference overrides it. */
const CHECKER_CELL = 8;
/** Idle time (ms) after the last partial redraw before the document canvas is redrawn whole. */
const SETTLE_MS = 400;
const CHECKER_LIGHT = '#ffffff';
const CHECKER_DARK = '#dedede';

function safe(label: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error(`[viewport] ${label} failed`, err);
  }
}

function hasTransparentBackground(doc: Document): boolean {
  const bg = doc.background;
  if (!bg) return true;
  if (bg.length === 9) return bg.slice(7).toLowerCase() !== 'ff';
  if (bg.length === 5) return bg[4].toLowerCase() !== 'f';
  return bg === 'transparent';
}

export class ViewportEngine {
  private readonly docCtx: CanvasRenderingContext2D;
  private readonly ovCtx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private raf = 0;
  private docPending = true;
  private overlayPending = true;
  private compositeDirty = true;
  /** Live composite (owned by the renderer, updated in place — see renderDocumentLive). */
  private composite: HTMLCanvasElement | null = null;
  private compositeDoc: Document | null = null;
  /** Bumps whenever the composite's pixels change. */
  private compositeGen = 0;
  /** Content version of the live composite last seen (renderDocumentLive `since`). */
  private compositeSeq = -1;
  /** Pending full redraw after partial redraws (see armSettle). */
  private settleTimer = 0;
  /** Part of the composite (composite px) changed since the document canvas was drawn. */
  private compositeChange: Rect | null | 'full' = 'full';
  private scaled: { src: HTMLCanvasElement; k: number; gen: number; dw: number; dh: number; canvas: HTMLCanvasElement } | null = null;
  /** What the document canvas currently shows (a partial redraw needs all of it unchanged). */
  private shown: string | null = null;
  private cursorOverride: string | null = null;
  private appliedCursor = '';
  private antsTimer = 0;
  private checker: { pattern: CanvasPattern; dpr: number; cell: number } | null = null;
  private drag: Drag | null = null;
  private hoverGuide: 'vertical' | 'horizontal' | null = null;
  private lastNative: PointerEvent | null = null;
  private disposers: (() => void)[] = [];
  private mounted = false;

  constructor(
    private readonly root: HTMLDivElement,
    private readonly docCanvas: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
  ) {
    const d = docCanvas.getContext('2d', { alpha: true });
    const o = overlay.getContext('2d', { alpha: true });
    if (!d || !o) throw new Error('2D canvas unavailable');
    this.docCtx = d;
    this.ovCtx = o;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    const r = this.root.getBoundingClientRect();
    this.resize(r.width, r.height);

    installViewport({
      getSize: () => ({ width: this.cssW || this.root.clientWidth || 800, height: this.cssH || this.root.clientHeight || 600 }),
      requestRender: () => this.requestRender(),
      requestOverlay: () => this.requestOverlay(),
      setCursor: (c) => {
        this.cursorOverride = c;
        this.updateCursor();
      },
      element: () => this.root,
    });

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const dev = (e as ResizeObserverEntry & { devicePixelContentBoxSize?: ReadonlyArray<ResizeObserverSize> }).devicePixelContentBoxSize?.[0];
        this.resize(e.contentRect.width, e.contentRect.height, dev ? { w: dev.inlineSize, h: dev.blockSize } : undefined);
      }
    });
    try {
      ro.observe(this.root, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(this.root);
    }
    this.disposers.push(() => ro.disconnect());

    // DPR changes without a size change (moving between monitors) when device-pixel boxes are unsupported.
    let mq: MediaQueryList | null = null;
    const onDpr = () => {
      const rr = this.root.getBoundingClientRect();
      this.resize(rr.width, rr.height);
      watchDpr();
    };
    const watchDpr = () => {
      mq?.removeEventListener('change', onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', onDpr);
    };
    watchDpr();
    this.disposers.push(() => mq?.removeEventListener('change', onDpr));

    this.disposers.push(
      useEditor.subscribe((st, prev) => {
        const a = st.activeDocId ? st.sessions[st.activeDocId] : null;
        const b = prev.activeDocId ? prev.sessions[prev.activeDocId] : null;
        if (st.activeDocId !== prev.activeDocId || a?.doc !== b?.doc || a?.view !== b?.view) this.requestDoc();
        this.requestOverlay();
        if (st.activeTool !== prev.activeTool || st.activeDocId !== prev.activeDocId) this.updateCursor();
      }),
    );
    this.disposers.push(
      useUI.subscribe((st, prev) => {
        if (st.view !== prev.view || st.gridSize !== prev.gridSize) this.requestOverlay();
      }),
    );
    this.disposers.push(
      bitmaps.subscribe(() => {
        this.compositeDirty = true;
        this.requestDoc();
        this.requestOverlay();
      }),
    );
    // Approximate incremental work (GPU canvases) was dropped: re-render it exactly.
    this.disposers.push(onRenderSettle(() => this.requestRender()));
    this.disposers.push(tools.subscribe(() => this.requestOverlay()));
    this.disposers.push(viewOverlays.subscribe(() => this.requestOverlay()));
    this.disposers.push(
      subscribePrefs(() => {
        // Preferences changed (e.g. checkerboard size): rebuild the pattern if it differs.
        if (this.checker && this.checker.cell !== this.checkerCell()) {
          this.checker = null;
          this.requestDoc();
        }
      }),
    );
    this.disposers.push(
      onInputOverrideChange(() => {
        // An override installed/removed mid-gesture: finish the gesture cleanly.
        if (this.drag?.kind === 'override' && vpState.inputOverride !== this.drag.override) {
          this.release(this.drag.pointerId);
          this.drag = null;
        }
        this.updateCursor();
        this.requestOverlay();
      }),
    );

    const ov = this.overlay;
    const opts: AddEventListenerOptions = { passive: false };
    const add = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, o);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, o));
    };
    add(ov, 'pointerdown', this.onPointerDown);
    add(ov, 'pointermove', this.onPointerMove);
    add(ov, 'pointerup', this.onPointerUp);
    add(ov, 'pointercancel', this.onPointerCancel);
    add(ov, 'lostpointercapture', this.onLostCapture);
    add(ov, 'pointerleave', this.onPointerLeave);
    add(ov, 'dblclick', this.onDoubleClick);
    add(ov, 'contextmenu', (e) => e.preventDefault());
    add(this.root, 'wheel', this.onWheel, opts);

    this.updateCursor();
    this.requestRender();
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    if (this.drag?.kind === 'tool') safe('tool pointerup', () => this.drag && this.drag.kind === 'tool' && this.drag.tool.onPointerUp?.(this.syntheticEvent()));
    if (this.drag?.kind === 'override') safe('override pointerup', () => this.drag && this.drag.kind === 'override' && this.drag.override.onPointerUp?.(this.syntheticEvent()));
    if (this.drag?.kind === 'guide') cancelGuideDrag();
    this.drag = null;
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.dropAltReleaseGuard();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.antsTimer) clearTimeout(this.antsTimer);
    this.antsTimer = 0;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = 0;
    installViewport(null);
    this.composite = null;
    this.compositeDoc = null;
    this.scaled = null;
    this.shown = null;
  }

  /* ------------------------------------------------------------------ */
  /* scheduling                                                          */
  /* ------------------------------------------------------------------ */

  requestRender() {
    this.compositeDirty = true;
    this.docPending = true;
    this.overlayPending = true;
    this.schedule();
  }

  requestDoc() {
    this.docPending = true;
    this.overlayPending = true;
    this.schedule();
  }

  requestOverlay() {
    this.overlayPending = true;
    this.schedule();
  }

  private schedule() {
    if (!this.mounted || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    if (!this.mounted) return;
    const s = activeSession();
    if (s && s.view.zoom === 0 && this.cssW > 0 && this.cssH > 0) {
      viewport.fit();
    }
    this.normalizeView();
    if (this.docPending) {
      this.docPending = false;
      safe('document draw', () => this.drawDocument());
    }
    if (this.overlayPending) {
      this.overlayPending = false;
      safe('overlay draw', () => this.drawOverlay());
    }
  };

  /**
   * Keep part of the document on screen (it can never be panned out of reach) and keep the
   * document origin on a device pixel so 100%/200%… views are perfectly crisp.
   */
  private normalizeView() {
    const s = activeSession();
    if (!s || !s.view.zoom || !this.cssW || !this.cssH) return;
    const r = normalizePan(s.view, s.doc.width, s.doc.height, this.cssW, this.cssH, this.dpr);
    if (Math.abs(r.panX - s.view.panX) > 1e-6 || Math.abs(r.panY - s.view.panY) > 1e-6) {
      useEditor.getState().setView({ panX: r.panX, panY: r.panY });
    }
  }

  private resize(cssW: number, cssH: number, dev?: { w: number; h: number }) {
    const w = Math.max(0, cssW);
    const h = Math.max(0, cssH);
    const ratio = window.devicePixelRatio || 1;
    // The exact device-pixel box is preferred (no blur from rounding at fractional DPRs), but it
    // is only trusted when it agrees with devicePixelRatio — some environments (e.g. emulated
    // device scale factors) report CSS-sized boxes, which would render everything at 1x.
    const devOk = !!dev && w > 0 && h > 0 && Math.abs(dev.w / w - ratio) <= 0.25 && Math.abs(dev.h / h - ratio) <= 0.25;
    const devW = Math.max(1, devOk && dev ? dev.w : Math.round(w * ratio));
    const devH = Math.max(1, devOk && dev ? dev.h : Math.round(h * ratio));
    const dpr = w > 0 ? devW / w : ratio;
    if (w === this.cssW && h === this.cssH && devW === this.docCanvas.width && devH === this.docCanvas.height) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr || 1;
    for (const c of [this.docCanvas, this.overlay]) {
      c.width = devW;
      c.height = devH;
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.checker = null;
    this.docPending = true;
    this.overlayPending = true;
    this.schedule();
  }

  /* ------------------------------------------------------------------ */
  /* drawing                                                             */
  /* ------------------------------------------------------------------ */

  private getComposite(doc: Document): HTMLCanvasElement | null {
    if (this.composite && this.compositeDoc === doc && !this.compositeDirty) return this.composite;
    try {
      // The live composite is updated in place: a brush frame re-composites (and reports) only
      // the stroke area, so only that part of the pre-scaled copy and of the screen is redrawn.
      // `since`: changes made through other callers of the live composite are reported too.
      const r = renderDocumentLive(doc, this.composite ? { since: this.compositeSeq } : {});
      this.compositeSeq = r.seq;
      if (r.canvas !== this.composite) {
        this.compositeGen++;
        this.compositeChange = 'full';
      } else if (r.changed) {
        const prevGen = this.compositeGen++;
        const d = r.dirty;
        if (!d || this.compositeChange === 'full') this.compositeChange = 'full';
        else if (d.width > 0 && d.height > 0) {
          const c = this.compositeChange;
          this.compositeChange = c ? rectUnion(c, d) : { ...d };
          // Keep an up-to-date pre-scaled copy up to date (else it is rebuilt when next used).
          const sc = this.scaled;
          if (sc && sc.src === r.canvas && sc.gen === prevGen && this.patchScaled(sc, d)) {
            sc.gen = this.compositeGen;
            this.armSettle();
          }
        }
      }
      this.composite = r.canvas;
    } catch (err) {
      console.error('[viewport] renderDocument failed', err);
      if (this.compositeDoc?.id !== doc.id) this.composite = null;
      this.compositeChange = 'full';
    }
    this.compositeDoc = doc;
    this.compositeDirty = false;
    return this.composite;
  }

  /** Pre-scaled copy rect (scaled px) that a composite change `d` (composite px) affects. */
  private scaledRectOf(d: Rect, f: number, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
    // The minifying filter spreads a composite pixel over its footprint plus ~1 px each side.
    return {
      x0: Math.max(0, Math.floor(d.x * f) - 2),
      y0: Math.max(0, Math.floor(d.y * f) - 2),
      x1: Math.min(w, Math.ceil((d.x + d.width) * f) + 2),
      y1: Math.min(h, Math.ceil((d.y + d.height) * f) + 2),
    };
  }

  /**
   * Redraw the part of the pre-scaled copy a composite change affects (the same draw, clipped).
   * False when that is not exact — the patch reaches the copy's partly covered last column/row
   * (the GPU anti-aliases a quad edge differently when a clip cuts the quad).
   */
  private patchScaled(sc: NonNullable<ViewportEngine['scaled']>, d: Rect): boolean {
    const comp = sc.src;
    const c = sc.canvas;
    const f = this.scaledFactor(sc);
    const r = this.scaledRectOf(d, f, c.width, c.height);
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return true;
    if ((sc.dw % 1 !== 0 && r.x1 > Math.floor(sc.dw)) || (sc.dh % 1 !== 0 && r.y1 > Math.floor(sc.dh))) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.clip();
    ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Exactly the draw getScaled makes, clipped: identical pixels inside the patch.
    ctx.drawImage(comp, 0, 0, comp.width, comp.height, 0, 0, sc.dw, sc.dh);
    ctx.restore();
    return true;
  }

  /** Scaled px per composite px of a pre-scaled copy. */
  private scaledFactor(sc: NonNullable<ViewportEngine['scaled']>): number {
    return sc.dw / Math.max(1, sc.src.width);
  }

  /**
   * High-quality copy of the composite at device scale `k` (< 1), cached per composite canvas +
   * scale (+ content generation; partial composite changes patch it in place). Null when it
   * would be too large (then the composite is drawn directly).
   */
  private getScaled(comp: HTMLCanvasElement, k: number, docW: number, docH: number): HTMLCanvasElement | null {
    const dw = docW * k;
    const dh = docH * k;
    const w = Math.ceil(dw - 1e-6);
    const h = Math.ceil(dh - 1e-6);
    if (w < 1 || h < 1 || w * h > 16_777_216) return null;
    const s = this.scaled;
    if (s && s.src === comp && s.k === k && s.gen === this.compositeGen) return s.canvas;
    let c = s?.canvas ?? null;
    if (!c || c.width !== w || c.height !== h) {
      c = document.createElement('canvas');
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(comp, 0, 0, comp.width, comp.height, 0, 0, dw, dh);
    this.scaled = { src: comp, k, gen: this.compositeGen, dw, dh, canvas: c };
    return c;
  }

  /**
   * Draw the document canvas: only the screen area of what changed in the composite when
   * nothing else moved (view, size, background, checkerboard), else everything.
   */
  private drawDocument() {
    const s = activeSession();
    const comp = s && s.view.zoom ? this.getComposite(s.doc) : null;
    const key = s && comp ? this.shownKey(s.doc, comp) : null;
    const change = this.compositeChange;
    this.compositeChange = null;
    if (key && key === this.shown && change !== 'full') {
      if (!change) return; // nothing visible changed
      const clip = this.screenRectOf(s!.doc, comp!, change);
      if (clip) {
        this.drawDoc(comp, clip);
        if (clip.w > 0 && clip.h > 0) this.armSettle();
        return;
      }
    }
    this.drawDoc(comp, null);
    this.shown = key;
  }

  /** Everything besides the composite's pixels that the document canvas depends on. */
  private shownKey(doc: Document, comp: HTMLCanvasElement): string {
    const v = activeSession()?.view;
    return [
      doc.id,
      doc.width,
      doc.height,
      hasTransparentBackground(doc) ? 't' : 'o',
      this.docCanvas.width,
      this.docCanvas.height,
      this.dpr,
      v?.zoom,
      v?.panX,
      v?.panY,
      this.checkerCell(),
      comp.width,
      comp.height,
      this.composite === comp ? 1 : 0,
    ].join('|');
  }

  /**
   * Device-px rect of the document canvas showing a composite change (null → redraw everything,
   * e.g. when it reaches the document's fractional edge pixels next to the drop shadow).
   */
  private screenRectOf(doc: Document, comp: HTMLCanvasElement, d: Rect): { x: number; y: number; w: number; h: number } | null {
    const W = this.docCanvas.width;
    const H = this.docCanvas.height;
    const dpr = this.dpr;
    const k = viewport.zoom() * dpr;
    const o = viewport.origin();
    const x0 = Math.round(o.x * dpr);
    const y0 = Math.round(o.y * dpr);
    const cs = comp.width / Math.max(1, doc.width);
    const f = k / cs;
    let r: { x0: number; y0: number; x1: number; y1: number };
    if (k < 1) {
      // Minified: the pre-scaled copy (patched in place) is blitted 1:1 — exact under a clip.
      if (!(this.scaled && this.scaled.src === comp && this.scaled.gen === this.compositeGen)) return null;
      const sc = this.scaledRectOf(d, this.scaledFactor(this.scaled), this.scaled.canvas.width, this.scaled.canvas.height);
      r = { x0: x0 + sc.x0, y0: y0 + sc.y0, x1: x0 + sc.x1, y1: y0 + sc.y1 };
    } else {
      // Magnified: only integer device scales (1:1 copies, k×k pixel blocks) redraw exactly
      // through a clip. At e.g. 250% a device pixel centre can fall exactly on a boundary between
      // two document pixels and the clipped draw may sample the other one: redraw everything.
      if (Math.abs(k - Math.round(k)) > 1e-9) return null;
      const m = Math.ceil(k) + 2;
      r = { x0: Math.floor(x0 + d.x * f) - m, y0: Math.floor(y0 + d.y * f) - m, x1: Math.ceil(x0 + (d.x + d.width) * f) + m, y1: Math.ceil(y0 + (d.y + d.height) * f) + m };
    }
    // Visible document area; its last column/row may be partly covered (fractional edge).
    const vx0 = Math.max(0, x0);
    const vy0 = Math.max(0, y0);
    const ex = x0 + doc.width * k;
    const ey = y0 + doc.height * k;
    const vx1 = Math.min(W, ex);
    const vy1 = Math.min(H, ey);
    const cx0 = Math.max(vx0, r.x0);
    const cy0 = Math.max(vy0, r.y0);
    const cx1 = Math.min(Math.ceil(vx1), r.x1);
    const cy1 = Math.min(Math.ceil(vy1), r.y1);
    if (cx1 <= cx0 || cy1 <= cy0) return { x: 0, y: 0, w: 0, h: 0 };
    if ((ex < W && cx1 > Math.floor(ex)) || (ey < H && cy1 > Math.floor(ey))) return null;
    return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
  }

  /**
   * After partial redraws, redraw everything (and rebuild the pre-scaled copy) once they stop:
   * clipped draws are exact on the software canvas but may differ by a level or two on a GPU
   * canvas, so the screen always ends up showing a from-scratch draw shortly after a stroke.
   */
  private armSettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = 0;
      if (!this.mounted) return;
      if (this.scaled) this.scaled.gen = -1;
      this.shown = null;
      this.requestDoc();
    }, SETTLE_MS);
  }

  /** Checkerboard square size in CSS px (shell preference 'checkerSize', default 8). */
  private checkerCell(): number {
    let v = CHECKER_CELL;
    try {
      v = Number(getPref<number>('checkerSize', CHECKER_CELL));
    } catch {
      v = CHECKER_CELL;
    }
    return Number.isFinite(v) && v >= 2 ? Math.min(64, v) : CHECKER_CELL;
  }

  private checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    const css = this.checkerCell();
    if (this.checker && this.checker.dpr === this.dpr && this.checker.cell === css) return this.checker.pattern;
    const cell = Math.max(2, Math.round(css * this.dpr));
    const c = document.createElement('canvas');
    c.width = cell * 2;
    c.height = cell * 2;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = CHECKER_LIGHT;
    g.fillRect(0, 0, cell * 2, cell * 2);
    g.fillStyle = CHECKER_DARK;
    g.fillRect(0, 0, cell, cell);
    g.fillRect(cell, cell, cell, cell);
    const p = ctx.createPattern(c, 'repeat');
    if (!p) return null;
    this.checker = { pattern: p, dpr: this.dpr, cell: css };
    return p;
  }

  /** Draw the document canvas (all of it, or only `clip` (device px) inside the document). */
  private drawDoc(comp: HTMLCanvasElement | null, clip: { x: number; y: number; w: number; h: number } | null) {
    const ctx = this.docCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!clip) {
      this.paintDoc(comp, false);
      return;
    }
    if (clip.w <= 0 || clip.h <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    ctx.clearRect(clip.x, clip.y, clip.w, clip.h);
    try {
      this.paintDoc(comp, true);
    } finally {
      ctx.restore();
    }
  }

  private paintDoc(comp: HTMLCanvasElement | null, partial: boolean) {
    const ctx = this.docCtx;
    const W = this.docCanvas.width;
    const H = this.docCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!partial) ctx.clearRect(0, 0, W, H);
    const s = activeSession();
    if (!s || !s.view.zoom) return;
    const doc = s.doc;
    const dpr = this.dpr;
    const z = viewport.zoom();
    const o = viewport.origin();
    const k = z * dpr;
    const x0 = Math.round(o.x * dpr);
    const y0 = Math.round(o.y * dpr);
    const dw = doc.width * k;
    const dh = doc.height * k;
    const vx0 = Math.max(0, x0);
    const vy0 = Math.max(0, y0);
    const vx1 = Math.min(W, x0 + dw);
    const vy1 = Math.min(H, y0 + dh);

    // Subtle drop shadow (only when an edge of the document is visible; partial redraws stay
    // inside the document, which covers the shadow's fill).
    if (!partial && (x0 > -1 || y0 > -1 || x0 + dw < W + 1 || y0 + dh < H + 1)) {
      const m = 80 * dpr;
      const sx0 = Math.max(-m, x0);
      const sy0 = Math.max(-m, y0);
      const sx1 = Math.min(W + m, x0 + dw);
      const sy1 = Math.min(H + m, y0 + dh);
      if (sx1 > sx0 && sy1 > sy0) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 24 * dpr;
        ctx.shadowOffsetY = 2 * dpr;
        ctx.fillStyle = '#0b0b0b';
        ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
        ctx.restore();
      }
    }
    if (vx1 <= vx0 || vy1 <= vy0) return;

    if (hasTransparentBackground(doc)) {
      const pat = this.checkerPattern(ctx);
      if (pat) {
        pat.setTransform(new DOMMatrix([1, 0, 0, 1, x0, y0]));
        ctx.fillStyle = pat;
      } else ctx.fillStyle = '#ffffff';
      ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    }

    if (!comp) return;
    if (k < 1) {
      // Minified: blit a cached, high-quality pre-scaled copy 1:1 (the origin sits on a device
      // pixel), so panning costs a plain copy instead of re-filtering the full composite.
      const sc = this.getScaled(comp, k, doc.width, doc.height);
      if (sc) {
        const sx = vx0 - x0;
        const sy = vy0 - y0;
        const sw = Math.min(sc.width - sx, W - vx0);
        const sh = Math.min(sc.height - sy, H - vy0);
        if (sw > 0 && sh > 0) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(sc, sx, sy, sw, sh, vx0, vy0, sw, sh);
        }
        return;
      }
    }
    const cs = comp.width / Math.max(1, doc.width);
    // Smoothing follows the device-pixel scale: high-quality minification below 1:1, crisp
    // nearest-neighbour pixels once a document pixel covers 2+ device pixels (e.g. 100% on HiDPI).
    ctx.imageSmoothingEnabled = k < 2;
    ctx.imageSmoothingQuality = k < 1 ? 'high' : 'low';
    // Draw only the visible part (integer source pixels so nearest-neighbour stays aligned).
    const sx0 = Math.max(0, Math.floor((vx0 - x0) / k));
    const sy0 = Math.max(0, Math.floor((vy0 - y0) / k));
    const sx1 = Math.min(doc.width, Math.ceil((vx1 - x0) / k));
    const sy1 = Math.min(doc.height, Math.ceil((vy1 - y0) / k));
    if (sx1 <= sx0 || sy1 <= sy0) return;
    ctx.drawImage(comp, sx0 * cs, sy0 * cs, (sx1 - sx0) * cs, (sy1 - sy0) * cs, x0 + sx0 * k, y0 + sy0 * k, (sx1 - sx0) * k, (sy1 - sy0) * k);
  }

  private drawOverlay() {
    const ctx = this.ovCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    resetAntsAnimationFlag();
    const s = activeSession();
    if (!s || !s.view.zoom) return;
    const doc = s.doc;
    const ui = useUI.getState();
    const view = ui.view;
    const size = { width: this.cssW, height: this.cssH };
    const z = viewport.zoom();
    const layer = (label: string, fn: () => void) => {
      ctx.save();
      safe(label, fn);
      ctx.restore();
    };

    if (view.extras && view.grid) layer('grid', () => drawGrid(ctx, doc, ui.gridSize, size));
    if (view.extras && view.pixelGrid && z >= 8) layer('pixel grid', () => drawPixelGrid(ctx, doc, size));
    const ses = activeTransform();
    if (view.extras && doc.selection && !vpState.suppressAnts && !(ses && ses.kind === 'selection')) {
      layer('selection', () => drawSelection(ctx, doc));
    }
    const ovs = [...viewOverlays.list()].sort((a, b) => a.order - b.order);
    for (const ov of ovs) {
      let on = false;
      try {
        on = ov.enabled();
      } catch {
        on = false;
      }
      if (on) layer(`overlay ${ov.id}`, () => ov.render(ctx));
    }
    layer('guides', () => drawGuides(ctx, doc, size, view.extras && view.guides));
    const ed = useEditor.getState();
    // A tool suspended by a temporary tool (Space → Hand) keeps showing its crop box / transform box.
    if (ed.previousTool && ed.previousTool !== ed.activeTool && PERSISTENT_OVERLAY_TOOLS.has(ed.previousTool)) {
      const prev = tools.get(ed.previousTool);
      if (prev?.renderOverlay) layer(`tool ${prev.id} overlay (suspended)`, () => prev.renderOverlay!(ctx));
    }
    const tool = tools.get(ed.activeTool);
    if (tool?.renderOverlay) layer(`tool ${tool.id} overlay`, () => tool.renderOverlay!(ctx));
    const ovr = vpState.inputOverride;
    if (ovr?.renderOverlay) layer(`override ${ovr.id}`, () => ovr.renderOverlay!(ctx));
    layer('smart guides', () => drawSmartGuides(ctx));
    if (view.rulers) {
      layer('rulers', () =>
        drawRulers(ctx, {
          width: size.width,
          height: size.height,
          origin: viewport.origin(),
          zoom: z,
          docW: doc.width,
          docH: doc.height,
          pointer: vpState.pointer,
          highlight: doc.selection?.bounds ?? null,
        }),
      );
    }
    if (antsAnimatedThisFrame() && !this.antsTimer) {
      this.antsTimer = window.setTimeout(() => {
        this.antsTimer = 0;
        this.requestOverlay();
      }, 125);
    }
  }

  /* ------------------------------------------------------------------ */
  /* cursor                                                              */
  /* ------------------------------------------------------------------ */

  private updateCursor() {
    let c = 'default';
    const s = activeSession();
    const p = vpState.pointer;
    const ui = useUI.getState();
    if (!s) c = 'default';
    else if (this.drag?.kind === 'pan') c = 'grabbing';
    else if (this.drag?.kind === 'guide' || vpState.guideDrag) {
      const g = vpState.guideDrag;
      c = g?.remove && g.id !== null ? 'not-allowed' : g?.orientation === 'vertical' ? 'col-resize' : 'row-resize';
    } else if (p && !this.drag && rulerAt(p, ui.view.rulers)) c = 'default';
    else if (this.hoverGuide && !this.drag) c = this.hoverGuide === 'vertical' ? 'col-resize' : 'row-resize';
    else if (this.activeOverride()) {
      const n = this.lastNative;
      try {
        c = this.activeOverride()!.cursor?.({ altKey: !!n?.altKey, shiftKey: !!n?.shiftKey }) ?? 'crosshair';
      } catch {
        c = 'crosshair';
      }
    } else if (this.cursorOverride) c = this.cursorOverride;
    else {
      const tool = tools.get(useEditor.getState().activeTool);
      try {
        c = (typeof tool?.cursor === 'function' ? tool.cursor() : tool?.cursor) || 'default';
      } catch {
        c = 'default';
      }
    }
    if (c !== this.appliedCursor) {
      this.overlay.style.cursor = c;
      this.appliedCursor = c;
    }
  }

  /* ------------------------------------------------------------------ */
  /* input                                                               */
  /* ------------------------------------------------------------------ */

  /** The input override, unless the user holds the temporary Hand tool (Space) to pan. */
  private activeOverride(): InputOverride | null {
    const o = vpState.inputOverride;
    if (!o) return null;
    const st = useEditor.getState();
    if (st.activeTool === 'hand' && st.previousTool !== null) return null;
    return o;
  }

  private screenOf(e: MouseEvent): Point {
    const r = this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toolEvent(e: MouseEvent, native?: PointerEvent): ToolPointerEvent {
    const screen = this.screenOf(e);
    const d = viewport.screenToDoc(screen);
    const pe = e as Partial<PointerEvent> & MouseEvent;
    const pointerType = pe.pointerType ?? 'mouse';
    const pressure = pointerType === 'mouse' ? (e.buttons ? 1 : 0) : (pe.pressure ?? 0.5);
    return {
      docX: d.x,
      docY: d.y,
      screenX: screen.x,
      screenY: screen.y,
      button: e.button,
      buttons: e.buttons,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey || e.metaKey,
      pressure,
      pointerType,
      native: native ?? (e as PointerEvent),
    };
  }

  /** Fake "release" event at the last known position (used when a drag is abandoned). */
  private syntheticEvent(): ToolPointerEvent {
    const n = this.lastNative;
    if (n) return this.toolEvent(n, n);
    const p = vpState.pointer ?? { x: 0, y: 0 };
    const d = viewport.screenToDoc(p);
    return {
      docX: d.x,
      docY: d.y,
      screenX: p.x,
      screenY: p.y,
      button: 0,
      buttons: 0,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      pressure: 0,
      pointerType: 'mouse',
      native: new PointerEvent('pointerup'),
    };
  }

  private capture(pointerId: number) {
    try {
      this.overlay.setPointerCapture(pointerId);
    } catch {
      /* pointer already gone */
    }
  }

  private release(pointerId: number) {
    try {
      if (this.overlay.hasPointerCapture(pointerId)) this.overlay.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.drag) return; // ignore extra pointers while a gesture is running
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== document.body && isTypingTarget(ae)) ae.blur();
    this.root.focus({ preventScroll: true });
    const s = activeSession();
    if (!s || !s.view.zoom) return;
    this.lastNative = e;
    const screen = this.screenOf(e);
    vpState.pointer = screen;

    if (e.button === 1) {
      e.preventDefault();
      this.drag = { kind: 'pan', pointerId: e.pointerId, last: screen };
      vpState.panning = true;
      this.capture(e.pointerId);
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;

    const ui = useUI.getState();
    const ruler = rulerAt(screen, ui.view.rulers);
    if (ruler) {
      if (ruler === 'top' || ruler === 'left') {
        beginNewGuide(ruler, screen);
        this.drag = { kind: 'guide', pointerId: e.pointerId };
        this.capture(e.pointerId);
        this.updateCursor();
      }
      return;
    }

    const ovr = this.activeOverride();
    if (ovr) {
      e.preventDefault();
      this.drag = { kind: 'override', pointerId: e.pointerId, override: ovr };
      this.capture(e.pointerId);
      const te = this.toolEvent(e);
      safe(`${ovr.id} pointerdown`, () => ovr.onPointerDown?.(te));
      this.updateCursor();
      this.requestOverlay();
      return;
    }

    const toolId = useEditor.getState().activeTool;
    if (toolId === 'move' && !activeTransform() && ui.view.guides && ui.view.extras && !e.altKey && !(e.ctrlKey || e.metaKey)) {
      const g = hitGuide(s.doc, screen);
      if (g) {
        beginMoveGuide(g);
        this.drag = { kind: 'guide', pointerId: e.pointerId };
        this.capture(e.pointerId);
        this.updateCursor();
        return;
      }
    }

    const tool = tools.get(toolId);
    if (!tool) return;
    e.preventDefault();
    this.drag = { kind: 'tool', pointerId: e.pointerId, tool };
    this.capture(e.pointerId);
    const te = this.toolEvent(e);
    safe(`${tool.id} pointerdown`, () => tool.onPointerDown?.(te));
    this.updateCursor();
    this.requestOverlay();
  };

  private onPointerMove = (e: PointerEvent) => {
    const screen = this.screenOf(e);
    vpState.pointer = screen;
    this.lastNative = e;
    const ui = useUI.getState();
    if (ui.view.rulers) this.requestOverlay();
    const d = this.drag;
    if (d) {
      if (d.pointerId !== e.pointerId) return;
      if (d.kind === 'pan') {
        const dx = screen.x - d.last.x;
        const dy = screen.y - d.last.y;
        d.last = screen;
        if (dx || dy) viewport.panBy(dx, dy);
        return;
      }
      if (d.kind === 'guide') {
        updateGuideDrag(screen, e.shiftKey);
        this.updateCursor();
        return;
      }
      const te = this.toolEvent(e);
      if (d.kind === 'override') {
        safe(`${d.override.id} pointermove`, () => d.override.onPointerMove?.(te));
        return;
      }
      safe(`${d.tool.id} pointermove`, () => d.tool.onPointerMove?.(te));
      return;
    }
    if (e.buttons && e.pointerType === 'mouse') return; // a drag that started elsewhere
    const s = activeSession();
    if (!s || !s.view.zoom) {
      this.updateCursor();
      return;
    }
    const ovr = this.activeOverride();
    if (ovr) {
      this.hoverGuide = null;
      if (ovr.onHover && !rulerAt(screen, ui.view.rulers)) {
        const te = this.toolEvent(e);
        safe(`${ovr.id} hover`, () => ovr.onHover!(te));
      }
      this.updateCursor();
      return;
    }
    const toolId = useEditor.getState().activeTool;
    let hover: ViewportEngine['hoverGuide'] = null;
    if (
      toolId === 'move' &&
      !activeTransform() &&
      ui.view.guides &&
      ui.view.extras &&
      !e.altKey &&
      !(e.ctrlKey || e.metaKey) &&
      !rulerAt(screen, ui.view.rulers)
    ) {
      hover = hitGuide(s.doc, screen)?.orientation ?? null;
    }
    this.hoverGuide = hover;
    if (!rulerAt(screen, ui.view.rulers)) {
      const tool = tools.get(toolId);
      if (tool?.onHover) {
        const te = this.toolEvent(e);
        safe(`${tool.id} hover`, () => tool.onHover!(te));
      }
    }
    this.updateCursor();
  };

  private finish(e: PointerEvent, cancelled: boolean) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    this.drag = null;
    this.release(e.pointerId);
    if (d.kind === 'pan') vpState.panning = false;
    else if (d.kind === 'guide') {
      if (cancelled) cancelGuideDrag();
      else endGuideDrag();
    } else if (d.kind === 'override') {
      const te = this.toolEvent(e);
      safe(`${d.override.id} pointerup`, () => d.override.onPointerUp?.(te));
    } else {
      const te = this.toolEvent(e);
      safe(`${d.tool.id} pointerup`, () => d.tool.onPointerUp?.(te));
    }
    this.updateCursor();
    this.requestOverlay();
  }

  private onPointerUp = (e: PointerEvent) => {
    this.lastNative = e;
    this.finish(e, false);
  };

  private onPointerCancel = (e: PointerEvent) => this.finish(e, true);

  private onLostCapture = (e: PointerEvent) => {
    if (this.drag && this.drag.pointerId === e.pointerId) this.finish(e, false);
  };

  private onPointerLeave = () => {
    if (this.drag) return;
    vpState.pointer = null;
    this.hoverGuide = null;
    this.requestOverlay();
  };

  private onDoubleClick = (e: MouseEvent) => {
    if (e.defaultPrevented) return; // handled elsewhere (e.g. a capture-phase listener)
    const s = activeSession();
    if (!s || !s.view.zoom) return;
    const screen = this.screenOf(e);
    if (rulerAt(screen, useUI.getState().view.rulers)) return;
    if (this.activeOverride()) return;
    const tool = tools.get(useEditor.getState().activeTool);
    if (!tool?.onDoubleClick) return;
    const te = this.toolEvent(e, this.lastNative ?? undefined);
    safe(`${tool.id} dblclick`, () => tool.onDoubleClick!(te));
  };

  private altReleaseGuard: ((e: KeyboardEvent) => void) | null = null;

  /**
   * Alt+wheel zooms; releasing Alt afterwards must not count as a lone Alt press (which focuses
   * the menu bar). The shell's keyboard handler does not see the wheel, so the next Alt keyup is
   * kept from reaching it — unless a temporary tool (Alt → eyedropper) needs it to end.
   */
  private swallowNextAltRelease() {
    if (this.altReleaseGuard) return;
    const guard = (ev: KeyboardEvent) => {
      if (ev.type === 'keyup' && ev.key !== 'Alt') return;
      window.removeEventListener('keyup', guard, true);
      window.removeEventListener('blur', guard as unknown as EventListener, true);
      if (this.altReleaseGuard === guard) this.altReleaseGuard = null;
      if (ev.type !== 'keyup') return;
      const st = useEditor.getState();
      if (st.previousTool !== null && st.activeTool !== st.previousTool) return; // temporary tool held
      ev.stopPropagation();
    };
    this.altReleaseGuard = guard;
    window.addEventListener('keyup', guard, true);
    window.addEventListener('blur', guard as unknown as EventListener, true);
  }

  private dropAltReleaseGuard() {
    const g = this.altReleaseGuard;
    if (!g) return;
    this.altReleaseGuard = null;
    window.removeEventListener('keyup', g, true);
    window.removeEventListener('blur', g as unknown as EventListener, true);
  }

  private onWheel = (e: WheelEvent) => {
    // Floating UI inside the viewport (e.g. the Color Range panel) scrolls normally.
    if ((e.target as HTMLElement | null)?.closest?.('[data-viewport-ui]')) return;
    e.preventDefault();
    const s = activeSession();
    if (!s || !s.view.zoom) return;
    const anchor = this.screenOf(e);
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (e.altKey) this.swallowNextAltRelease();
      viewport.zoomBy(wheelZoomFactor(e.deltaY || e.deltaX, e.deltaMode), anchor);
      return;
    }
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? this.cssH : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    viewport.panBy(-dx, -dy);
  };
}
