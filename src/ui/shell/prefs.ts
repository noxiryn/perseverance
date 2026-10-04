/**
 * User preferences (shell-owned), persisted in localStorage under 'perseverance.prefs'.
 *
 * Other modules may read preferences with getPref(key, default) / usePref(key, default).
 * Known keys (see PREF_DEFAULTS):
 *   uiScale            number   CSS zoom applied to the app root (1 = 100%)
 *   toasts             boolean  show "<action> completed." toasts for history steps
 *   autosaveMinutes    number   autosave interval in minutes (0 = off) — read by the io module
 *   defaultBackground  string   'white' | 'black' | 'transparent' | '#rrggbb' for new documents
 *   checkerSize        number   transparency checkerboard square size in px (viewport)
 */
import { useSyncExternalStore } from 'react';

export const PREFS_KEY = 'perseverance.prefs';

export const PREF_DEFAULTS = {
  uiScale: 1,
  toasts: true,
  autosaveMinutes: 2,
  defaultBackground: 'white',
  checkerSize: 8,
} as const;

type Prefs = Record<string, unknown>;

let cache: Prefs | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function load(): Prefs {
  if (cache) return cache;
  let parsed: Prefs = {};
  try {
    const raw = storage()?.getItem(PREFS_KEY);
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Prefs;
    }
  } catch {
    parsed = {};
  }
  cache = parsed;
  return parsed;
}

/** Read a preference. Falls back to `fallback` when unset or of a different type. */
export function getPref<T>(key: string, fallback: T): T {
  const v = load()[key];
  if (v === undefined || v === null) return fallback;
  if (fallback !== undefined && fallback !== null && typeof v !== typeof fallback) return fallback;
  return v as T;
}

/** Write a preference (persisted immediately) and notify subscribers. */
export function setPref<T>(key: string, value: T) {
  const next = { ...load(), [key]: value };
  cache = next;
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* storage full / unavailable — keep in memory */
  }
  listeners.forEach((l) => l());
}

/** Remove all preferences (back to defaults). */
export function resetPrefs() {
  cache = {};
  try {
    storage()?.removeItem(PREFS_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function subscribePrefs(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** React hook: current value of a preference (re-renders on change). */
export function usePref<T>(key: string, fallback: T): T {
  return useSyncExternalStore(subscribePrefs, () => getPref(key, fallback));
}

/** Testing helper: drop the in-memory cache so the next read hits storage again. */
export function _resetPrefsCache() {
  cache = null;
}

/** Resolve the 'defaultBackground' preference into a document background color (null = transparent). */
export function defaultBackgroundColor(): string | null {
  const v = getPref<string>('defaultBackground', PREF_DEFAULTS.defaultBackground);
  if (v === 'transparent') return null;
  if (v === 'black') return '#000000';
  if (v === 'white') return '#ffffff';
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v) ? v : '#ffffff';
}
