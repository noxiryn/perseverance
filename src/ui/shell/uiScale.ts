/**
 * UI scale (Preferences ▸ UI scale).
 *
 * Preferred route: native page zoom. When the desktop bridge exposes `setZoomFactor` (Electron
 * `webFrame.setZoomFactor` from the preload) the whole page is zoomed by Chromium, so every
 * coordinate API (clientX, getBoundingClientRect, innerWidth, viewport units) stays consistent,
 * portals scale with the chrome and the canvas stays crisp (devicePixelRatio grows).
 *
 * Fallback (browser builds, or a desktop build without that bridge): CSS `zoom` on #root. With
 * CSS zoom, getBoundingClientRect()/clientX/innerWidth report *visual* px while lengths inside the
 * zoomed tree are *zoomed* CSS px, so:
 *  - the canvas viewport host is counter-zoomed (effective zoom 1): the viewport's pointer maths
 *    (clientX - rect.left vs. its CSS size) stays right and the canvas stays 1:1 and crisp;
 *  - the shell's floating UI (menu bar menus, command palette, tooltips) renders in a portal host
 *    zoomed by the same factor, and converts visual px to CSS px with toCss();
 *  - viewport units in shell.css are divided by --shell-css-zoom (vw/vh are not zoom-adjusted).
 *
 * The scale applied never leaves the UI smaller than MIN_UI_SIZE (the desktop window's minimum size,
 * which the layout is built for): 150 % on a 1366×768 screen would give a 911×512 UI with the Layers
 * list pushed out of the dock. Then the largest scale that fits is used (never below 100 %) — the
 * preference is kept and applies again in a larger window — and Preferences says so. When the scale
 * applied changes, the dock layout (workspaces.ts) and the open document's view are refitted.
 */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { desktop } from '../../platform';
import { viewport } from '../../editor/viewport';
import { PREF_DEFAULTS, usePref } from './prefs';

interface ZoomBridge {
  setZoomFactor?: (factor: number) => void;
}

/** The native page-zoom setter, when the desktop bridge provides one. */
export function nativeZoomSetter(bridge: unknown = desktop): ((factor: number) => void) | null {
  const fn = (bridge as ZoomBridge | null | undefined)?.setZoomFactor;
  return typeof fn === 'function' ? (f: number) => fn.call(bridge, f) : null;
}

/** Sanitize a stored UI scale (50%–200%, default 100%). */
export function clampScale(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(0.5, Math.min(2, n)) : 1;
}

/** The smallest UI (CSS px) the shell is laid out for: the desktop window's minimum size (electron/lib.cjs MIN_SIZE). */
export const MIN_UI_SIZE = { width: 1024, height: 640 } as const;

/** The UI scales Preferences offers. */
export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

/**
 * The scale to apply for a chosen one in a window `width` × `height` px at 100 %: the choice when the
 * UI stays at least MIN_UI_SIZE, else the largest offered step above 100 % that does, else 100 %.
 * Scales up to 100 % are never changed. Pure.
 */
export function fittingUiScale(pref: unknown, width: number, height: number): number {
  const s = clampScale(pref);
  if (s <= 1 || !(width > 0) || !(height > 0)) return s;
  const max = Math.min(width / MIN_UI_SIZE.width, height / MIN_UI_SIZE.height) + 1e-6;
  if (s <= max) return s;
  let best = 1;
  for (const step of UI_SCALES) if (step > best && step <= max && step < s) best = step;
  return best;
}

/**
 * Wanted (preference) and applied UI scale, the window size at 100 % they were fitted to, and a counter
 * of the changes of the applied scale after start-up (a Preferences change, a resize that changes what
 * fits) — the dock refits its layout on those (workspaces.ts), never at start-up.
 */
export const useUiScaleState = create<{ wanted: number; applied: number; window: { width: number; height: number } | null; changes: number }>(() => ({
  wanted: 1,
  applied: 1,
  window: null,
  changes: 0,
}));

/** The factor last given to the native page zoom (innerWidth / innerHeight are divided by it). */
let nativeApplied = 1;

