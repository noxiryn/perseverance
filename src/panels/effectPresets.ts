/**
 * Layer style presets (several effects at once) and fallback effect names. Effect ids and param
 * keys follow ARCHITECTURE.md §5.5 (effects are rendered by the renderer module).
 */
import type { ParamValues } from '../core/types';
import { effects } from '../registry';

/** Display names used when the effect definition is not (yet) registered. */
export const EFFECT_NAMES: Record<string, string> = {
  'drop-shadow': 'Drop Shadow',
  'outer-glow': 'Outer Glow',
  stroke: 'Stroke',
  'long-shadow': 'Long Shadow',
  'inner-shadow': 'Inner Shadow',
  'inner-glow': 'Inner Glow',
  'color-overlay': 'Color Overlay',
  'gradient-overlay': 'Gradient Overlay',
  'pattern-overlay': 'Pattern Overlay',
  bevel: 'Bevel & Emboss',
  satin: 'Satin',
};

/** Known effect ids in a sensible menu order (registered effects not listed here follow). */
export const EFFECT_ORDER = [
  'stroke',
  'drop-shadow',
  'long-shadow',
  'outer-glow',
  'inner-shadow',
  'inner-glow',
  'bevel',
  'satin',
  'color-overlay',
  'gradient-overlay',
  'pattern-overlay',
];

export function effectName(effectId: string): string {
  return effects.get(effectId)?.name ?? EFFECT_NAMES[effectId] ?? effectId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** All effect ids to offer in menus: registered ones (known order first) plus known fallbacks. */
export function effectMenuIds(): string[] {
  const registered = effects.list().map((e) => e.id);
  const known = EFFECT_ORDER.filter((id) => registered.includes(id) || !registered.length);
  const extra = registered.filter((id) => !EFFECT_ORDER.includes(id));
  return [...known, ...extra];
}

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  /** Colors for the preview chip: [text, background]. */
  swatch: [string, string];
  /** Effects in stacking order (index 0 = bottom, like LayerEffect lists). */
  effects: { effectId: string; params: ParamValues }[];
  /** CSS approximation of the look for the preset tile ("Aa" sample). */
  preview: { color: string; background: string; textShadow: string };
}

/** CSS text-shadow ring approximating an outside stroke of `r` px. */
export function cssRing(color: string, r: number): string {
  const out: string[] = [];
  const steps = Math.max(8, Math.round(r * 6));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push(`${(Math.cos(a) * r).toFixed(2)}px ${(Math.sin(a) * r).toFixed(2)}px 0 ${color}`);
  }
  return out.join(', ');
}

