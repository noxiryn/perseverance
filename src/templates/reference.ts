/**
 * The four reference templates (docs/reference/ref1–ref4), rebuilt with editable layers.
 */
import { S_CURVE, grad } from '../looks/defs';
import { radial, solidPaint as solid, type DocBuilder } from './builder';
import { defineTemplate } from './define';
import { BLACKLETTER, BLACKLETTER_HEAVY, CONDENSED, KANJI, SERIF, SIGNATURE } from './fonts';

/** Adjustment layer with an asset fallback (e.g. vignette filter → vignette-overlay asset). */
export function vignette(b: DocBuilder, amount = 0.6, color = '#000000') {
  const adj = b.adjustment('vignette', { amount, size: 0.58, feather: 0.6, roundness: 0, color }, { name: 'Vignette' });
  if (!adj) b.asset('vignette-overlay', { color, amount, softness: 0.6 }, { name: 'Vignette', blendMode: 'multiply' });
}

/* ------------------------------------------------------------------ */
/* 1. Gothic paper poster (Birdcage)                                   */
/* ------------------------------------------------------------------ */

export const gothicPaper = defineTemplate({
  id: 'tpl-gothic-paper',
  name: 'Gothic Paper Poster',
  category: 'Icon',
  description: 'Birdcage-style poster: grungy off-white paper, torn black border, blackletter title with an offset ghost, violet-rimmed tendrils and a cel-shaded character.',
  width: 1024,
  height: 1024,
  swatch: ['#ece8df', '#0b0b0b', '#6f63c9', '#a88b6c'],
  background: '#e9e8e4',
  fonts: [
    [BLACKLETTER_HEAVY, 700],
    [SERIF, 600],
  ],
  build(b) {
    b.solid('Paper', '#e9e8e4');
    b.asset('paper-texture', { tone: '#efeeea', grain: 0.6, fibers: 0.55, mottle: 0.7, seed: 7 }, { name: 'Paper Texture', blendMode: 'multiply' });
    b.asset(
      'grunge-paper',
      { tone: '#ebeae6', stains: 0.3, edges: 0.4, cracks: 4, scratches: 0.55, grain: 0.6, seed: 21 },
      { name: 'Grunge & Tears', blendMode: 'multiply', opacity: 0.8 },
    );

    b.group('Title', () => {
      const title = { fontFamily: BLACKLETTER_HEAVY, fontWeight: 700, fontSize: 200, anchor: 'center' as const, fitWidth: 500, lineHeight: 1.05 };
      b.text('Birdcage', { ...title, x: 512 + 16, y: 92 + 22, fill: solid('#8f8f8f') }, { name: 'Title Ghost', opacity: 0.4 });
      b.text('Birdcage', { ...title, x: 512, y: 92, fill: solid('#141414') }, { name: 'Title' });
    });

    b.asset(
      'swirl-tendrils',
      { color: '#0b0b0b', outlineColor: '#6f63c9', outlineWidth: 4, count: 6, thickness: 40, scale: 1.35, side: 'both', style: 'angular', spikes: 0.45, seed: 17 },
      { name: 'Swirl Tendrils' },
    );

    const ch = b.character({ cx: 512, top: 330, height: 1000, pose: 'arms-crossed', style: 'shaded', skin: '#caa47c', shirt: '#151518', pants: '#1c1c20', hair: '#6d6f99' });
    b.smartFilter(ch, 'cel-shade', {
      levels: 4,
      smoothness: 0.15,
      outline: true,
      outlineThickness: 3,
      outlineColor: '#111111',
      edgeThreshold: 0.35,
      saturation: -10,
    });

    b.text('VII', { fontFamily: SERIF, fontWeight: 600, fontSize: 56, x: 872, y: 452, anchor: 'center', fill: solid('#141414'), stroke: { color: '#e9e8e4', width: 7 } }, { name: 'Numeral' });

    b.adjustment('hue-saturation', { saturation: -28 }, { name: 'Desaturate' });
    b.adjustment('curves', { curves: S_CURVE }, { name: 'Contrast' });
    b.asset('torn-border', { color: '#0b0b0b', thickness: 34, roughness: 0.7, burn: 0.55, flecks: 0.6, seed: 11 }, { name: 'Torn Border' });
  },
});

