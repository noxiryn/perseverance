/** Pure layout helpers for template building (unit tested). */

/** Font size that makes text measured at `measuredWidth` (with `fontSize`) exactly `targetWidth` wide. */
export function fitFontSize(fontSize: number, measuredWidth: number, targetWidth: number, maxFontSize = Infinity): number {
  if (!(measuredWidth > 0) || !(targetWidth > 0)) return fontSize;
  const next = (fontSize * targetWidth) / measuredWidth;
  return Math.max(4, Math.min(maxFontSize, Math.round(next * 10) / 10));
}

/**
 * Transform for a thin box representing the segment (x1,y1)→(x2,y2): the box is `length` wide and
 * `thickness` tall, rotated about its center (the layer transform pivots on the box center).
 */
export function segmentTransform(x1: number, y1: number, x2: number, y2: number, thickness: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.max(1, Math.hypot(dx, dy));
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  return {
    x: cx - length / 2,
    y: cy - thickness / 2,
    width: length,
    height: Math.max(0.5, thickness),
    rotation: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}

/** Polygon (as SVG path data) for a regular burst with `points` spikes inside a viewBox of size×size. */
export function burstPath(points: number, inner: number, size = 1000, jitter = 0, seed = 1): string {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const c = size / 2;
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const outer = i % 2 === 0;
    const r = (outer ? c : c * inner) * (1 - (outer ? jitter * rand() : 0));
    parts.push(`${i === 0 ? 'M' : 'L'}${(c + Math.cos(a) * r).toFixed(1)} ${(c + Math.sin(a) * r).toFixed(1)}`);
  }
  return `${parts.join(' ')} Z`;
}

/** Scale a box (x, y, w, h) about the document origin. */
export function scaleBox(b: { x: number; y: number; width: number; height: number }, s: number) {
  return { x: b.x * s, y: b.y * s, width: b.width * s, height: b.height * s };
}
