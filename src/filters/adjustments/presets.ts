/**
 * Per-adjustment presets (Photoshop-style "Preset" dropdown in the Properties editor) and the
 * adjustment ordering used by the panel grid and menus.
 */
import type { CurvesValue, Gradient, ParamValues } from '../../core/types';
import { gradientPresets, type FilterDef } from '../../registry';
import { resolveParams } from '../engine';

export interface AdjustmentPreset {
  name: string;
  params: ParamValues;
}

const pts = (...p: [number, number][]) => p;
const ID = pts([0, 0], [255, 255]);
const curves = (rgb = ID, r = ID, g = ID, b = ID): CurvesValue => ({ rgb, r, g, b });
const grad = (...stops: [number, string][]): Gradient => ({
  kind: 'linear',
  angle: 0,
  scale: 1,
  stops: stops.map(([offset, color]) => ({ offset, color })),
});

/** Static presets. Gradient Map presets are completed from the gradientPresets registry. */
export const STATIC_PRESETS: Record<string, AdjustmentPreset[]> = {
  'brightness-contrast': [
    { name: 'Increase Contrast', params: { brightness: 0, contrast: 35 } },
    { name: 'Brighten', params: { brightness: 45, contrast: 0 } },
    { name: 'Darken', params: { brightness: -45, contrast: 0 } },
    { name: 'Soft & Bright', params: { brightness: 25, contrast: -25 } },
    { name: 'Punchy (Legacy)', params: { brightness: 8, contrast: 35, legacy: true } },
  ],
  levels: [
    { name: 'Increase Contrast 1', params: { inBlack: 15, inWhite: 240 } },
    { name: 'Increase Contrast 2', params: { inBlack: 30, inWhite: 225 } },
    { name: 'Increase Contrast 3', params: { inBlack: 45, inWhite: 210 } },
    { name: 'Lighten Shadows', params: { gamma: 1.6 } },
    { name: 'Midtones Brighter', params: { gamma: 1.25 } },
    { name: 'Midtones Darker', params: { gamma: 0.8 } },
    { name: 'Darker', params: { gamma: 0.6, outWhite: 230 } },
    { name: 'Faded Matte', params: { outBlack: 30, outWhite: 235 } },
  ],
  curves: [
    { name: 'Increase Contrast', params: { curves: curves(pts([0, 0], [64, 52], [192, 204], [255, 255])) } },
    { name: 'Strong S', params: { curves: curves(pts([0, 0], [64, 36], [192, 220], [255, 255])) } },
    { name: 'Darker', params: { curves: curves(pts([0, 0], [128, 100], [255, 255])) } },
    { name: 'Lighter', params: { curves: curves(pts([0, 0], [128, 156], [255, 255])) } },
    { name: 'Negative', params: { curves: curves(pts([0, 255], [255, 0])) } },
    {
      name: 'Cross Process',
      params: {
        curves: curves(ID, pts([0, 0], [64, 44], [192, 216], [255, 255]), pts([0, 0], [64, 52], [192, 210], [255, 255]), pts([0, 36], [255, 204])),
      },
    },
    { name: 'Matte Fade', params: { curves: curves(pts([0, 34], [70, 76], [190, 196], [255, 238])) } },
    { name: 'Crushed Blacks', params: { curves: curves(pts([0, 0], [40, 6], [140, 132], [255, 255])) } },
  ],
  exposure: [
    { name: 'Plus 1.0', params: { exposure: 1 } },
    { name: 'Plus 2.0', params: { exposure: 2 } },
    { name: 'Minus 1.0', params: { exposure: -1 } },
    { name: 'Minus 2.0', params: { exposure: -2 } },
    { name: 'Lifted Shadows', params: { offset: 0.02, gamma: 1.15 } },
  ],
  vibrance: [
    { name: 'Subtle Pop', params: { vibrance: 30, saturation: 0 } },
    { name: 'Vivid', params: { vibrance: 60, saturation: 12 } },
    { name: 'Muted', params: { vibrance: -40, saturation: -10 } },
  ],
  'hue-saturation': [
    { name: 'Sepia', params: { colorize: true, hue: 35, saturation: 0, lightness: 0 } },
    { name: 'Old Style', params: { colorize: true, hue: 38, saturation: -40, lightness: -8 } },
    { name: 'Cyanotype', params: { colorize: true, hue: -150, saturation: 0, lightness: 0 } },
    { name: 'Crimson Wash', params: { colorize: true, hue: 0, saturation: 40, lightness: -10 } },
    { name: 'Desaturate', params: { hue: 0, saturation: -100, lightness: 0, colorize: false } },
    { name: 'Increase Saturation', params: { hue: 0, saturation: 30, lightness: 0, colorize: false } },
    { name: 'Strong Saturation', params: { hue: 0, saturation: 60, lightness: 0, colorize: false } },
  ],
  'color-balance': [
    { name: 'Warm', params: { midR: 18, midB: -18, highR: 8, highB: -10 } },
    { name: 'Cool', params: { midR: -15, midB: 18, shadowsB: 8 } },
    { name: 'Teal & Orange', params: { shadowsR: -22, shadowsB: 16, highR: 16, highG: 2, highB: -22 } },
    { name: 'Crimson Shadows', params: { shadowsR: 35, shadowsG: -10, shadowsB: -10 } },
    { name: 'Green Matrix', params: { midR: -10, midG: 22, midB: -12, shadowsG: 10 } },
  ],
  'black-white': [
    { name: 'High Contrast Red Filter', params: { reds: 120, yellows: 110, greens: -10, cyans: -50, blues: -50, magentas: 120 } },
    { name: 'High Contrast Blue Filter', params: { reds: -50, yellows: -30, greens: 20, cyans: 120, blues: 150, magentas: 60 } },
    { name: 'Infrared', params: { reds: -40, yellows: 235, greens: 144, cyans: -68, blues: -3, magentas: -107 } },
    { name: 'Green Filter', params: { reds: -20, yellows: 80, greens: 120, cyans: 60, blues: -40, magentas: -20 } },
    { name: 'Darker', params: { reds: 20, yellows: 40, greens: 20, cyans: 40, blues: 0, magentas: 60 } },
    { name: 'Lighter', params: { reds: 60, yellows: 80, greens: 60, cyans: 80, blues: 40, magentas: 100 } },
    { name: 'Sepia Tint', params: { tint: true, tintColor: '#b08d5e' } },
    { name: 'Cold Noir Tint', params: { reds: 70, yellows: 90, tint: true, tintColor: '#8ea4c8' } },
  ],
  'photo-filter': [
    { name: 'Warming Filter (85)', params: { color: '#ec8a00' } },
    { name: 'Warming Filter (LBA)', params: { color: '#fa9600' } },
    { name: 'Warming Filter (81)', params: { color: '#ebb113' } },
    { name: 'Cooling Filter (80)', params: { color: '#006dff' } },
    { name: 'Cooling Filter (LBB)', params: { color: '#005dff' } },
    { name: 'Cooling Filter (82)', params: { color: '#00b5ff' } },
    { name: 'Red', params: { color: '#ea1a1a', density: 0.3 } },
    { name: 'Sepia', params: { color: '#ac7a33', density: 0.4 } },
    { name: 'Violet', params: { color: '#6f3cff', density: 0.3 } },
  ],
  'channel-mixer': [
    { name: 'B&W with Red Filter', params: { monochrome: true, rr: 100, rg: 0, rb: 0 } },
    { name: 'B&W with Orange Filter', params: { monochrome: true, rr: 50, rg: 50, rb: 0 } },
    { name: 'B&W with Yellow Filter', params: { monochrome: true, rr: 34, rg: 66, rb: 0 } },
    { name: 'B&W with Green Filter', params: { monochrome: true, rr: 0, rg: 100, rb: 0 } },
    { name: 'B&W with Blue Filter', params: { monochrome: true, rr: 0, rg: 0, rb: 100 } },
    { name: 'B&W Infrared', params: { monochrome: true, rr: -70, rg: 200, rb: -30 } },
    { name: 'Swap Red & Blue', params: { monochrome: false, rr: 0, rg: 0, rb: 100, gr: 0, gg: 100, gb: 0, br: 100, bg: 0, bb: 0 } },
    { name: 'Teal Shift', params: { monochrome: false, rr: 80, rg: 10, rb: 10, gr: 0, gg: 100, gb: 10, br: 0, bg: 20, bb: 100 } },
  ],
  'gradient-map': [
    { name: 'Black → White', params: { gradient: grad([0, '#000000'], [1, '#ffffff']) } },
    { name: 'Sunburst Amber', params: { gradient: grad([0, '#1c0500'], [0.35, '#8a2500'], [0.7, '#f0881c'], [1, '#ffe7a6']) } },
    { name: 'Crimson Noir', params: { gradient: grad([0, '#000000'], [0.45, '#5c0008'], [0.8, '#e2202a'], [1, '#ffffff']) } },
    { name: 'Newsprint', params: { gradient: grad([0, '#0d0d0d'], [1, '#f1ece0']) } },
    { name: 'Gothic Violet', params: { gradient: grad([0, '#0b0b0b'], [0.5, '#3b2f6b'], [1, '#ece6d8']) } },
    { name: 'Cold Steel', params: { gradient: grad([0, '#05070d'], [0.5, '#3e5876'], [1, '#e8f1ff']) } },
    { name: 'Toxic', params: { gradient: grad([0, '#020a03'], [0.5, '#1f8a1f'], [1, '#eaff86']) } },
    { name: 'Sunset', params: { gradient: grad([0, '#1a0633'], [0.4, '#b0244f'], [0.75, '#ff8a3d'], [1, '#ffe9a8']) } },
  ],
  'selective-color': [
    { name: 'Rich Reds', params: { range: 'reds', redsC: -30, redsM: 12, redsY: 18, redsK: 5 } },
    { name: 'Warm Skin', params: { range: 'reds', redsC: -15, redsY: 10, yellowsM: 8, yellowsY: 12 } },
    { name: 'Teal Shadows', params: { range: 'blacks', blacksC: 18, blacksM: -4, blacksY: -12 } },
    { name: 'Deeper Blacks', params: { range: 'blacks', blacksK: 30 } },
    { name: 'Clean Whites', params: { range: 'whites', whitesC: 0, whitesY: -12, whitesK: -15 } },
    { name: 'Cinematic', params: { range: 'neutrals', neutralsC: 6, neutralsY: -6, blacksC: 15, blacksY: -10, whitesY: 10, method: 'absolute' } },
  ],
  posterize: [
    { name: '2 Levels', params: { levels: 2 } },
    { name: '3 Levels (Cel)', params: { levels: 3 } },
    { name: '4 Levels', params: { levels: 4 } },
    { name: '6 Levels', params: { levels: 6 } },
    { name: '8 Levels', params: { levels: 8 } },
  ],
  threshold: [
    { name: 'Low (64)', params: { level: 64 } },
    { name: 'Middle (128)', params: { level: 128 } },
    { name: 'High (192)', params: { level: 192 } },
  ],
  duotone: [
    { name: 'Noir Paper', params: { shadow: '#0b0b0b', highlight: '#efe9dc', contrast: 15 } },
    { name: 'Crimson', params: { shadow: '#140003', highlight: '#ff4b4b', contrast: 10 } },
    { name: 'Sunburst', params: { shadow: '#2a0a00', highlight: '#ffb347', contrast: 10 } },
    { name: 'Cyan Night', params: { shadow: '#04121f', highlight: '#73e3ff', contrast: 0 } },
    { name: 'Royal', params: { shadow: '#1a0633', highlight: '#c9a6ff', contrast: 0 } },
    { name: 'Toxic', params: { shadow: '#041a06', highlight: '#b6ff3b', contrast: 10 } },
    { name: 'Newspaper', params: { shadow: '#1d1d1d', highlight: '#f2ead6', contrast: 25 } },
  ],
  'split-toning': [
    { name: 'Teal & Orange', params: { shadowColor: '#0f6e78', highlightColor: '#ff9a3c', balance: 0, amount: 0.6 } },
    { name: 'Cold & Warm', params: { shadowColor: '#2a4c9a', highlightColor: '#ffc46b', balance: 10, amount: 0.5 } },
    { name: 'Crimson Shadows', params: { shadowColor: '#b0101c', highlightColor: '#ffe6c7', balance: -20, amount: 0.6 } },
    { name: 'Purple Haze', params: { shadowColor: '#4b1d8f', highlightColor: '#ff9ad5', balance: 0, amount: 0.55 } },
    { name: 'Vintage', params: { shadowColor: '#4a6b5a', highlightColor: '#e8c88a', balance: 0, amount: 0.5 } },
  ],
  'color-lookup': [
    { name: 'Teal & Orange', params: { preset: 'teal-orange', intensity: 1 } },
    { name: 'Bleach Bypass', params: { preset: 'bleach-bypass', intensity: 1 } },
    { name: 'Crimson', params: { preset: 'crimson', intensity: 1 } },
    { name: 'Cold Steel', params: { preset: 'cold-steel', intensity: 1 } },
    { name: 'Golden', params: { preset: 'golden', intensity: 1 } },
    { name: 'Faded Film', params: { preset: 'faded-film', intensity: 1 } },
    { name: 'Cross Process', params: { preset: 'cross-process', intensity: 1 } },
    { name: 'Noir', params: { preset: 'noir', intensity: 1 } },
    { name: 'Toxic', params: { preset: 'toxic', intensity: 1 } },
    { name: 'Royal', params: { preset: 'royal', intensity: 1 } },
  ],
  'solid-tint': [
    { name: 'Crimson Color', params: { color: '#c4141c', mode: 'color', amount: 0.85 } },
    { name: 'Amber Multiply', params: { color: '#f0a040', mode: 'multiply', amount: 1 } },
    { name: 'Cyan Screen', params: { color: '#1f6f8a', mode: 'screen', amount: 0.6 } },
    { name: 'Violet Soft Light', params: { color: '#6f63c9', mode: 'soft-light', amount: 1 } },
    { name: 'Red Overlay', params: { color: '#d01020', mode: 'overlay', amount: 0.7 } },
  ],
};

