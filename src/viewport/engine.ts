/**
 * ViewportEngine — owns the two stacked canvases of <Viewport/> (document + overlay):
 *  - DPR-aware sizing (ResizeObserver, device-pixel content box when available),
 *  - a requestAnimationFrame loop driven by store changes, bitmap touches and explicit requests,
 *  - document drawing (checkerboard, cached composite, shadow, zoom-dependent smoothing),
 *  - overlay drawing (grid, pixel grid, ants, view overlays, guides, tool overlay, smart guides, rulers),
 *  - pointer/wheel input → pan/zoom, ruler guides, and ToolPointerEvent dispatch.
 */
import type { Document, Point } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { installViewport, viewport } from '../editor/viewport';
import { tools, viewOverlays, type ToolDef, type ToolPointerEvent } from '../registry';
import { renderDocument } from '../render/compositor';
import { activeSession, useEditor } from '../state/editor';
import { useUI } from '../state/ui';
import { isTypingTarget } from '../ui/shortcuts';
import { antsAnimatedThisFrame, resetAntsAnimationFlag } from './outline';
import { drawGrid, drawPixelGrid, drawSelection } from './overlays';
import { drawRulers, rulerAt } from './rulers';
import { beginMoveGuide, beginNewGuide, cancelGuideDrag, drawGuides, endGuideDrag, hitGuide, updateGuideDrag } from './guides';
import { drawSmartGuides } from './snap';
import { wheelZoomFactor } from './math/zoom';
import { activeTransform } from './transform/controller';
import { vpState } from './state';

type Drag =
  | { kind: 'pan'; pointerId: number; last: Point }
  | { kind: 'guide'; pointerId: number }
  | { kind: 'tool'; pointerId: number; tool: ToolDef };

const CHECKER_CELL = 8;
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
  private composite: HTMLCanvasElement | null = null;
  private compositeDoc: Document | null = null;
  private cursorOverride: string | null = null;
  private appliedCursor = '';
  private antsTimer = 0;
  private checker: { pattern: CanvasPattern; dpr: number } | null = null;
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
    this.disposers.push(tools.subscribe(() => this.requestOverlay()));
    this.disposers.push(viewOverlays.subscribe(() => this.requestOverlay()));

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
    if (this.drag?.kind === 'guide') cancelGuideDrag();
    this.drag = null;
    this.disposers.forEach((d) => d());
    this.disposers = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.antsTimer) clearTimeout(this.antsTimer);
    this.antsTimer = 0;
    installViewport(null);
    this.composite = null;
    this.compositeDoc = null;
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
    this.snapPan();
    if (this.docPending) {
      this.docPending = false;
      safe('document draw', () => this.drawDoc());
    }
    if (this.overlayPending) {
      this.overlayPending = false;
      safe('overlay draw', () => this.drawOverlay());
    }
  };

  /** Keep the document origin on a device pixel so 100%/200%… views are perfectly crisp. */
  private snapPan() {
    const s = activeSession();
    if (!s || !s.view.zoom || !this.cssW) return;
    const o = viewport.origin();
    const dpr = this.dpr;
    const fx = o.x * dpr - Math.round(o.x * dpr);
    const fy = o.y * dpr - Math.round(o.y * dpr);
    if (Math.abs(fx) > 1e-3 || Math.abs(fy) > 1e-3) {
      useEditor.getState().setView({ panX: s.view.panX - fx / dpr, panY: s.view.panY - fy / dpr });
    }
  }

  private resize(cssW: number, cssH: number, dev?: { w: number; h: number }) {
    const w = Math.max(0, cssW);
    const h = Math.max(0, cssH);
    const ratio = window.devicePixelRatio || 1;
    const devW = Math.max(1, dev ? dev.w : Math.round(w * ratio));
    const devH = Math.max(1, dev ? dev.h : Math.round(h * ratio));
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
      this.composite = renderDocument(doc);
    } catch (err) {
      console.error('[viewport] renderDocument failed', err);
      if (this.compositeDoc?.id !== doc.id) this.composite = null;
    }
    this.compositeDoc = doc;
    this.compositeDirty = false;
    return this.composite;
  }

  private checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.checker && this.checker.dpr === this.dpr) return this.checker.pattern;
    const cell = Math.max(2, Math.round(CHECKER_CELL * this.dpr));
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
    this.checker = { pattern: p, dpr: this.dpr };
    return p;
  }

  private drawDoc() {
    const ctx = this.docCtx;
    const W = this.docCanvas.width;
    const H = this.docCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
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

    // Subtle drop shadow (only when an edge of the document is visible).
    if (x0 > -1 || y0 > -1 || x0 + dw < W + 1 || y0 + dh < H + 1) {
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

    const comp = this.getComposite(doc);
    if (!comp) return;
    const cs = comp.width / Math.max(1, doc.width);
    ctx.imageSmoothingEnabled = z < 2;
    ctx.imageSmoothingQuality = z < 1 ? 'high' : 'low';
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
    const tool = tools.get(useEditor.getState().activeTool);
    if (tool?.renderOverlay) layer(`tool ${tool.id} overlay`, () => tool.renderOverlay!(ctx));
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
    else if (this.cursorOverride) c = this.cursorOverride;
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
      safe(`${d.tool.id} pointermove`, () => d.tool.onPointerMove?.(te));
      return;
    }
    if (e.buttons && e.pointerType === 'mouse') return; // a drag that started elsewhere
    const s = activeSession();
    if (!s || !s.view.zoom) {
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
    const s = activeSession();
    if (!s || !s.view.zoom) return;
    const screen = this.screenOf(e);
    if (rulerAt(screen, useUI.getState().view.rulers)) return;
    const tool = tools.get(useEditor.getState().activeTool);
    if (!tool?.onDoubleClick) return;
    const te = this.toolEvent(e, this.lastNative ?? undefined);
    safe(`${tool.id} dblclick`, () => tool.onDoubleClick!(te));
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const s = activeSession();
    if (!s || !s.view.zoom) return;
    const anchor = this.screenOf(e);
    if (e.ctrlKey || e.metaKey || e.altKey) {
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
