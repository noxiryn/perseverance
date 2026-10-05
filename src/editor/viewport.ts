/**
 * Viewport controller — a tiny singleton bridge between the canvas viewport component and tools.
 * The Viewport component installs the implementation on mount (`installViewport`).
 * Tools/commands call these functions; they are safe no-ops before the viewport mounts.
 */
import type { Point } from '../core/types';
import { activeSession, useEditor } from '../state/editor';
import { useUI } from '../state/ui';

/** Width/height of the viewport rulers in CSS px (when View ▸ Rulers is on). */
export const RULER_SIZE = 18;

export interface ViewportImpl {
  /** Size of the viewport element in CSS px. */
  getSize(): { width: number; height: number };
  /** Request a re-composite of the document + overlay on the next animation frame. */
  requestRender(): void;
  /** Request only an overlay redraw (tool UI, ants…) on the next animation frame. */
  requestOverlay(): void;
  /** Temporarily override the CSS cursor (null = tool default). */
  setCursor(cursor: string | null): void;
  /** The viewport DOM element (for focus, text editing overlays, etc). */
  element(): HTMLElement | null;
}

let impl: ViewportImpl | null = null;

export function installViewport(v: ViewportImpl | null) {
  impl = v;
}

function view() {
  return activeSession()?.view ?? { zoom: 1, panX: 0, panY: 0 };
}

function docSize() {
  const d = activeSession()?.doc;
  return d ? { w: d.width, h: d.height } : { w: 0, h: 0 };
}

export const viewport = {
  getSize(): { width: number; height: number } {
    return impl?.getSize() ?? { width: 800, height: 600 };
  },
  requestRender() {
    impl?.requestRender();
  },
  requestOverlay() {
    impl?.requestOverlay();
  },
  setCursor(c: string | null) {
    impl?.setCursor(c);
  },
  element(): HTMLElement | null {
    return impl?.element() ?? null;
  },

  /** Current zoom (screen px per doc px). */
  zoom(): number {
    return view().zoom || 1;
  },

  /** Screen-space (viewport CSS px) position of the document origin. */
  origin(): Point {
    const { width, height } = viewport.getSize();
    const v = view();
    const z = v.zoom || 1;
    const { w, h } = docSize();
    return { x: width / 2 + v.panX - (w * z) / 2, y: height / 2 + v.panY - (h * z) / 2 };
  },

  docToScreen(p: Point): Point {
    const o = viewport.origin();
    const z = viewport.zoom();
    return { x: o.x + p.x * z, y: o.y + p.y * z };
  },

  screenToDoc(p: Point): Point {
    const o = viewport.origin();
    const z = viewport.zoom();
    return { x: (p.x - o.x) / z, y: (p.y - o.y) / z };
  },

  /** Set zoom keeping the given screen point fixed (defaults to viewport center). */
  zoomTo(zoom: number, anchor?: Point) {
    const s = activeSession();
    if (!s) return;
    const z = Math.max(0.02, Math.min(64, zoom));
    const size = viewport.getSize();
    const a = anchor ?? { x: size.width / 2, y: size.height / 2 };
    const docPt = viewport.screenToDoc(a);
    const { w, h } = docSize();
    // Solve pan so that docPt maps to anchor at new zoom.
    const panX = a.x - size.width / 2 + (w * z) / 2 - docPt.x * z;
    const panY = a.y - size.height / 2 + (h * z) / 2 - docPt.y * z;
    useEditor.getState().setView({ zoom: z, panX, panY });
  },

  zoomBy(factor: number, anchor?: Point) {
    viewport.zoomTo(viewport.zoom() * factor, anchor);
  },

  /**
   * Fit the document in the viewport with some padding. `insets` reserve screen space on each side
   * (e.g. rulers); when omitted, visible rulers (18px top/left) are accounted for automatically.
   */
  fit(padding = 48, insets?: { top?: number; left?: number; right?: number; bottom?: number }) {
    const s = activeSession();
    if (!s) return;
    const size = viewport.getSize();
    const ins = insets ?? (useUI.getState().view.rulers ? { top: RULER_SIZE, left: RULER_SIZE } : {});
    const t = ins.top ?? 0,
      l = ins.left ?? 0,
      r = ins.right ?? 0,
      b = ins.bottom ?? 0;
    const availW = size.width - l - r - padding * 2;
    const availH = size.height - t - b - padding * 2;
    const z = Math.min(availW / s.doc.width, availH / s.doc.height);
    // Center within the area left by the insets (pan is relative to the viewport center).
    useEditor.getState().setView({ zoom: Math.max(0.02, Math.min(z, 16)), panX: (l - r) / 2, panY: (t - b) / 2 });
  },

  actualPixels() {
    useEditor.getState().setView({ zoom: 1, panX: 0, panY: 0 });
  },

  panBy(dx: number, dy: number) {
    const v = view();
    useEditor.getState().setView({ panX: v.panX + dx, panY: v.panY + dy });
  },
};

export type Viewport = typeof viewport;