/** Presets for an adjustment (Gradient Map pulls 'Gradient Maps' entries from the registry first). */
export function presetsFor(filterId: string): AdjustmentPreset[] {
  const base = STATIC_PRESETS[filterId] ?? [];
  if (filterId !== 'gradient-map') return base;
  const fromRegistry = gradientPresets
    .list()
    .filter((g) => g.category === 'Gradient Maps')
    .map((g) => ({ name: g.name, params: { gradient: structuredClone(g.gradient), reverse: false } }));
  if (!fromRegistry.length) return base;
  const names = new Set(fromRegistry.map((p) => p.name.toLowerCase()));
  return [...fromRegistry, ...base.filter((p) => !names.has(p.name.toLowerCase()))];
}

/** Stable comparison key of resolved params. */
function key(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'number' ? Math.round(val * 1000) / 1000 : val));
}

/** Name of the preset matching the current params ('Default' / null for custom). */
export function matchPreset(def: FilterDef, params: ParamValues, presets: AdjustmentPreset[]): string | null {
  const cur = key(resolveParams(def, params));
  if (cur === key(resolveParams(def, {}))) return 'Default';
  for (const p of presets) if (key(resolveParams(def, p.params)) === cur) return p.name;
  return null;
}

/* ---------------- ordering ---------------- */

/** Panel rows / menu groups (Photoshop order). Unknown adjustment filters go in a last row. */
export const ADJUSTMENT_ROWS: string[][] = [
  ['brightness-contrast', 'levels', 'curves', 'exposure'],
  ['vibrance', 'hue-saturation', 'color-balance', 'black-white', 'photo-filter', 'channel-mixer', 'color-lookup'],
  ['invert', 'posterize', 'threshold', 'gradient-map', 'selective-color'],
  ['duotone', 'split-toning', 'solid-tint'],
];

/** Group the given adjustment defs into ordered rows (extra filters appended as a final row). */
export function orderAdjustments(defs: FilterDef[]): FilterDef[][] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const known = new Set(ADJUSTMENT_ROWS.flat());
  const rows = ADJUSTMENT_ROWS.map((row) => row.map((id) => byId.get(id)).filter((d): d is FilterDef => !!d));
  const extra = defs.filter((d) => !known.has(d.id)).sort((a, b) => a.name.localeCompare(b.name));
  if (extra.length) rows.push(extra);
  return rows.filter((r) => r.length);
}