/* ------------------------------------------------------------------ */
/* 2. Sunburst halftone icon                                           */
/* ------------------------------------------------------------------ */

const AMBER = grad([
  [0, '#1c0802'],
  [0.35, '#7a2508'],
  [0.62, '#e8641a'],
  [0.85, '#ffb24d'],
  [1, '#fff0c8'],
]);

export const sunburstIcon = defineTemplate({
  id: 'tpl-sunburst-icon',
  name: 'Sunburst Halftone Icon',
  category: 'Icon',
  description: 'Orange halftone icon: radial line burst behind the head, blackletter title flanked by dashes, amber gradient map, creased paper.',
  width: 512,
  height: 512,
  swatch: ['#2a0d02', '#c2410c', '#f59e0b', '#ffe8b0'],
  background: '#f07a1a',
  fonts: [[BLACKLETTER_HEAVY, 700]],
  build(b) {
    b.gradient(
      'Warm Background',
      radial(
        [
          [0, '#ffb547'],
          [0.55, '#f2801f'],
          [1, '#a83a0a'],
        ],
        { offsetX: 0.1, offsetY: -0.15, scale: 1.25 },
      ),
    );
    b.asset('paper-texture', { tone: '#f3e3c8', grain: 0.6, fibers: 0.45, seed: 5 }, { name: 'Paper', blendMode: 'multiply', opacity: 0.7 });
    b.asset(
      'sunburst-rays',
      { rays: 110, center: { x: 0.55, y: 0.4 }, color: '#fff3c4', thickness: 0.25, fade: 0.8, seed: 3 },
      { name: 'Sunburst Rays', blendMode: 'screen', opacity: 0.5 },
    );
    b.gradient(
      'Warm Glow',
      radial(
        [
          [0, '#fff4c2'],
          [0.4, '#ffd27a99'],
          [1, '#ffb34700'],
        ],
        { offsetX: 0.12, offsetY: -0.16, scale: 0.7 },
      ),
      { blendMode: 'screen', opacity: 0.85 },
    );

    b.group('Halo Rings', () => {
      for (const [i, r] of [92, 128, 166, 206].entries())
        b.ellipse(282, 214, r, r, null, { name: `Ring ${i + 1}`, opacity: 0.5 - i * 0.08, stroke: { paint: solid('#4a1600'), width: 2.2, align: 'center', dash: [3, 7] } });
    });

    const ch = b.character({ cx: 276, top: 128, height: 600, pose: 'idle', style: 'shaded', skin: '#e2c09a', shirt: '#9a6444', pants: '#5a3a28', hair: '#5a3a22' });
    b.smartFilter(ch, 'cel-shade', { levels: 4, smoothness: 0.2, outline: true, outlineThickness: 2, outlineColor: '#1a0a04', saturation: 0 });
    b.effect(ch, 'drop-shadow', { color: '#3a1200', opacity: 0.5, angle: 120, distance: 8, size: 18 });

    b.group('Title', () => {
      const t = b.text('Birdcage', { fontFamily: BLACKLETTER_HEAVY, fontWeight: 700, fontSize: 92, x: 256, y: 12, anchor: 'center', fitWidth: 330, lineHeight: 1.05, fill: solid('#1b0c05') }, { name: 'Title' });
      const box = b.textBox(t);
      const midY = box.y + box.height * 0.56;
      b.rect(box.x - 16 - 44, midY - 3, 44, 6, solid('#1b0c05'), { name: 'Dash Left' });
      b.rect(box.x + box.width + 16, midY - 3, 44, 6, solid('#1b0c05'), { name: 'Dash Right' });
    });

    b.asset('halftone-dots', { size: 5, angle: 45, color: '#2a0d00', seed: 2 }, { name: 'Halftone', blendMode: 'multiply', opacity: 0.35 });
    b.asset('fold-creases', { folds: 3, strength: 0.65, seed: 8 }, { name: 'Fold Creases', blendMode: 'overlay' });
    b.adjustment('gradient-map', { gradient: AMBER }, { name: 'Amber Gradient Map', opacity: 0.85 });
    b.adjustment('brightness-contrast', { contrast: 12 }, { name: 'Contrast' });
  },
});

