/**
 * The four reference templates (docs/reference/ref1–ref4), rebuilt with editable layers:
 * fills, procedural assets, the placeholder character with smart filters/effects, live text,
 * shapes and adjustment layers. Anything another module hasn't registered is skipped.
 */
import { S_CURVE, curves, grad } from '../looks/defs';
import { tornPolygon } from '../looks/masks';
import { radial, solidPaint as solid, type DocBuilder } from './builder';
import { defineTemplate } from './define';
import { segmentTransform } from './layout';
import { BLACKLETTER_HEAVY, CONDENSED, KANJI, SERIF, SIGNATURE } from './fonts';

/** Vignette adjustment with an asset fallback (vignette filter → vignette-overlay asset). */
export function vignette(b: DocBuilder, amount = 0.6, color = '#000000', size = 0.58) {
  const adj = b.adjustment('vignette', { amount, size, feather: 0.6, roundness: 0, color }, { name: 'Vignette' });
  if (!adj) b.asset('vignette-overlay', { color, amount, softness: 0.6 }, { name: 'Vignette', blendMode: 'multiply' });
}

export { tornPolygon };

/** A katana as editable shapes (blade + guard + grip), from the tip to the hilt end. */
export function sword(b: DocBuilder, tipX: number, tipY: number, endX: number, endY: number, width: number, steel = '#2a2a2e', edge = '#d8d8dc') {
  return b.group(
    'Sword',
    () => {
      const len = Math.hypot(endX - tipX, endY - tipY);
      const hx = tipX + (endX - tipX) * 0.78;
      const hy = tipY + (endY - tipY) * 0.78;
      const blade = segmentTransform(tipX, tipY, hx, hy, width);
      b.shape(
        {
          kind: 'path',
          path: 'M0 50 L70 8 L1000 14 L1000 86 L70 92 Z',
          viewBox: [0, 0, 1000, 100],
          x: blade.x,
          y: blade.y,
          width: blade.width,
          height: blade.height,
          rotation: blade.rotation,
          fill: { type: 'gradient', gradient: { kind: 'linear', angle: 90, scale: 1, stops: [{ offset: 0, color: edge }, { offset: 0.35, color: steel }, { offset: 1, color: '#0c0c0e' }] } },
          stroke: null,
        },
        { name: 'Blade' },
      );
      const guard = segmentTransform(hx - ((endX - tipX) / len) * width * 0.4, hy - ((endY - tipY) / len) * width * 0.4, hx + ((endX - tipX) / len) * width * 0.4, hy + ((endY - tipY) / len) * width * 0.4, width * 2.6);
      b.shape({ kind: 'rect', ...guard, cornerRadius: width * 0.3, fill: solid('#141416'), stroke: null }, { name: 'Guard' });
      const grip = segmentTransform(hx, hy, endX, endY, width * 1.15);
      b.shape({ kind: 'rect', ...grip, cornerRadius: width * 0.4, fill: solid('#1b1b1f'), stroke: { paint: solid('#3a3a40'), width: Math.max(1, width * 0.12), align: 'inside', dash: [width * 0.5, width * 0.35] } }, { name: 'Grip' });
    },
    { collapsed: true },
  );
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
    b.group(
      'Paper',
      () => {
        b.solid('Paper Color', '#e9e8e4');
        b.asset('paper-texture', { tone: '#efeeea', grain: 0.6, fibers: 0.55, mottle: 0.7, seed: 7 }, { name: 'Paper Texture', blendMode: 'multiply' });
        b.asset(
          'grunge-paper',
          { tone: '#ebeae6', stains: 0.3, edges: 0.4, cracks: 4, scratches: 0.55, grain: 0.6, seed: 21 },
          { name: 'Grunge & Tears', blendMode: 'multiply', opacity: 0.85 },
        );
      },
      { collapsed: true },
    );

    b.group('Title', () => {
      const title = { fontFamily: BLACKLETTER_HEAVY, fontWeight: 700, fontSize: 200, anchor: 'center' as const, fitWidth: 560, lineHeight: 1.05 };
      b.text('Birdcage', { ...title, x: 512 + 18, y: 40 + 14, fill: solid('#9a9a9a') }, { name: 'Title Ghost', opacity: 0.45 });
      b.text('Birdcage', { ...title, x: 512, y: 40, fill: solid('#141414') }, { name: 'Title' });
    });

    const tendrils = b.asset(
      'swirl-tendrils',
      { color: '#0b0b0b', outlineColor: '#6f63c9', outlineWidth: 6, count: 6, thickness: 34, scale: 0.9, side: 'both', style: 'angular', spikes: 0.45, rimAngle: 135, seed: 5 },
      { name: 'Swirl Tendrils' },
    );

    const ch = b.character({ cx: 520, top: 330, height: 900, pose: 'idle', style: 'shaded', skin: '#caa47c', shirt: '#151518', pants: '#1c1c20', hair: '#6d6f99' });
    b.smartFilter(ch, 'cel-shade', {
      levels: 4,
      smoothness: 0.15,
      outline: true,
      outlineThickness: 3,
      outlineColor: '#111111',
      edgeThreshold: 0.35,
      saturation: -10,
    });

    // Small dark serif numeral on open paper at the right (like the ref). It is placed once the
    // tendrils are generated, in the first candidate spot the artwork leaves clear.
    const numeral = b.text('VII', { fontFamily: SERIF, fontWeight: 600, fontSize: 54, x: 914, y: 470, anchor: 'center', fill: solid('#161616') }, { name: 'Numeral' });
    b.effect(numeral, 'stroke', { color: '#e9e8e4', size: 2, position: 'outside' });

    b.adjustment('hue-saturation', { saturation: -28 }, { name: 'Desaturate' });
    b.adjustment('curves', { curves: S_CURVE }, { name: 'Contrast' });
    const border = b.asset('torn-border', { color: '#0b0b0b', thickness: 34, roughness: 0.7, burn: 0.55, flecks: 0.6, seed: 11 }, { name: 'Torn Border' });
    b.later('place numeral', () => {
      const spots: [number, number][] = [];
      for (const y of [470, 430, 510, 390, 550, 350, 590, 310, 630]) for (const x of [914, 944, 884, 960, 860]) spots.push([x, y]);
      b.placeTextInOpenSpace(numeral, spots, [tendrils, ch, border], 8);
    });
  },
});

