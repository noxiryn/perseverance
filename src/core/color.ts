/** Color utilities. All channel values are 0..255 unless noted; h in degrees, s/l/v in 0..1. */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number; // 0..1
}

export function parseColor(input: string): RGBA {
  let s = input.trim();
  if (s.startsWith('#')) {
    s = s.slice(1);
    if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
    const n = parseInt(s.slice(0, 6), 16);
    const a = s.length >= 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

export function toHex(c: { r: number; g: number; b: number; a?: number }, withAlpha = false): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  if (withAlpha || (c.a !== undefined && c.a < 1)) return base + hex2((c.a ?? 1) * 255);
  return base;
}

export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  return toHex({ ...c, a: alpha }, true);
}

export function toCss(color: string): string {
  const c = parseColor(color);
  return `rgba(${c.r},${c.g},${c.b},${c.a})`;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Rec. 709 luma, 0..255 */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function mixColors(a: string, b: string, t: number): string {
  const ca = parseColor(a),
    cb = parseColor(b);
  return toHex(
    {
      r: ca.r + (cb.r - ca.r) * t,
      g: ca.g + (cb.g - ca.g) * t,
      b: ca.b + (cb.b - ca.b) * t,
      a: ca.a + (cb.a - ca.a) * t,
    },
    ca.a < 1 || cb.a < 1,
  );
}

/** Build a 256-entry RGBA lookup table from gradient stops (sorted by offset). */
export function gradientLUT(stops: { offset: number; color: string }[], reverse = false): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  const sorted = [...stops].sort((a, b) => a.offset - b.offset).map((s) => ({ o: s.offset, c: parseColor(s.color) }));
  if (sorted.length === 0) return lut;
  for (let i = 0; i < 256; i++) {
    let t = i / 255;
    if (reverse) t = 1 - t;
    let k = 0;
    while (k < sorted.length - 1 && sorted[k + 1].o < t) k++;
    const s0 = sorted[k];
    const s1 = sorted[Math.min(k + 1, sorted.length - 1)];
    const span = s1.o - s0.o;
    const f = span > 0 ? Math.max(0, Math.min(1, (t - s0.o) / span)) : t <= s0.o ? 0 : 1;
    const c0 = s0.c,
      c1 = t <= s0.o ? s0.c : s1.c;
    lut[i * 4] = c0.r + (c1.r - c0.r) * f;
    lut[i * 4 + 1] = c0.g + (c1.g - c0.g) * f;
    lut[i * 4 + 2] = c0.b + (c1.b - c0.b) * f;
    lut[i * 4 + 3] = (c0.a + (c1.a - c0.a) * f) * 255;
  }
  return lut;
}
