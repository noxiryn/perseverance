/** Small pure color helpers for sampling (unit-testable). */

/**
 * Alpha-weighted average color of a size×size block centered on (x, y) in an RGBA buffer.
 * Returns null when every sampled pixel is fully transparent or the point is outside.
 */
export function averageColor(
  data: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  size: number,
): { r: number; g: number; b: number; a: number } | null {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const half = Math.floor(size / 2);
  let r = 0,
    g = 0,
    b = 0,
    a = 0,
    n = 0;
  for (let yy = Math.max(0, y - half); yy <= Math.min(height - 1, y + half); yy++) {
    for (let xx = Math.max(0, x - half); xx <= Math.min(width - 1, x + half); xx++) {
      const i = (yy * width + xx) * 4;
      const al = data[i + 3];
      r += data[i] * al;
      g += data[i + 1] * al;
      b += data[i + 2] * al;
      a += al;
      n++;
    }
  }
  if (a <= 0 || n === 0) return null;
  return { r: Math.round(r / a), g: Math.round(g / a), b: Math.round(b / a), a: a / n / 255 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