/** The window's size at 100 % in CSS px (native page zoom shrinks innerWidth/innerHeight; CSS zoom on #root doesn't). */
export function windowSize100(): { width: number; height: number } {
  const k = nativeZoomSetter() ? nativeApplied : 1;
  return { width: Math.round(window.innerWidth * k), height: Math.round(window.innerHeight * k) };
}

/** CSS zoom currently applied to #root (1 when native zoom is used or at 100%). */
export const useCssZoom = create<{ cssZoom: number }>(() => ({ cssZoom: 1 }));

export const cssZoom = (): number => useCssZoom.getState().cssZoom;

/** Convert visual px (getBoundingClientRect, clientX, innerWidth) to CSS px inside the zoomed UI. */
export const toCss = (v: number): number => v / cssZoom();

let host: HTMLDivElement | null = null;

function zoomStyle(z: number): string {
  return z === 1 ? '' : String(z);
}

/**
 * Container for the shell's own portals (menus, palette, tooltips). It carries the same CSS zoom
 * as #root so floating UI matches the chrome; position with toCss().
 */
export function shellPortalHost(): HTMLElement {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.className = 'shell-portal-host';
  host.style.zoom = zoomStyle(cssZoom());
  document.body.appendChild(host);
  return host;
}

/** Apply a UI scale (native page zoom when available, CSS zoom on #root otherwise). */
export function applyUiScale(scale: number) {
  const s = clampScale(scale);
  const native = nativeZoomSetter();
  const css = native ? 1 : s;
  if (native) {
    try {
      native(s);
      nativeApplied = s;
    } catch (e) {
      console.warn('[shell] native zoom failed', e);
    }
  }
  const root = document.getElementById('root');
  if (root) root.style.zoom = zoomStyle(css);
  if (host) host.style.zoom = zoomStyle(css);
  const de = document.documentElement;
  // Total scale: constant visual reservations (native window buttons) are divided by it.
  de.style.setProperty('--shell-ui-scale', String(s));
  // CSS zoom only: viewport units / env() maths inside the zoomed tree are divided by it.
  de.style.setProperty('--shell-css-zoom', String(css));
  if (css === 1) de.removeAttribute('data-shell-css-zoom');
  else de.setAttribute('data-shell-css-zoom', '');
  if (useCssZoom.getState().cssZoom !== css) useCssZoom.setState({ cssZoom: css });
  if (useUiScaleState.getState().applied !== s) useUiScaleState.setState({ applied: s });
}

/**
 * Shell hook: keep the UI scale preference applied — as much of it as the window allows (see
 * fittingUiScale; re-checked when the window is resized) — and reset to 100% on unmount. When the
 * scale applied changes, the open document is fitted to the new canvas area.
 */
export function useUiScale() {
  const pref = usePref<number>('uiScale', PREF_DEFAULTS.uiScale);
  // Selected as a number: the shell re-renders when the scale to apply changes, not on every resize.
  // Null until the window is measured (nothing is applied before, so start-up applies once).
  const scale = useUiScaleState((st) => (st.window ? fittingUiScale(pref, st.window.width, st.window.height) : null));
  useEffect(() => {
    let raf = 0;
    const update = () => {
      const next = windowSize100();
      const cur = useUiScaleState.getState().window;
      if (!cur || cur.width !== next.width || cur.height !== next.height) useUiScaleState.setState({ window: next });
    };
    // Resizes are measured after layout (rAF): native zoom changes innerWidth, and its factor is known by then.
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, []);
  const applied = useRef<number | null>(null);
  useEffect(() => {
    useUiScaleState.setState({ wanted: clampScale(pref) });
  }, [pref]);
  useEffect(() => {
    if (scale === null) return;
    const prev = applied.current;
    applied.current = scale;
    applyUiScale(scale);
    if (prev === null || prev === scale) return;
    useUiScaleState.setState((st) => ({ changes: st.changes + 1 }));
    // The canvas area changed size: fit the document again once the layout has settled.
    const t = window.setTimeout(() => viewport.fit(), 150);
    return () => window.clearTimeout(t);
  }, [scale]);
  useEffect(() => () => applyUiScale(1), []);
}