/* ------------------------------------------------------------------ */
/* 2. Sunburst halftone icon                                           */
/* ------------------------------------------------------------------ */

const AMBER = grad([
  [0, '#1c0802'],
  [0.28, '#7a2508'],
  [0.52, '#e5601a'],
  [0.76, '#ffa53d'],
  [1, '#fff2cc'],
]);

/** Gentle contrast with deeper shadows (the ref's dark brown character against a hot center). */
const SUN_CURVE = curves([
  [0, 0],
  [64, 54],
  [176, 200],
  [255, 255],
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
    const hx = 296;
    const hy = 205;
    b.group(
      'Background',
      () => {
        b.gradient(
          'Warm Background',
          radial(
            [
              [0, '#ffc25a'],
              [0.5, '#f2801f'],
              [1, '#9a3008'],
            ],
            { offsetX: (hx / 512 - 0.5) * 2, offsetY: (hy / 512 - 0.5) * 2, scale: 1.4 },
          ),
        );
        b.asset('paper-texture', { tone: '#f3e3c8', grain: 0.6, fibers: 0.45, seed: 5 }, { name: 'Paper', blendMode: 'multiply', opacity: 0.7 });
        b.asset('grunge-paper', { tone: '#f0e2c6', stains: 0.5, edges: 0.8, cracks: 0, scratches: 0.4, seed: 13 }, { name: 'Worn Edges', blendMode: 'multiply', opacity: 0.6 });
      },
      { collapsed: true },
    );

    const rays = b.asset(
      'sunburst-rays',
      { rays: 140, center: { x: hx / 512, y: hy / 512 }, color: '#3a1200', thickness: 0.18, fade: 0.2, seed: 3 },
      { name: 'Sunburst Rays', blendMode: 'multiply', opacity: 0.55 },
    );
    b.radialMask(rays, hx, hy, 70, 235);

    b.group('Halo Rings', () => {
      for (const [i, r] of [104, 138, 172, 206].entries())
        b.ellipse(hx, hy, r, r, null, { name: `Ring ${i + 1}`, opacity: 0.55 - i * 0.1, stroke: { paint: solid('#3a1200'), width: 1.6, align: 'center', dash: [2, 5] } });
    });

    b.gradient(
      'Warm Glow',
      radial(
        [
          [0, '#fff7d6'],
          [0.35, '#ffd27acc'],
          [1, '#ffb34700'],
        ],
        { offsetX: (hx / 512 - 0.5) * 2, offsetY: (hy / 512 - 0.5) * 2, scale: 0.62 },
      ),
      { blendMode: 'screen', opacity: 0.9 },
    );

    const ch = b.character({ cx: 288, top: 132, height: 640, pose: 'idle', style: 'shaded', skin: '#e2c09a', shirt: '#7a4a32', pants: '#4a2c1e', hair: '#4a2c18' });
    b.smartFilter(ch, 'cel-shade', { levels: 4, smoothness: 0.2, outline: true, outlineThickness: 2, outlineColor: '#1a0a04', saturation: 0 });
    b.effect(ch, 'drop-shadow', { color: '#2a0c00', opacity: 0.55, angle: 120, distance: 8, size: 18 });

    // Light spilling over the face from behind (the ref's hot spot on the blank face).
    b.gradient(
      'Face Glow',
      radial(
        [
          [0, '#fff3c0'],
          [1, '#ffd27a00'],
        ],
        { offsetX: (hx / 512 - 0.5) * 2, offsetY: ((hy + 30) / 512 - 0.5) * 2, scale: 0.32 },
      ),
      { blendMode: 'screen', opacity: 0.55 },
    );

    b.group('Title', () => {
      const t = b.text('Birdcage', { fontFamily: BLACKLETTER_HEAVY, fontWeight: 700, fontSize: 92, x: 256, y: 18, anchor: 'center', fitWidth: 300, lineHeight: 1.05, fill: solid('#1b0c05') }, { name: 'Title' });
      const box = b.textBox(t);
      const midY = box.y + box.height * 0.5;
      b.rect(box.x - 12 - 40, midY - 2.5, 40, 5, solid('#1b0c05'), { name: 'Dash Left' });
      b.rect(box.x + box.width + 12, midY - 2.5, 40, 5, solid('#1b0c05'), { name: 'Dash Right' });
    });

    b.asset('halftone-dots', { size: 4, angle: 45, color: '#2a0d00', seed: 2 }, { name: 'Halftone', blendMode: 'multiply', opacity: 0.32 });
    b.asset('fold-creases', { folds: 3, strength: 0.75, seed: 8 }, { name: 'Fold Creases', blendMode: 'overlay' });
    b.adjustment('gradient-map', { gradient: AMBER }, { name: 'Amber Gradient Map', opacity: 0.88 });
    b.adjustment('curves', { curves: SUN_CURVE }, { name: 'Contrast' });
    vignette(b, 0.32, '#2a0a00', 0.7);
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
    b.group(
      'Paper',
      () => {
        b.solid('Paper Color', '#dedcd7');
        b.asset('paper-texture', { tone: '#e3e1dc', grain: 0.7, fibers: 0.5, mottle: 0.8, seed: 31 }, { name: 'Paper Texture', blendMode: 'multiply' });
        b.asset('grunge-paper', { tone: '#dedad2', stains: 0.5, edges: 0.7, cracks: 0, scratches: 0.4, seed: 9 }, { name: 'Grunge', blendMode: 'multiply', opacity: 0.7 });
      },
      { collapsed: true },
    );
    b.group('Newspaper Clippings', () => {
      // Clippings are confined by torn-edge masks: a strip down the left edge and a torn corner
      // at the bottom right (edit the masks to reveal more).
      const left = b.asset(
        'newspaper-clippings',
        { columns: 3, tone: '#d9d6cd', density: 0.25, rotation: 4, placement: 'left', textSize: 1.5, headlines: true, shadow: 0.5, seed: 3 },
        { name: 'Clippings (left)' },
      );
      b.mask(left, (ctx) =>
        tornPolygon(ctx, [
          [-20, -20],
          [262, -20],
          [236, 1100],
          [-20, 1100],
        ], 9, 5),
      );
      const br = b.asset(
        'newspaper-clippings',
        { columns: 3, tone: '#d6d3ca', density: 0.25, rotation: 8, placement: 'right', textSize: 1.4, headlines: true, shadow: 0.5, seed: 8 },
        { name: 'Clippings (bottom right)' },
      );
      b.mask(br, (ctx) =>
        tornPolygon(ctx, [
          [1500, 1100],
          [1556, 700],
          [1940, 640],
          [1940, 1100],
        ], 10, 9),
      );
      // Paper edge shadow under the torn strips.
      b.mask(b.solid('Strip Shadow', '#000000', { opacity: 0.18, blendMode: 'multiply' }), (ctx) => {
        ctx.filter = 'blur(10px)';
        tornPolygon(ctx, [[-20, -20], [270, -20], [244, 1100], [-20, 1100]], 9, 5);
        tornPolygon(ctx, [[1492, 1100], [1548, 692], [1940, 632], [1940, 1100]], 10, 9);
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'destination-out';
        tornPolygon(ctx, [[-20, -20], [262, -20], [236, 1100], [-20, 1100]], 9, 5);
        tornPolygon(ctx, [[1500, 1100], [1556, 700], [1940, 640], [1940, 1100]], 10, 9);
      });
    });

    b.group('Slash Lines', () => {
      b.segment(905, 545, 1860, 78, 4, solid('#111111'), { taper: true, name: 'Slash 1' });
      b.segment(770, 792, 1112, 548, 5, solid('#1a1a1a'), { taper: true, name: 'Slash 2', opacity: 0.85 });
      b.segment(0, 630, 344, 762, 6, solid('#111111'), { taper: true, name: 'Slash 3' });
    });

    b.group('Title', () => {
      b.text('THE EXTERMINATOR.', { fontFamily: CONDENSED, fontSize: 180, x: 960, y: 70, anchor: 'center', fitWidth: 1260, lineHeight: 1, fill: solid('#121212') }, { name: 'Title' });
      b.text('Your Name Here.', { fontFamily: SIGNATURE, fontSize: 84, x: 1010, y: 228, anchor: 'center', lineHeight: 1.1, fill: solid('#141414') }, { name: 'Signature' });
    });

    const left = b.character({ cx: 520, top: 600, height: 720, pose: 'sword', style: 'flat', silhouette: '#0c0c0c' });
    b.effect(left, 'drop-shadow', { color: '#000000', opacity: 0.8, angle: 120, distance: 34, spread: 0.15, size: 46, blendMode: 'multiply' });
    const right = b.character(
      { cx: 1530, top: 330, height: 1000, pose: 'back', style: 'shaded', skin: '#5e5e5e', shirt: '#2a2a2a', pants: '#232323', hair: '#151515', rotation: -14 },
      { name: 'Second Character (replace me)' },
    );
    b.effect(right, 'drop-shadow', { color: '#000000', opacity: 0.85, angle: 120, distance: 40, spread: 0.12, size: 52, blendMode: 'multiply' });
    const spray = b.asset('ink-splatter', { color: '#111111', count: 6, seed: 4 }, { name: 'Ink Spray', blendMode: 'multiply', opacity: 0.85 });
    b.radialMask(spray, 1440, 330, 40, 230);

    b.asset('halftone-dots', { size: 7, angle: 45, color: '#000000', seed: 1 }, { name: 'Halftone', blendMode: 'multiply', opacity: 0.3 });
    b.asset('fold-creases', { folds: 4, strength: 0.85, seed: 12 }, { name: 'Fold Lines', blendMode: 'overlay' });
    b.adjustment('black-white', {}, { name: 'Black & White' });
    b.adjustment('levels', { inBlack: 18, inWhite: 236, gamma: 0.95 }, { name: 'Levels' });
    vignette(b, 0.62, '#000000', 0.64);
  },
});

