/**
 * Single-click placing (Libraries tiles): a double-click is two clicks, and must still place the
 * asset only once. The second click of a multi-click (`MouseEvent.detail` > 1) is ignored, and so
 * is a repeat on the same tile within a short window (synthetic or keyboard clicks report
 * detail 0/1, and a slow double-click can arrive as two single clicks on some systems).
 */

/** A repeat click on the same tile within this many ms is not a new placement. */
export const REPEAT_PLACE_MS = 400;

export type PlaceGuard = (id: string, detail: number, now: number) => boolean;

/** Returns a guard answering "should this click place `id`?". Pure apart from its own memory. */
export function createPlaceGuard(windowMs = REPEAT_PLACE_MS): PlaceGuard {
  let last: { id: string; t: number } | null = null;
  return (id, detail, now) => {
    if (detail > 1) return false;
    if (last && last.id === id && now - last.t >= 0 && now - last.t < windowMs) return false;
    last = { id, t: now };
    return true;
  };
}
