/** Module-local shared state + small helpers for the viewport & its tools. */
import type { Document, Point } from '../core/types';
import type { ToolPointerEvent } from '../registry';
import { viewport } from '../editor/viewport';
import { activeDoc, activeSession, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import type { Affine } from './math/affine';

/** Ruler thickness (CSS px). */
export const RULER = 18;

export const GUIDE_COLOR = '#29c4ff';
export const ACCENT = '#8b7cf6';
export const HANDLE = 7;

export interface GuideDrag {
  /** Existing guide id being moved, or null when creating from a ruler. */
  id: string | null;
  orientation: 'horizontal' | 'vertical';
  position: number;
  /** Will be removed when released here. */
  remove: boolean;
}

/**
 * Temporarily routes left-button canvas input away from the active tool (e.g. the Color Range
 * panel sampling colors from the canvas). Middle-button panning and the temporary Hand tool
 * (Space) keep working.
 */
export interface InputOverride {
  id: string;
  cursor?(e: { altKey: boolean; shiftKey: boolean }): string | null;
  onPointerDown?(e: ToolPointerEvent): void;
  onPointerMove?(e: ToolPointerEvent): void;
  onPointerUp?(e: ToolPointerEvent): void;
  onHover?(e: ToolPointerEvent): void;
  /** Drawn above the tool overlay (screen space). */
  renderOverlay?(ctx: CanvasRenderingContext2D): void;
}

export const vpState = {
  inputOverride: null as InputOverride | null,
  /** Last pointer position in viewport CSS px (null when outside). */
  pointer: null as Point | null,
  spaceHeld: false,
  panning: false,
  guideDrag: null as GuideDrag | null,
  /** Layer under the cursor (move tool hover outline). */
  hoverLayerId: null as string | null,
  /** A tool draws the selection outline itself (e.g. while dragging it) → skip the default ants. */
  suppressAnts: false,
};

/**
 * True while `toolId` is only temporarily switched away from (e.g. Space held for the Hand tool):
 * its in-progress state (crop box, polygon points, free transform) must survive.
 */
export function isTemporarilySuspended(toolId: string): boolean {
  const st = useEditor.getState();
  return st.previousTool === toolId && st.activeTool !== toolId;
}

/** Tools whose overlay stays visible while they are temporarily suspended. */
export const PERSISTENT_OVERLAY_TOOLS = new Set(['move', 'crop', 'lasso', 'polygon-lasso']);

const overrideListeners = new Set<() => void>();

/** Install (or clear with null) the canvas input override. */
export function setInputOverride(o: InputOverride | null) {
  vpState.inputOverride = o;
  overrideListeners.forEach((l) => l());
  viewport.requestOverlay();
}

/** Notified whenever the input override changes (the viewport refreshes its cursor). */
export function onInputOverrideChange(l: () => void): () => void {
  overrideListeners.add(l);
  return () => overrideListeners.delete(l);
}

/** doc → screen (CSS px) matrix for the active view. */
export function docToScreenMatrix(): Affine {
  const o = viewport.origin();
  const z = viewport.zoom();
  return { a: z, b: 0, c: 0, d: z, e: o.x, f: o.y };
}

const lastToast = new Map<string, number>();

/** Toast, but not more than once per `ms` for the same message. */
export function toastOnce(message: string, kind: 'info' | 'warning' | 'error' | 'success' = 'warning', ms = 1500) {
  const now = Date.now();
  const t = lastToast.get(message) ?? 0;
  if (now - t < ms) return;
  lastToast.set(message, now);
  toast(message, kind);
}

/** Active document or null (with a helpful toast). */
export function requireDoc(what = 'this'): Document | null {
  const d = activeDoc();
  if (!d) toastOnce(`Open or create a document to use ${what}.`, 'info');
  return d;
}

export function hasDoc(): boolean {
  return !!activeSession();
}

/** Format a doc-px number for labels. */
export function fmtPx(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