/* ------------------------------------------------------------------ */
/* 3. Noir newspaper thumbnail (The Exterminator)                      */
/* ------------------------------------------------------------------ */

export const noirThumbnail = defineTemplate({
  id: 'tpl-noir-thumbnail',
  name: 'Noir Newspaper Thumbnail',
  category: 'Thumbnail',
  description: 'Grayscale newspaper collage: clippings on the edges, condensed headline with a signature subtitle, silhouettes with heavy shadows, slash lines, halftone and fold lines.',
  width: 1920,
  height: 1080,
  swatch: ['#0d0d0d', '#5a5a5a', '#bdbdbd', '#efede8'],
  background: '#dcdad5',
  fonts: [
    [CONDENSED, 400],
    [SIGNATURE, 400],
  ],
  build(b) {
    b.solid('Paper', '#dcdad5');
    b.asset('paper-texture', { tone: '#e3e1dc', grain: 0.7, fibers: 0.5, mottle: 0.8, seed: 31 }, { name: 'Paper Texture', blendMode: 'multiply' });
    b.asset('grunge-paper', { tone: '#dedad2', stains: 0.5, edges: 0.7, cracks: 0, scratches: 0.4, seed: 9 }, { name: 'Grunge', blendMode: 'multiply', opacity: 0.7 });
    b.asset(
      'newspaper-clippings',
      { columns: 3, tone: '#d9d6cd', density: 0.6, rotation: 8, placement: 'edges', textSize: 1.4, headlines: true, shadow: 0.5, seed: 3 },
      { name: 'Newspaper Clippings' },
    );

    b.group('Slash Lines', () => {
      b.segment(905, 545, 1860, 78, 4, solid('#111111'), { taper: true, name: 'Slash 1' });
      b.segment(770, 792, 1112, 548, 5, solid('#1a1a1a'), { taper: true, name: 'Slash 2', opacity: 0.85 });
      b.segment(0, 630, 344, 762, 6, solid('#111111'), { taper: true, name: 'Slash 3' });
    });

    b.group('Title', () => {
      b.text('THE EXTERMINATOR.', { fontFamily: CONDENSED, fontSize: 180, x: 960, y: 58, anchor: 'center', fitWidth: 1260, lineHeight: 1, fill: solid('#121212') }, { name: 'Title' });
      b.text('Your Name Here.', { fontFamily: SIGNATURE, fontSize: 92, x: 950, y: 222, anchor: 'center', lineHeight: 1.1, fill: solid('#141414') }, { name: 'Signature' });
    });

    const left = b.character({ cx: 520, top: 560, height: 760, pose: 'sword', style: 'flat', silhouette: '#0c0c0c' });
    b.effect(left, 'drop-shadow', { color: '#000000', opacity: 0.8, angle: 120, distance: 34, spread: 0.15, size: 46, blendMode: 'multiply' });
    const right = b.character(
      { cx: 1480, top: 90, height: 1150, pose: 'hero', style: 'shaded', skin: '#5e5e5e', shirt: '#2a2a2a', pants: '#232323', hair: '#151515', rotation: -12 },
      { name: 'Second Character (replace me)' },
    );
    b.effect(right, 'drop-shadow', { color: '#000000', opacity: 0.85, angle: 120, distance: 40, spread: 0.12, size: 52, blendMode: 'multiply' });
    b.asset('ink-splatter', { color: '#111111', seed: 4 }, { name: 'Ink Spray', x: 1290, y: 270, width: 380, height: 380, onlyElement: true, blendMode: 'multiply', opacity: 0.85 });

    b.asset('halftone-dots', { size: 7, angle: 45, color: '#000000', seed: 1 }, { name: 'Halftone', blendMode: 'multiply', opacity: 0.3 });
    b.asset('fold-creases', { folds: 4, strength: 0.85, seed: 12 }, { name: 'Fold Lines', blendMode: 'overlay' });
    b.adjustment('black-white', {}, { name: 'Black & White' });
    b.adjustment('levels', { inBlack: 18, inWhite: 236, gamma: 0.95 }, { name: 'Levels' });
    vignette(b, 0.75);
  },
});