/** CSS text-shadow stack approximating a solid long shadow. */
function cssLong(color: string, len: number): string {
  return Array.from({ length: len }, (_, i) => `${i + 1}px ${i + 1}px 0 ${color}`).join(', ');
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'white-outline-shadow',
    name: 'White Outline + Shadow',
    description: 'Clean white stroke with a soft drop shadow — the classic thumbnail cut-out.',
    swatch: ['#ffffff', '#000000'],
    preview: { color: '#1c1c1c', background: '#6f6f6f', textShadow: `${cssRing('#ffffff', 1.6)}, 2px 3px 3px rgba(0,0,0,0.75)` },
    effects: [
      { effectId: 'stroke', params: { color: '#ffffff', size: 8, position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
      { effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.75, angle: 120, distance: 12, spread: 0.1, size: 18, blendMode: 'multiply' } },
    ],
  },
  {
    id: 'thick-black-stroke',
    name: 'Thick Black Stroke',
    description: 'Heavy black outline for comic and poster titles.',
    swatch: ['#000000', '#3a3a3a'],
    preview: { color: '#f4f4f4', background: '#8a8a8a', textShadow: cssRing('#000000', 2.2) },
    effects: [{ effectId: 'stroke', params: { color: '#000000', size: 14, position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } }],
  },
  {
    id: 'neon-glow',
    name: 'Neon Glow',
    description: 'Bright cyan tube glow with a hot white core.',
    swatch: ['#00e5ff', '#ffffff'],
    preview: { color: '#eaffff', background: '#0e1316', textShadow: '0 0 2px #ffffff, 0 0 5px #00e5ff, 0 0 10px #00e5ff, 0 0 16px #00b8d4' },
    effects: [
      { effectId: 'outer-glow', params: { color: '#00e5ff', opacity: 0.9, size: 36, spread: 0.05, blendMode: 'screen' } },
      { effectId: 'outer-glow', params: { color: '#00e5ff', opacity: 1, size: 10, spread: 0.35, blendMode: 'screen' } },
      { effectId: 'inner-glow', params: { color: '#ffffff', opacity: 0.85, size: 8, choke: 0.1, source: 'edge', blendMode: 'screen' } },
    ],
  },
  {
    id: 'long-shadow-title',
    name: 'Long Shadow Title',
    description: 'Solid 45° long shadow with a crisp outline.',
    swatch: ['#111111', '#f2b84b'],
    preview: { color: '#f2b84b', background: '#3a3a3a', textShadow: `${cssRing('#000000', 1)}, ${cssLong('#000000', 7)}` },
    effects: [
      { effectId: 'stroke', params: { color: '#000000', size: 5, position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
      { effectId: 'long-shadow', params: { color: '#000000', angle: 135, length: 90, opacity: 1, fade: false } },
    ],
  },
  {
    id: 'gothic-emboss',
    name: 'Gothic Emboss',
    description: 'Carved blackletter look: emboss, inner shade and a heavy shadow.',
    swatch: ['#2a2a2a', '#bdb6a6'],
    preview: { color: '#bdb6a6', background: '#4b4640', textShadow: '-1px -1px 0 rgba(255,255,255,0.55), 1px 1px 0 #000000, 2px 3px 4px rgba(0,0,0,0.7)' },
    effects: [
      {
        effectId: 'bevel',
        params: {
          style: 'emboss',
          depth: 1.2,
          size: 6,
          angle: 120,
          altitude: 30,
          highlightColor: '#ffffff',
          highlightOpacity: 0.55,
          shadowColor: '#000000',
          shadowOpacity: 0.75,
        },
      },
      { effectId: 'inner-shadow', params: { color: '#000000', opacity: 0.55, angle: 120, distance: 3, choke: 0, size: 6, blendMode: 'multiply' } },
      { effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.65, angle: 120, distance: 6, spread: 0, size: 10, blendMode: 'multiply' } },
    ],
  },
  {
    id: 'comic-pop',
    name: 'Comic Pop',
    description: 'Double stroke (black + white) with a hard offset shadow.',
    swatch: ['#ffd400', '#000000'],
    preview: { color: '#ffd400', background: '#e8483b', textShadow: `${cssRing('#000000', 1.2)}, ${cssRing('#ffffff', 2.6)}, 4px 4px 0 #000000` },
    // Same-kind effects stack in list order (later = on top): the wide white ring goes first so
    // the thin black ring stays visible on top of it.
    effects: [
      { effectId: 'stroke', params: { color: '#ffffff', size: 14, position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
      { effectId: 'stroke', params: { color: '#000000', size: 6, position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
      { effectId: 'drop-shadow', params: { color: '#000000', opacity: 1, angle: 135, distance: 10, spread: 1, size: 0, blendMode: 'normal' } },
    ],
  },
  {
    id: 'soft-glow',
    name: 'Soft Glow',
    description: 'Wide, gentle white halo.',
    swatch: ['#ffffff', '#8b7cf6'],
    preview: { color: '#ffffff', background: '#3b3554', textShadow: '0 0 6px #ffffff, 0 0 14px rgba(255,255,255,0.7)' },
    effects: [{ effectId: 'outer-glow', params: { color: '#ffffff', opacity: 0.6, size: 48, spread: 0, blendMode: 'screen' } }],
  },
  {
    id: 'inner-grit',
    name: 'Inner Grit',
    description: 'Dark, gritty edges for grunge and horror titles.',
    swatch: ['#5a5148', '#0b0b0b'],
    preview: { color: '#4d453d', background: '#d8d1c3', textShadow: '0 0 1px #000000, 1px 1px 1px rgba(0,0,0,0.6)' },
    effects: [
      { effectId: 'inner-shadow', params: { color: '#000000', opacity: 0.7, angle: 120, distance: 0, choke: 0.15, size: 18, blendMode: 'multiply' } },
      { effectId: 'inner-glow', params: { color: '#000000', opacity: 0.5, size: 10, choke: 0, source: 'edge', blendMode: 'multiply' } },
      { effectId: 'pattern-overlay', params: { assetId: 'grunge-paper', scale: 1, opacity: 0.45, blendMode: 'multiply', seed: 7 } },
    ],
  },
  {
    id: 'crimson-glow',
    name: 'Crimson Glow',
    description: 'Blood-red glow and dark rim, like the crimson film look.',
    swatch: ['#c4141c', '#2a0003'],
    preview: { color: '#f3f3f3', background: '#0b0b0b', textShadow: `${cssRing('#2a0003', 1)}, 0 0 6px #c4141c, 0 0 12px #c4141c` },
    effects: [
      { effectId: 'stroke', params: { color: '#2a0003', size: 3, position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
      { effectId: 'outer-glow', params: { color: '#c4141c', opacity: 0.85, size: 40, spread: 0.05, blendMode: 'screen' } },
      { effectId: 'inner-glow', params: { color: '#ff4a4a', opacity: 0.45, size: 8, choke: 0, source: 'edge', blendMode: 'screen' } },
    ],
  },
  {
    id: 'violet-rim',
    name: 'Violet Rim',
    description: 'Thin violet rim light with a soft purple bloom (gothic tendril look).',
    swatch: ['#6f63c9', '#0b0b0b'],
    preview: { color: '#0b0b0b', background: '#e9e5dc', textShadow: `${cssRing('#6f63c9', 1.4)}, 0 0 8px rgba(139,124,246,0.7)` },
    effects: [
      { effectId: 'stroke', params: { color: '#6f63c9', size: 4, position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
      { effectId: 'outer-glow', params: { color: '#8b7cf6', opacity: 0.55, size: 18, spread: 0, blendMode: 'screen' } },
    ],
  },
];
