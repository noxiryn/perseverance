/** Zoom presets (Photoshop-like steps) and helpers. Pure. */

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

export const ZOOM_STEPS: readonly number[] = [
  0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.1, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24,
  32, 48, 64,
];

export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/** Next preset zoom above (dir = 1) or below (dir = -1) the current zoom. */
export function nextZoomStep(z: number, dir: 1 | -1): number {
  const eps = 1e-3;
  if (dir > 0) {
    for (const s of ZOOM_STEPS) if (s > z * (1 + eps)) return s;
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z * (1 - eps)) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

/** Zoom factor for a wheel event delta (pixels). Smooth for trackpads, ~1.2× per mouse notch. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-200, Math.min(200, px));
  return Math.exp(-clamped * 0.0018);
}

/** Zoom that fits a w×h document into a viewport with padding (fit) or covers it (fill). */
export function fitZoom(docW: number, docH: number, viewW: number, viewH: number, padding: number, mode: 'fit' | 'fill' = 'fit'): number {
  const aw = Math.max(1, viewW - padding * 2);
  const ah = Math.max(1, viewH - padding * 2);
  const zx = aw / Math.max(1, docW);
  const zy = ah / Math.max(1, docH);
  return clampZoom(mode === 'fit' ? Math.min(zx, zy) : Math.max(zx, zy));
}

/** Zoom + pan so that a document rect fills the viewport (zoom tool rectangle). */
export function zoomToRect(
  rect: { x: number; y: number; width: number; height: number },
  docW: number,
  docH: number,
  viewW: number,
  viewH: number,
): { zoom: number; panX: number; panY: number } {
  const z = clampZoom(Math.min(viewW / Math.max(1, rect.width), viewH / Math.max(1, rect.height)));
  // origin.x = viewW/2 + panX - docW*z/2 ; we want rect center at the viewport center.
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return { zoom: z, panX: (docW / 2 - cx) * z, panY: (docH / 2 - cy) * z };
}

/**
 * Clamp a pan so at least `keep` CSS px (or half the document, when smaller) of the document
 * stays inside the viewport on each axis, then nudge it so the document origin lands on a device
 * pixel. `view.panX/Y` is the offset of the document center from the viewport center.
 */
export function normalizePan(
  view: { zoom: number; panX: number; panY: number },
  docW: number,
  docH: number,
  viewW: number,
  viewH: number,
  dpr = 1,
  keep = 64,
): { panX: number; panY: number } {
  const z = view.zoom || 1;
  const dw = docW * z;
  const dh = docH * z;
  const mx = Math.min(keep, dw / 2, viewW / 2);
  const my = Math.min(keep, dh / 2, viewH / 2);
  const clampV = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : v < lo ? lo : v > hi ? hi : v);
  let panX = clampV(view.panX, mx - viewW / 2 - dw / 2, viewW / 2 - mx + dw / 2);
  let panY = clampV(view.panY, my - viewH / 2 - dh / 2, viewH / 2 - my + dh / 2);
  const d = dpr > 0 ? dpr : 1;
  const ox = viewW / 2 + panX - dw / 2;
  const oy = viewH / 2 + panY - dh / 2;
  panX -= (ox * d - Math.round(ox * d)) / d;
  panY -= (oy * d - Math.round(oy * d)) / d;
  return { panX, panY };
}

/** Human label for a zoom value (e.g. 0.461 → "46.1%"). */
export function formatZoom(z: number): string {
  const p = z * 100;
  if (p >= 100) return `${Math.round(p)}%`;
  if (p >= 10) return `${Math.round(p * 10) / 10}%`;
  return `${Math.round(p * 100) / 100}%`;
}