/* ------------------------------------------------------------------ */
/* 4. Crimson film thumbnail (Eternity)                                */
/* ------------------------------------------------------------------ */

const RED_MAP = grad([
  [0, '#0a0000'],
  [0.38, '#6e0505'],
  [0.7, '#e0241f'],
  [1, '#fff1ea'],
]);

export const crimsonThumbnail = defineTemplate({
  id: 'tpl-crimson-thumbnail',
  name: 'Crimson Film Thumbnail',
  category: 'Thumbnail',
  description: 'Black scratched film, red smoke behind a red-tinted halftone character, huge condensed name with a serif quote, small serif title over faint kanji.',
  width: 1920,
  height: 1080,
  swatch: ['#050505', '#5c0000', '#d0161b', '#ffd6cc'],
  background: '#070707',
  fonts: [
    [CONDENSED, 400],
    [SERIF, 600],
    [SERIF, 500],
    [KANJI, 700, '永遠の英雄'],
  ],
  build(b) {
    b.solid('Black', '#070707');
    b.asset('film-scratches', { density: 0.6, color: '#ffffff', seed: 5 }, { name: 'Film Scratches', blendMode: 'screen', opacity: 0.55 });
    b.asset('dust-specks', { seed: 6 }, { name: 'Dust', blendMode: 'screen', opacity: 0.6 });
    b.asset(
      'smoke',
      { color: '#c4141c', density: 0.8, scale: 1.1, turbulence: 0.6, coverage: 0.62, side: 'right', glow: 0.6, seed: 19 },
      { name: 'Red Smoke' },
    );

    const ch = b.character({ cx: 1400, top: 60, height: 1250, pose: 'sword', style: 'shaded', skin: '#e8cfb5', shirt: '#b8361e', pants: '#2a1a14', hair: '#140c0c' });
    b.smartFilter(ch, 'gradient-map', { gradient: RED_MAP }, { opacity: 0.85 });
    b.smartFilter(ch, 'halftone', { shape: 'dot', size: 7, angle: 45, mode: 'mono', ink: '#1f0000', paper: '#ffffff', mix: 0.3 });
    b.effect(ch, 'outer-glow', { color: '#ff1a1a', opacity: 0.35, size: 44, blendMode: 'screen' });
    b.asset('smoke', { color: '#d11a1a', density: 0.55, coverage: 0.32, side: 'right', seed: 41 }, { name: 'Smoke (front)', blendMode: 'screen', opacity: 0.75 });

    b.group('Title', () => {
      b.text('永遠の英雄', { fontFamily: KANJI, fontWeight: 700, fontSize: 88, x: 50, y: 26, fitWidth: 472, lineHeight: 1.05, fill: solid('#bdbdbd') }, { name: 'Kanji', opacity: 0.3 });
      b.text('ETERNITY', { fontFamily: SERIF, fontWeight: 600, fontSize: 84, x: 40, y: 32, fitWidth: 472, lineHeight: 1.05, letterSpacing: 2, fill: solid('#efefef') }, { name: 'Title' });
    });

    b.group('Name', () => {
      const name = b.text('YOUR NAME', { fontFamily: CONDENSED, fontSize: 158, x: 40, y: 858, lineHeight: 1, letterSpacing: 4, fill: solid('#f2f2f2') }, { name: 'Name' });
      b.effect(name, 'drop-shadow', { color: '#000000', opacity: 0.6, angle: 120, distance: 6, size: 10 });
      b.text('"FOR THEIR ONE AND ONLY HERO."', { fontFamily: SERIF, fontWeight: 500, fontSize: 42, x: 44, y: 1004, lineHeight: 1.05, letterSpacing: 1, fill: solid('#e8e8e8') }, { name: 'Quote' });
    });

    b.asset('fold-creases', { folds: 4, strength: 0.6, seed: 4 }, { name: 'Fold Creases', blendMode: 'overlay' });
    vignette(b, 0.6);
    b.adjustment('brightness-contrast', { contrast: 15 }, { name: 'Contrast' });
  },
});

export const REFERENCE_TEMPLATES = [gothicPaper, sunburstIcon, noirThumbnail, crimsonThumbnail];

