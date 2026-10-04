/**
 * Text style presets: one click sets the text properties AND the layer effects (sizes scale with the
 * font size) — the looks used in the reference thumbnails (gothic poster titles, condensed
 * thumbnail names, signature subtitles, comic/cartoon game titles, kanji watermarks…).
 */
import type { LayerEffect, ParamValues, TextProps } from '../../core/types';
import { uid } from '../../core/ids';

export interface TextStylePreset {
  id: string;
  name: string;
  description: string;
  /** Text properties set by the preset (content and size are kept). */
  text: Partial<TextProps>;
  /** Layer opacity (defaults to 1). */
  opacity?: number;
  /** Layer effects for a given font size (px). */
  effects: (size: number) => { effectId: string; params: ParamValues }[];
  /** Card preview (DOM): sample text, colors and CSS approximating the effects. */
  preview: { sample: string; bg: string; color: string; shadow?: string; stroke?: string; size?: number; tracking?: string };
}

const r = (v: number) => Math.max(1, Math.round(v));

export const TEXT_STYLES: TextStylePreset[] = [
  {
    id: 'gothic-title',
    name: 'Gothic Title',
    description: 'Blackletter poster title with a faint offset duplicate',
    text: { fontFamily: 'UnifrakturMaguntia', fontWeight: 400, fontStyle: 'normal', fill: { type: 'solid', color: '#0d0d0d' }, uppercase: false, letterSpacing: 0, lineHeight: 1.05, stroke: null, fauxBold: false, fauxItalic: false },
    effects: (s) => [{ effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.25, angle: 140, distance: r(s * 0.08), spread: 0, size: 0, blendMode: 'multiply' } }],
    preview: { sample: 'Birdcage', bg: '#ebe7de', color: '#0d0d0d', shadow: '4px 3px 0 rgba(0,0,0,0.22)', size: 26 },
  },
  {
    id: 'condensed-impact',
    name: 'Condensed Impact',
    description: 'Huge white condensed name with a long shadow',
    text: { fontFamily: 'Anton', fontWeight: 400, fontStyle: 'normal', fill: { type: 'solid', color: '#ffffff' }, uppercase: true, letterSpacing: 0, lineHeight: 1, stroke: null, fauxBold: false, fauxItalic: false },
    effects: (s) => [{ effectId: 'long-shadow', params: { color: '#000000', angle: 135, length: r(s * 0.4), opacity: 0.85, fade: true } }],
    preview: { sample: 'ARES', bg: '#141414', color: '#ffffff', shadow: '1px 1px 0 #000, 2px 2px 0 #000, 3px 3px 0 #000, 4px 4px 0 rgba(0,0,0,0.7), 5px 5px 0 rgba(0,0,0,0.4)', size: 26 },
  },
  {
    id: 'signature',
    name: 'Signature',
    description: 'Handwritten signature subtitle',
    text: { fontFamily: 'Mrs Saint Delafield', fontWeight: 400, fontStyle: 'normal', fill: { type: 'solid', color: '#111111' }, uppercase: false, letterSpacing: 0, lineHeight: 1.1, stroke: null, fauxBold: false, fauxItalic: false },
    effects: () => [],
    preview: { sample: 'Frarenn K.', bg: '#e9e6df', color: '#111111', size: 28 },
  },
  {
    id: 'serif-quote',
    name: 'Serif Quote',
    description: 'Spaced roman capitals for quotes and small titles',
    text: { fontFamily: 'Cinzel', fontWeight: 500, fontStyle: 'normal', fill: { type: 'solid', color: '#eeeeee' }, uppercase: true, letterSpacing: 2, lineHeight: 1.15, stroke: null, fauxBold: false, fauxItalic: false },
    effects: (s) => [{ effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.6, angle: 120, distance: r(s * 0.04), spread: 0, size: r(s * 0.1), blendMode: 'multiply' } }],
    preview: { sample: '"ETERNITY"', bg: '#121212', color: '#eeeeee', shadow: '0 2px 4px rgba(0,0,0,0.8)', size: 17, tracking: '0.08em' },
  },
  {
    id: 'comic',
    name: 'Comic',
    description: 'Yellow comic title with a double stroke and hard shadow',
    text: { fontFamily: 'Bangers', fontWeight: 400, fontStyle: 'normal', fill: { type: 'solid', color: '#ffd21f' }, uppercase: true, letterSpacing: 2, lineHeight: 1, stroke: null, fauxBold: false, fauxItalic: false },
    effects: (s) => [
      { effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.9, angle: 120, distance: r(s * 0.12), spread: 0.6, size: r(s * 0.02), blendMode: 'normal' } },
      { effectId: 'stroke', params: { color: '#ffffff', size: r(s * 0.15), position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
      { effectId: 'stroke', params: { color: '#111111', size: r(s * 0.07), position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
    ],
    preview: { sample: 'POW!', bg: '#2f6fe0', color: '#ffd21f', stroke: '1.5px #111', shadow: '0 0 0 #fff, -2px -2px 0 #fff, 2px -2px 0 #fff, -2px 2px 0 #fff, 2px 2px 0 #fff, 4px 4px 0 #000', size: 26 },
  },
  {
    id: 'horror-drip',
    name: 'Horror Drip',
    description: 'Dripping red horror title with a dark red glow',
    text: { fontFamily: 'Creepster', fontWeight: 400, fontStyle: 'normal', fill: { type: 'solid', color: '#c4141c' }, uppercase: false, letterSpacing: 1, lineHeight: 1.05, stroke: null, fauxBold: false, fauxItalic: false },
    effects: (s) => [
      { effectId: 'outer-glow', params: { color: '#a00b12', opacity: 0.7, size: r(s * 0.28), spread: 0.08, blendMode: 'normal' } },
      { effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.8, angle: 120, distance: r(s * 0.03), spread: 0, size: r(s * 0.06), blendMode: 'multiply' } },
    ],
    preview: { sample: 'Horror', bg: '#0b0b0b', color: '#c4141c', shadow: '0 0 8px rgba(190,10,20,0.9), 0 0 2px #500', size: 28 },
  },
  {
    id: 'kanji-watermark',
    name: 'Kanji Watermark',
    description: 'Faint serif kanji behind a title (15% opacity)',
    text: { fontFamily: 'Noto Serif JP', fontWeight: 700, fontStyle: 'normal', fill: { type: 'solid', color: '#ffffff' }, uppercase: false, letterSpacing: 4, lineHeight: 1.1, stroke: null, fauxBold: false, fauxItalic: false },
    opacity: 0.15,
    effects: () => [],
    preview: { sample: '永遠の英雄', bg: '#121212', color: 'rgba(255,255,255,0.35)', size: 20 },
  },
  {
    id: 'cartoon-sim',
    name: 'Cartoon Sim',
    description: 'Chunky simulator-game title: thick outline + drop shadow',
    text: { fontFamily: 'Luckiest Guy', fontWeight: 400, fontStyle: 'normal', fill: { type: 'solid', color: '#ffffff' }, uppercase: true, letterSpacing: 1, lineHeight: 1, stroke: null, fauxBold: false, fauxItalic: false },
    effects: (s) => [
      { effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.85, angle: 110, distance: r(s * 0.14), spread: 0.8, size: r(s * 0.02), blendMode: 'normal' } },
      { effectId: 'stroke', params: { color: '#1b1b1b', size: r(s * 0.12), position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
    ],
    preview: { sample: 'SIM!', bg: 'linear-gradient(160deg,#53c0ff,#2a7cf0)', color: '#ffffff', stroke: '1.5px #1b1b1b', shadow: '-2px -2px 0 #1b1b1b, 2px -2px 0 #1b1b1b, -2px 2px 0 #1b1b1b, 2px 2px 0 #1b1b1b, 3px 4px 0 #000', size: 26 },
  },
  {
    id: 'newspaper-headline',
    name: 'Newspaper Headline',
    description: 'Tight black condensed headline',
    text: { fontFamily: 'Anton', fontWeight: 400, fontStyle: 'normal', fill: { type: 'solid', color: '#111111' }, uppercase: true, letterSpacing: -1, lineHeight: 0.95, stroke: null, fauxBold: false, fauxItalic: false },
    effects: () => [],
    preview: { sample: 'THE NEWS.', bg: '#e6e3dc', color: '#111111', size: 24, tracking: '-0.01em' },
  },
  {
    id: 'bebas-headline',
    name: 'Bebas Headline',
    description: 'Clean condensed caps for headlines and labels',
    text: { fontFamily: 'Bebas Neue', fontWeight: 400, fontStyle: 'normal', fill: { type: 'solid', color: '#111111' }, uppercase: true, letterSpacing: 1, lineHeight: 0.95, stroke: null, fauxBold: false, fauxItalic: false },
    effects: () => [],
    preview: { sample: 'HEADLINE', bg: '#e6e3dc', color: '#111111', size: 25 },
  },
  {
    id: 'neon-sign',
    name: 'Neon Sign',
    description: 'White tube letters with a cyan glow',
    text: { fontFamily: 'Audiowide', fontWeight: 400, fontStyle: 'normal', fill: { type: 'solid', color: '#f4fdff' }, uppercase: true, letterSpacing: 2, lineHeight: 1.1, stroke: null, fauxBold: false, fauxItalic: false },
    effects: (s) => [
      { effectId: 'outer-glow', params: { color: '#22d3ff', opacity: 0.9, size: r(s * 0.35), spread: 0.1, blendMode: 'screen' } },
      { effectId: 'outer-glow', params: { color: '#22d3ff', opacity: 0.8, size: r(s * 0.08), spread: 0.3, blendMode: 'screen' } },
    ],
    preview: { sample: 'NEON', bg: '#0b0f1a', color: '#f4fdff', shadow: '0 0 4px #22d3ff, 0 0 10px #22d3ff, 0 0 18px rgba(34,211,255,0.6)', size: 24 },
  },
  {
    id: 'royal-gold',
    name: 'Royal Gold',
    description: 'Decorative serif with a gold gradient and dark outline',
    text: {
      fontFamily: 'Cinzel Decorative',
      fontWeight: 900,
      fontStyle: 'normal',
      fill: {
        type: 'gradient',
        gradient: {
          kind: 'linear',
          angle: 90,
          scale: 1,
          stops: [
            { offset: 0, color: '#fff2b0' },
            { offset: 0.45, color: '#f2c14e' },
            { offset: 0.55, color: '#c7891c' },
            { offset: 1, color: '#ffe08a' },
          ],
        },
      },
      uppercase: false,
      letterSpacing: 1,
      lineHeight: 1.1,
      stroke: null,
      fauxBold: false,
      fauxItalic: false,
    },
    effects: (s) => [
      { effectId: 'stroke', params: { color: '#3a2203', size: r(s * 0.05), position: 'outside', opacity: 1, blendMode: 'normal', fillType: 'color' } },
      { effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.7, angle: 120, distance: r(s * 0.06), spread: 0, size: r(s * 0.08), blendMode: 'multiply' } },
    ],
    preview: { sample: 'Royal', bg: '#1c1430', color: '#f2c14e', stroke: '0.8px #3a2203', shadow: '0 2px 3px rgba(0,0,0,0.8)', size: 24 },
  },
];

export function getTextStyle(id: string | null | undefined): TextStylePreset | undefined {
  return id ? TEXT_STYLES.find((s) => s.id === id) : undefined;
}

/** Fresh LayerEffect instances of a preset for a font size. */
export function presetEffects(p: TextStylePreset, size: number): LayerEffect[] {
  return p.effects(Math.max(1, size)).map((e) => ({ id: uid('fx_'), effectId: e.effectId, enabled: true, params: { ...e.params } }));
}

/** Text props of a preset (deep-copied paints). */
export function presetTextProps(p: TextStylePreset): Partial<TextProps> {
  return structuredClone(p.text);
}
