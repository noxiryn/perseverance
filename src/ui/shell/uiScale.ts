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
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { desktop } from '../../platform';
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
}

/** Shell hook: keep the UI scale preference applied (reset to 100% on unmount). */
export function useUiScale() {
  const scale = usePref<number>('uiScale', PREF_DEFAULTS.uiScale);
  useEffect(() => applyUiScale(scale), [scale]);
  useEffect(() => () => applyUiScale(1), []);
}