/* ------------------------------------------------------------------ */
/* 4. Crimson film thumbnail (Eternity)                                */
/* ------------------------------------------------------------------ */

const RED_MAP = grad([
  [0, '#0a0000'],
  [0.34, '#5c0404'],
  [0.6, '#d8261c'],
  [0.82, '#ff7a4a'],
  [1, '#fff4ec'],
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
    b.group(
      'Film',
      () => {
        b.solid('Black', '#070707');
        b.asset('film-scratches', { density: 0.6, color: '#ffffff', seed: 5 }, { name: 'Film Scratches', blendMode: 'screen', opacity: 0.6 });
        b.asset('dust-specks', { seed: 6 }, { name: 'Dust', blendMode: 'screen', opacity: 0.7 });
      },
      { collapsed: true },
    );

    b.group('Smoke', () => {
      b.smoke('Red Smoke', { color: '#d8161e', highlight: '#ff4a3a', shadow: '#3a0204', side: 'right', coverage: 0.72, density: 1, scale: 1.1, curl: 0.5, seed: 7 });
      b.gradient(
        'Red Glow',
        radial(
          [
            [0, '#ff2a1f'],
            [0.5, '#9c0a0a88'],
            [1, '#5a000000'],
          ],
          { offsetX: 0.5, offsetY: 0.1, scale: 0.7 },
        ),
        { blendMode: 'screen', opacity: 0.35 },
      );
    });

    const ch = b.character({ cx: 1410, top: 96, height: 1060, pose: 'idle', style: 'shaded', skin: '#e8cfb5', shirt: '#c2501e', pants: '#2a1a14', hair: '#140c0c', flipX: true });
    b.smartFilter(ch, 'gradient-map', { gradient: RED_MAP }, { opacity: 0.8 });
    b.smartFilter(ch, 'halftone', { shape: 'dot', size: 7, angle: 45, mode: 'mono', ink: '#1f0000', paper: '#ffffff', mix: 0.3 });
    b.effect(ch, 'outer-glow', { color: '#ff1a1a', opacity: 0.35, size: 44, blendMode: 'screen' });

    sword(b, 520, 650, 1240, 846, 26);

    const front = b.smoke('Smoke (front)', { color: '#c4141c', highlight: '#ff5a40', side: 'bottom', coverage: 0.5, density: 1, scale: 1.1, seed: 41 }, { blendMode: 'screen' });
    b.fadeMask(front, 860, 0, 1240, 0);

    b.asset('fold-creases', { folds: 4, strength: 0.6, seed: 4 }, { name: 'Fold Creases', blendMode: 'overlay' });
    vignette(b, 0.45, '#000000', 0.66);
    b.adjustment('brightness-contrast', { contrast: 15 }, { name: 'Contrast' });

    b.group('Title', () => {
      b.text('永遠の英雄', { fontFamily: KANJI, fontWeight: 700, fontSize: 88, x: 52, y: 24, fitWidth: 470, lineHeight: 1.05, fill: solid('#c8c8c8') }, { name: 'Kanji', opacity: 0.42 });
      b.text('ETERNITY', { fontFamily: SERIF, fontWeight: 600, fontSize: 84, x: 42, y: 30, fitWidth: 470, lineHeight: 1.05, letterSpacing: 2, fill: solid('#efefef') }, { name: 'Title' });
    });

    b.group('Name', () => {
      const name = b.text('YOUR NAME', { fontFamily: CONDENSED, fontSize: 150, x: 40, y: 842, lineHeight: 1, letterSpacing: 6, fill: solid('#f2f2f2') }, { name: 'Name' });
      b.effect(name, 'drop-shadow', { color: '#000000', opacity: 0.6, angle: 120, distance: 6, size: 10 });
      b.text('"FOR THEIR ONE AND ONLY HERO."', { fontFamily: SERIF, fontWeight: 500, fontSize: 40, x: 44, y: 1004, lineHeight: 1.05, letterSpacing: 1, fill: solid('#e8e8e8') }, { name: 'Quote' });
    });
    // Film texture over the type too (subtle), like a printed still.
    b.asset('dust-specks', { seed: 16 }, { name: 'Dust (top)', blendMode: 'screen', opacity: 0.35 });
  },
});

export const REFERENCE_TEMPLATES = [gothicPaper, sunburstIcon, noirThumbnail, crimsonThumbnail];
