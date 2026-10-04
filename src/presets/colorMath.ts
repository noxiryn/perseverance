/**
 * Pure color helpers for the Color / Swatches panels: harmonies, WCAG contrast, human color
 * names (for swatch search & tooltips) and hex normalization.
 */
import { hsvToRgb, parseColor, rgbToHsl, rgbToHsv, toHex } from '../core/color';

/* ------------------------------ hex ------------------------------ */

/** Normalize user input ("f80", "#FF8800", "ff8800cc") to '#rrggbb' (alpha dropped) or null. */
export function normalizeHex(input: string): string | null {
  let s = input.trim().replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(s)) return null;
  if (s.length === 3 || s.length === 4) s = s.slice(0, 3).split('').map((c) => c + c).join('');
  else if (s.length === 8) s = s.slice(0, 6);
  if (s.length !== 6) return null;
  return `#${s}`;
}

/** '#rrggbb' without alpha. */
export function opaqueHex(c: string): string {
  const p = parseColor(c);
  return toHex({ r: p.r, g: p.g, b: p.b });
}

/* ------------------------------ harmonies ------------------------------ */

export type HarmonyKind = 'complementary' | 'analogous' | 'triadic' | 'split-complementary' | 'tetradic' | 'monochrome';

export const HARMONIES: { value: HarmonyKind; label: string }[] = [
  { value: 'complementary', label: 'Complementary' },
  { value: 'analogous', label: 'Analogous' },
  { value: 'triadic', label: 'Triadic' },
  { value: 'split-complementary', label: 'Split Complementary' },
  { value: 'tetradic', label: 'Tetradic' },
  { value: 'monochrome', label: 'Monochrome' },
];

function hsvHex(h: number, s: number, v: number): string {
  const [r, g, b] = hsvToRgb(((h % 360) + 360) % 360, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, v)));
  return toHex({ r, g, b });
}

/** Harmony colors for a base color (always includes the base itself). */
export function harmony(base: string, kind: HarmonyKind): string[] {
  const p = parseColor(base);
  const [h, s, v] = rgbToHsv(p.r, p.g, p.b);
  const b = toHex({ r: p.r, g: p.g, b: p.b });
  const rot = (deg: number) => hsvHex(h + deg, s, v);
  switch (kind) {
    case 'complementary':
      return [b, rot(180)];
    case 'analogous':
      return [rot(-60), rot(-30), b, rot(30), rot(60)];
    case 'triadic':
      return [b, rot(120), rot(240)];
    case 'split-complementary':
      return [b, rot(150), rot(210)];
    case 'tetradic':
      return [b, rot(90), rot(180), rot(270)];
    case 'monochrome': {
      // Same hue: shades and tints around the base.
      const out = [b];
      const steps: [number, number][] = [
        [s, v * 0.45],
        [s, v * 0.7],
        [s * 0.55, Math.min(1, v * 0.5 + 0.5)],
        [s * 0.25, Math.min(1, v * 0.3 + 0.7)],
      ];
      for (const [ss, vv] of steps) out.push(hsvHex(h, ss, vv));
      return out;
    }
  }
}

/* ------------------------------ WCAG contrast ------------------------------ */

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance (0..1). */
export function relativeLuminance(color: string): number {
  const p = parseColor(color);
  return 0.2126 * channel(p.r) + 0.7152 * channel(p.g) + 0.0722 * channel(p.b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type WcagLevel = 'AAA' | 'AA' | 'AA Large' | 'Fail';

export function wcagLevel(ratio: number): WcagLevel {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA Large';
  return 'Fail';
}

/* ------------------------------ names ------------------------------ */

const HUE_NAMES: [number, string][] = [
  [12, 'Red'],
  [24, 'Vermilion'],
  [40, 'Orange'],
  [52, 'Amber'],
  [65, 'Yellow'],
  [90, 'Lime'],
  [150, 'Green'],
  [172, 'Teal'],
  [195, 'Cyan'],
  [215, 'Azure'],
  [245, 'Blue'],
  [270, 'Indigo'],
  [292, 'Violet'],
  [318, 'Purple'],
  [340, 'Magenta'],
  [355, 'Pink'],
  [361, 'Red'],
];

/** A short human name for a color ("Dark Red", "Light Gray", "Brown"). Used for search/tooltips. */
export function describeColor(color: string): string {
  const p = parseColor(color);
  const [h, s, l] = rgbToHsl(p.r, p.g, p.b);
  if (l <= 0.06) return 'Black';
  if (l >= 0.96 && s < 0.5) return 'White';
  if (s < 0.12 || (l < 0.12 && s < 0.4)) {
    if (l < 0.25) return 'Dark Gray';
    if (l > 0.75) return 'Light Gray';
    return 'Gray';
  }
  let hue = 'Red';
  for (const [max, name] of HUE_NAMES) {
    if (h < max) {
      hue = name;
      break;
    }
  }
  // Browns: dark, desaturated oranges/ambers/reds.
  if (h >= 10 && h < 50 && l < 0.45 && s < 0.85) return l < 0.22 ? 'Dark Brown' : 'Brown';
  if (h >= 20 && h < 50 && l > 0.6 && s < 0.6) return 'Beige';
  if (h >= 340 || h < 12) {
    if (l > 0.7) return 'Pink';
  }
  if (l < 0.28) return `Dark ${hue}`;
  if (l > 0.78) return `${s < 0.5 ? 'Pale' : 'Light'} ${hue}`;
  if (s < 0.35) return `Muted ${hue}`;
  return hue;
}
