/**
 * Built-in Looks (one-click styles). Filter/effect/asset ids and param keys follow
 * ARCHITECTURE.md §5.4–5.6; anything not registered at apply time is skipped gracefully.
 */
import type { CurvePoints, CurvesValue, Gradient } from '../core/types';
import type { ExtLookDef } from './engine';

/** Linear gradient from [offset, color] pairs. */
export function grad(stops: [number, string][], kind: Gradient['kind'] = 'linear', angle = 0): Gradient {
  return { kind, angle, scale: 1, stops: stops.map(([offset, color]) => ({ offset, color })) };
}

const ID: CurvePoints = [
  [0, 0],
  [255, 255],
];

export function curves(rgb: CurvePoints, r: CurvePoints = ID, g: CurvePoints = ID, b: CurvePoints = ID): CurvesValue {
  return { rgb, r, g, b };
}

/** Classic S-curve (contrast). */
export const S_CURVE = curves([
  [0, 0],
  [64, 50],
  [192, 208],
  [255, 255],
]);

/** Faded film: lifted blacks, softened whites. */
export const FADE_CURVE = curves([
  [0, 28],
  [70, 70],
  [190, 196],
  [255, 238],
]);

export const LOOK_CATEGORIES = ['Poster', 'Color Grade', 'Comic & Print', 'Atmosphere', 'Retro'] as const;

export const BUILTIN_LOOKS: ExtLookDef[] = [
  /* ---------------- reference styles ---------------- */
  {
    id: 'gothic-paper',
    name: 'Gothic Paper',
    category: 'Poster',
    description: 'Birdcage poster: cel-shaded character, off-white grungy paper, torn black border, muted contrast.',
    swatch: ['#ece8df', '#0b0b0b', '#6f63c9', '#a88b6c'],
    layerFilters: [
      {
        filterId: 'cel-shade',
        params: { levels: 4, smoothness: 0.15, outline: true, outlineThickness: 2, outlineColor: '#0b0b0b', edgeThreshold: 0.35, saturation: -10 },
      },
    ],
    overlays: [
      { assetId: 'paper-texture', params: { tone: '#ece8df', grain: 0.6, fibers: 0.5 }, blendMode: 'multiply', name: 'Paper Texture' },
      { assetId: 'grunge-paper', params: { tone: '#e4ddcf', stains: 0.4, edges: 0.5, cracks: 3 }, blendMode: 'multiply', opacity: 0.6, name: 'Grunge' },
      { assetId: 'torn-border', params: { color: '#0b0b0b', thickness: 44, roughness: 0.7 }, name: 'Torn Border' },
    ],
    adjustments: [
      { filterId: 'hue-saturation', params: { saturation: -22 }, name: 'Desaturate' },
      { filterId: 'curves', params: { curves: S_CURVE }, name: 'Contrast' },
    ],
  },
  {
    id: 'sunburst-halftone',
    name: 'Sunburst Halftone',
    category: 'Poster',
    description: 'Amber gradient map over everything, radial sunburst, halftone dots, creased paper and a warm glow.',
    swatch: ['#2a0d02', '#c2410c', '#f59e0b', '#ffe8b0'],
    layerEffects: [{ effectId: 'outer-glow', params: { color: '#ffc46b', opacity: 0.55, size: 36, blendMode: 'screen' } }],
    overlays: [
      { assetId: 'sunburst-rays', params: { rays: 120, center: { x: 0.5, y: 0.36 }, color: '#fff1c2', thickness: 0.25, fade: 0.8 }, blendMode: 'soft-light', opacity: 0.55, name: 'Sunburst' },
      { assetId: 'light-leak', params: { seed: 4 }, blendMode: 'screen', opacity: 0.45, name: 'Warm Glow' },
      { assetId: 'halftone-dots', params: { size: 6, angle: 45, color: '#2a0d00' }, blendMode: 'multiply', opacity: 0.35, name: 'Halftone' },
      { assetId: 'fold-creases', params: { folds: 3, strength: 0.6 }, blendMode: 'overlay', name: 'Fold Creases' },
    ],
    adjustments: [
      {
        filterId: 'gradient-map',
        params: {
          gradient: grad([
            [0, '#1c0802'],
            [0.35, '#7a2508'],
            [0.62, '#e8641a'],
            [0.85, '#ffb24d'],
            [1, '#fff0c8'],
          ]),
        },
        opacity: 0.88,
        name: 'Amber Gradient Map',
      },
      { filterId: 'brightness-contrast', params: { contrast: 14 }, name: 'Contrast' },
    ],
  },
  {
    id: 'noir-newspaper',
    name: 'Noir Newspaper',
    category: 'Poster',
    description: 'Black & white, hard levels, halftone dot screen, torn newspaper strips along the side edges, heavy shadow and vignette.',
    swatch: ['#0d0d0d', '#5a5a5a', '#bdbdbd', '#efede8'],
    layerEffects: [{ effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.9, angle: 125, distance: 26, spread: 0.1, size: 34 } }],
    overlays: [
      // Torn-edged strips down the left/right edges only, so content always stays visible.
      {
        assetId: 'newspaper-clippings',
        params: { columns: 3, tone: '#dcd9d0', density: 0.45, rotation: 6, placement: 'edges', textSize: 1.2, headlines: true, shadow: 0.5 },
        opacity: 0.95,
        name: 'Newspaper Clippings',
        mask: { kind: 'edge-strips', width: 0.11, sides: 'both', tear: 0.008, seed: 5 },
      },
      { assetId: 'halftone-dots', params: { size: 7, angle: 45, color: '#000000' }, blendMode: 'multiply', opacity: 0.3, name: 'Halftone' },
      { assetId: 'fold-creases', params: { folds: 4, strength: 0.75 }, blendMode: 'overlay', name: 'Fold Lines' },
      { assetId: 'vignette-overlay', params: { color: '#000000', amount: 0.7, softness: 0.6 }, blendMode: 'multiply', name: 'Vignette' },
    ],
    adjustments: [
      { filterId: 'black-white', params: {}, name: 'Black & White' },
      { filterId: 'levels', params: { inBlack: 22, inWhite: 232, gamma: 0.92 }, name: 'Levels' },
    ],
  },
  {
    id: 'crimson-film',
    name: 'Crimson Film',
    category: 'Poster',
    description: 'Red gradient map + halftone on the character, billowing red smoke, film scratches, creases and vignette.',
    swatch: ['#050505', '#5c0000', '#d0161b', '#ffd6cc'],
    layerFilters: [
      {
        filterId: 'gradient-map',
        params: {
          gradient: grad([
            [0, '#0a0000'],
            [0.4, '#6e0505'],
            [0.72, '#e0241f'],
            [1, '#fff1ea'],
          ]),
        },
      },
      { filterId: 'halftone', params: { shape: 'dot', size: 6, angle: 45, mode: 'mono', ink: '#220000', paper: '#ffffff', mix: 0.3 } },
    ],
    layerEffects: [{ effectId: 'outer-glow', params: { color: '#ff1f1f', opacity: 0.35, size: 40, blendMode: 'screen' } }],
    overlays: [
      { assetId: 'billow-smoke', params: { color: '#c4141c', highlight: '#ff4a3a', shadow: '#2a0204', density: 0.9, coverage: 0.55, side: 'right', seed: 7 }, blendMode: 'screen', opacity: 0.85, name: 'Red Smoke' },
      { assetId: 'film-scratches', params: { density: 0.55, color: '#ffffff' }, blendMode: 'screen', opacity: 0.6, name: 'Film Scratches' },
      { assetId: 'dust-specks', params: {}, blendMode: 'screen', opacity: 0.5, name: 'Dust' },
      { assetId: 'fold-creases', params: { folds: 4, strength: 0.6 }, blendMode: 'overlay', name: 'Fold Creases' },
      { assetId: 'vignette-overlay', params: { color: '#000000', amount: 0.65, softness: 0.55 }, blendMode: 'multiply', name: 'Vignette' },
    ],
    adjustments: [{ filterId: 'brightness-contrast', params: { contrast: 18 }, name: 'Contrast' }],
  },

  /* ---------------- color grades ---------------- */
  {
    id: 'toxic-green',
    name: 'Toxic Green',
    category: 'Color Grade',
    description: 'Radioactive green grade with a sickly glow and drifting fog.',
    swatch: ['#020a02', '#0f3d0b', '#39d353', '#d9ff7a'],
    layerEffects: [{ effectId: 'outer-glow', params: { color: '#5cff3d', opacity: 0.7, size: 28, blendMode: 'screen' } }],
    overlays: [
      { assetId: 'fog', params: { color: '#7dff6a' }, blendMode: 'screen', opacity: 0.3, name: 'Toxic Fog' },
      { assetId: 'film-grain', params: {}, blendMode: 'overlay', opacity: 0.35, name: 'Grain' },
    ],
    adjustments: [
      {
        filterId: 'gradient-map',
        params: {
          gradient: grad([
            [0, '#010501'],
            [0.4, '#0d3b0a'],
            [0.75, '#39d353'],
            [1, '#e4ff9a'],
          ]),
        },
        opacity: 0.75,
        name: 'Toxic Map',
      },
      { filterId: 'vibrance', params: { vibrance: 25 }, name: 'Vibrance' },
    ],
  },
  {
    id: 'royal-purple',
    name: 'Royal Purple',
    category: 'Color Grade',
    description: 'Regal violet grade with gold highlights, bokeh and sparkles.',
    swatch: ['#0a0414', '#3b1670', '#9b6bff', '#ffe29a'],
    layerEffects: [{ effectId: 'outer-glow', params: { color: '#b28cff', opacity: 0.6, size: 26, blendMode: 'screen' } }],
    overlays: [
      { assetId: 'bokeh', params: { color1: '#b28cff', color2: '#7a4dff', color3: '#ffe29a' }, blendMode: 'screen', opacity: 0.45, name: 'Bokeh' },
      { assetId: 'stars', params: { color: '#ffe29a' }, blendMode: 'screen', opacity: 0.7, name: 'Sparkles' },
      { assetId: 'vignette-overlay', params: { color: '#0a0414', amount: 0.55 }, blendMode: 'multiply', name: 'Vignette' },
    ],
    adjustments: [
      {
        filterId: 'gradient-map',
        params: {
          gradient: grad([
            [0, '#07020f'],
            [0.4, '#3b1670'],
            [0.75, '#9b6bff'],
            [1, '#ffe9b0'],
          ]),
        },
        opacity: 0.7,
        name: 'Royal Map',
      },
    ],
  },
  {
    id: 'ice-cold',
    name: 'Ice Cold',
    category: 'Color Grade',
    description: 'Frozen steel-blue grade with a frosty rim light, snow and mist.',
    swatch: ['#06121f', '#2b5d8a', '#9fd8ff', '#f2fbff'],
    layerFilters: [{ filterId: 'rim-light', params: { color: '#cdeeff', width: 14, angle: 135, intensity: 0.8 } }],
    layerEffects: [{ effectId: 'outer-glow', params: { color: '#9fd8ff', opacity: 0.55, size: 24, blendMode: 'screen' } }],
    overlays: [
      { assetId: 'fog', params: { color: '#cfe8ff' }, blendMode: 'screen', opacity: 0.3, name: 'Frost Mist' },
      { assetId: 'snow', params: {}, blendMode: 'screen', opacity: 0.8, name: 'Snow' },
    ],
    adjustments: [
      { filterId: 'color-lookup', params: { preset: 'cold-steel', intensity: 0.8 }, name: 'Cold Steel' },
      { filterId: 'color-balance', params: { shadowsB: 22, shadowsR: -8, midB: 12, highB: 6 }, name: 'Cool Balance' },
      { filterId: 'hue-saturation', params: { saturation: -15 }, name: 'Desaturate' },
    ],
  },
  {
    id: 'golden-hour',
    name: 'Golden Hour',
    category: 'Color Grade',
    description: 'Warm sunset light: golden rim, light leaks and floating dust.',
    swatch: ['#2b1405', '#a3541a', '#f5a524', '#fff0c4'],
    layerFilters: [{ filterId: 'rim-light', params: { color: '#ffd27a', width: 16, angle: 120, intensity: 0.85 } }],
    overlays: [
      { assetId: 'light-leak', params: {}, blendMode: 'screen', opacity: 0.6, name: 'Light Leak' },
      { assetId: 'dust-particles', params: { color: '#ffe2a8' }, blendMode: 'screen', opacity: 0.6, name: 'Dust Motes' },
    ],
    adjustments: [
      { filterId: 'color-lookup', params: { preset: 'golden', intensity: 0.8 }, name: 'Golden' },
      { filterId: 'photo-filter', params: { color: '#ec8a00', density: 0.28 }, name: 'Warming Filter' },
    ],
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    category: 'Retro',
    description: 'Pink/cyan split tone, chromatic fringing, neon grid floor and scanlines.',
    swatch: ['#1b0033', '#ff3cac', '#784ba0', '#2bd2ff'],
    layerFilters: [{ filterId: 'chromatic-aberration', params: { amount: 6, angle: 0 } }],
    layerEffects: [{ effectId: 'outer-glow', params: { color: '#ff3cac', opacity: 0.6, size: 22, blendMode: 'screen' } }],
    overlays: [
      { assetId: 'grid-floor', params: { color: '#ff3cac' }, blendMode: 'screen', opacity: 0.55, name: 'Neon Grid' },
      { assetId: 'scanlines-overlay', params: {}, blendMode: 'overlay', opacity: 0.3, name: 'Scanlines' },
    ],
    adjustments: [{ filterId: 'split-toning', params: { shadowColor: '#3a0ca3', highlightColor: '#ff6ec7', balance: 0, amount: 0.6 }, name: 'Split Tone' }],
  },
  {
    id: 'blood-moon',
    name: 'Blood Moon',
    category: 'Atmosphere',
    description: 'Deep crimson night with red clouds, embers and a heavy vignette.',
    swatch: ['#070000', '#4a0000', '#d01616', '#ffb199'],
    layerEffects: [{ effectId: 'outer-glow', params: { color: '#ff2a2a', opacity: 0.55, size: 32, blendMode: 'screen' } }],
    overlays: [
      { assetId: 'clouds', params: { color: '#5a0000' }, blendMode: 'multiply', opacity: 0.6, name: 'Red Clouds' },
      { assetId: 'sparks-embers', params: { color: '#ff5a2a' }, blendMode: 'screen', opacity: 0.8, name: 'Embers' },
      { assetId: 'vignette-overlay', params: { color: '#000000', amount: 0.75 }, blendMode: 'multiply', name: 'Vignette' },
    ],
    adjustments: [
      {
        filterId: 'gradient-map',
        params: {
          gradient: grad([
            [0, '#050000'],
            [0.45, '#4a0000'],
            [0.78, '#d01616'],
            [1, '#ffc2b0'],
          ]),
        },
        opacity: 0.8,
        name: 'Blood Map',
      },
    ],
  },
  {
    id: 'teal-orange',
    name: 'Teal & Orange',
    category: 'Color Grade',
    description: 'Blockbuster grade: teal shadows, orange skin tones, a touch of grain.',
    swatch: ['#0b2a33', '#0f5e6e', '#e98a3c', '#ffd2a1'],
    overlays: [
      { assetId: 'film-grain', params: {}, blendMode: 'overlay', opacity: 0.3, name: 'Grain' },
      { assetId: 'vignette-overlay', params: { color: '#000000', amount: 0.4 }, blendMode: 'multiply', name: 'Vignette' },
    ],
    adjustments: [
      { filterId: 'color-lookup', params: { preset: 'teal-orange', intensity: 0.85 }, name: 'Teal & Orange' },
      { filterId: 'split-toning', params: { shadowColor: '#0f5e6e', highlightColor: '#ffa552', balance: 10, amount: 0.35 }, name: 'Split Tone' },
      { filterId: 'vibrance', params: { vibrance: 18 }, name: 'Vibrance' },
    ],
  },
  {
    id: 'sepia-vintage',
    name: 'Sepia Vintage',
    category: 'Retro',
    description: 'Old photograph: sepia tint, faded curve, grunge paper, scratches and dust.',
    swatch: ['#2a1d12', '#6b4a2e', '#c49a6c', '#efe1c6'],
    overlays: [
      { assetId: 'grunge-paper', params: { tone: '#e9dcc3' }, blendMode: 'multiply', opacity: 0.6, name: 'Old Paper' },
      { assetId: 'film-scratches', params: { density: 0.4, color: '#f5ecd8' }, blendMode: 'screen', opacity: 0.45, name: 'Scratches' },
      { assetId: 'dust-specks', params: {}, blendMode: 'multiply', opacity: 0.5, name: 'Dust' },
      { assetId: 'vignette-overlay', params: { color: '#2a1d12', amount: 0.55 }, blendMode: 'multiply', name: 'Vignette' },
    ],
    adjustments: [
      { filterId: 'black-white', params: { tint: true, tintColor: '#c49a6c' }, name: 'Sepia' },
      { filterId: 'curves', params: { curves: FADE_CURVE }, name: 'Fade' },
    ],
  },
  {
    id: 'ink-monochrome',
    name: 'Ink Monochrome',
    category: 'Comic & Print',
    description: 'Manga ink: hard black outlines, two-tone shading, screentone and ink splatter on paper.',
    swatch: ['#000000', '#3a3a3a', '#d9d9d9', '#fbfaf6'],
    layerFilters: [
      { filterId: 'cel-shade', params: { levels: 3, smoothness: 0.05, outline: true, outlineThickness: 3, outlineColor: '#000000', saturation: -100 } },
    ],
    overlays: [
      { assetId: 'paper-texture', params: { tone: '#f4f1ea' }, blendMode: 'multiply', name: 'Paper' },
      { assetId: 'manga-screentone', params: {}, blendMode: 'multiply', opacity: 0.3, name: 'Screentone' },
      { assetId: 'ink-splatter', params: { color: '#000000' }, blendMode: 'multiply', opacity: 0.8, name: 'Ink Splatter' },
    ],
    adjustments: [
      { filterId: 'black-white', params: {}, name: 'Black & White' },
      { filterId: 'levels', params: { inBlack: 40, inWhite: 210, gamma: 1 }, name: 'Ink Levels' },
    ],
  },
  {
    id: 'comic-pop',
    name: 'Comic Pop',
    category: 'Comic & Print',
    description: 'Pop-art comic: bold outline, punchy colors, halftone dots and a hard offset shadow.',
    swatch: ['#111111', '#e63946', '#ffd166', '#118ab2'],
    layerFilters: [
      { filterId: 'cel-shade', params: { levels: 4, smoothness: 0.1, outline: true, outlineThickness: 3, outlineColor: '#111111', saturation: 35 } },
    ],
    layerEffects: [
      { effectId: 'stroke', params: { color: '#111111', size: 6, position: 'outside' } },
      { effectId: 'drop-shadow', params: { color: '#111111', opacity: 1, angle: 135, distance: 14, spread: 1, size: 0, blendMode: 'normal' } },
    ],
    overlays: [{ assetId: 'halftone-dots', params: { size: 9, angle: 22, color: '#e63946' }, blendMode: 'multiply', opacity: 0.28, name: 'Pop Dots' }],
    adjustments: [
      { filterId: 'vibrance', params: { vibrance: 35, saturation: 10 }, name: 'Vibrance' },
      { filterId: 'brightness-contrast', params: { contrast: 15 }, name: 'Contrast' },
    ],
  },
  {
    id: 'cyber-neon',
    name: 'Cyber Neon',
    category: 'Atmosphere',
    description: 'Cyberpunk: cyan/magenta glow, RGB split, scanlines and neon bokeh.',
    swatch: ['#0a0018', '#ff2bd6', '#00e5ff', '#e8f9ff'],
    layerFilters: [{ filterId: 'chromatic-aberration', params: { amount: 5, angle: 0 } }],
    layerEffects: [
      { effectId: 'outer-glow', params: { color: '#00f0ff', opacity: 0.75, size: 30, blendMode: 'screen' } },
      { effectId: 'stroke', params: { color: '#ff2bd6', size: 3, position: 'outside' } },
    ],
    overlays: [
      { assetId: 'bokeh', params: { color1: '#ff2bd6', color2: '#00e5ff', color3: '#7a5cff' }, blendMode: 'screen', opacity: 0.35, name: 'Neon Bokeh' },
      { assetId: 'scanlines-overlay', params: {}, blendMode: 'overlay', opacity: 0.35, name: 'Scanlines' },
    ],
    adjustments: [{ filterId: 'split-toning', params: { shadowColor: '#2a0050', highlightColor: '#00e5ff', balance: -10, amount: 0.55 }, name: 'Neon Split' }],
  },
  {
    id: 'inferno',
    name: 'Inferno',
    category: 'Atmosphere',
    description: 'Fire grade: black → red → orange → yellow map, embers, smoke and burning rim light.',
    swatch: ['#0a0000', '#8a1500', '#ff5a00', '#ffd23f'],
    layerFilters: [{ filterId: 'rim-light', params: { color: '#ffb000', width: 16, angle: 90, intensity: 0.9 } }],
    layerEffects: [{ effectId: 'outer-glow', params: { color: '#ff6a00', opacity: 0.7, size: 34, blendMode: 'screen' } }],
    overlays: [
      { assetId: 'billow-smoke', params: { color: '#ff5a1f', highlight: '#ffb347', shadow: '#3a0a00', side: 'bottom', coverage: 0.45, density: 0.7, seed: 23 }, blendMode: 'screen', opacity: 0.55, name: 'Fire Smoke' },
      { assetId: 'sparks-embers', params: { color: '#ffb347' }, blendMode: 'screen', opacity: 0.9, name: 'Embers' },
    ],
    adjustments: [
      {
        filterId: 'gradient-map',
        params: {
          gradient: grad([
            [0, '#070000'],
            [0.35, '#5a0a00'],
            [0.62, '#ff4d00'],
            [0.85, '#ffc400'],
            [1, '#fff7d6'],
          ]),
        },
        opacity: 0.85,
        name: 'Fire Map',
      },
    ],
  },
  {
    id: 'ghost-white',
    name: 'Ghost White',
    category: 'Atmosphere',
    description: 'Pale, washed-out spectral look with soft white glow and fog.',
    swatch: ['#8d939c', '#c9ced6', '#eef1f5', '#ffffff'],
    layerEffects: [{ effectId: 'outer-glow', params: { color: '#ffffff', opacity: 0.6, size: 42, blendMode: 'screen' } }],
    overlays: [
      { assetId: 'fog', params: { color: '#ffffff' }, blendMode: 'screen', opacity: 0.5, name: 'Fog' },
      { assetId: 'dust-particles', params: { color: '#ffffff' }, blendMode: 'screen', opacity: 0.6, name: 'Particles' },
    ],
    adjustments: [
      { filterId: 'hue-saturation', params: { saturation: -70, lightness: 8 }, name: 'Bleach' },
      { filterId: 'curves', params: { curves: FADE_CURVE }, name: 'Lift' },
      { filterId: 'exposure', params: { exposure: 0.35 }, name: 'Exposure' },
    ],
  },
  {
    id: 'midnight-blue',
    name: 'Midnight Blue',
    category: 'Color Grade',
    description: 'Moonlit night: deep blue grade, stars, soft mist and vignette.',
    swatch: ['#02030a', '#0b1a4a', '#3f6fd8', '#d6e6ff'],
    layerFilters: [{ filterId: 'rim-light', params: { color: '#a9c8ff', width: 12, angle: 135, intensity: 0.7 } }],
    overlays: [
      { assetId: 'stars', params: { color: '#d6e6ff' }, blendMode: 'screen', opacity: 0.65, name: 'Stars' },
      { assetId: 'fog', params: { color: '#3f6fd8' }, blendMode: 'screen', opacity: 0.25, name: 'Night Mist' },
      { assetId: 'vignette-overlay', params: { color: '#02030a', amount: 0.6 }, blendMode: 'multiply', name: 'Vignette' },
    ],
    adjustments: [
      {
        filterId: 'gradient-map',
        params: {
          gradient: grad([
            [0, '#01020a'],
            [0.45, '#0b1a4a'],
            [0.8, '#3f6fd8'],
            [1, '#e2ecff'],
          ]),
        },
        opacity: 0.65,
        name: 'Midnight Map',
      },
    ],
  },
  {
    id: 'retro-print',
    name: 'Retro Print',
    category: 'Comic & Print',
    description: 'Risograph/screen print: posterized ink colors, misregistration, paper grain and folds.',
    swatch: ['#1d3557', '#e63946', '#f1c453', '#f4ecd8'],
    layerFilters: [{ filterId: 'risograph', params: {} }],
    overlays: [
      { assetId: 'paper-texture', params: { tone: '#f1e8d6' }, blendMode: 'multiply', name: 'Print Paper' },
      { assetId: 'film-grain', params: {}, blendMode: 'overlay', opacity: 0.35, name: 'Grain' },
      { assetId: 'fold-creases', params: { folds: 2, strength: 0.5 }, blendMode: 'overlay', name: 'Folds' },
    ],
    adjustments: [{ filterId: 'posterize', params: { levels: 6 }, name: 'Posterize' }],
  },
  {
    id: 'anime-impact',
    name: 'Anime Impact',
    category: 'Comic & Print',
    description: 'Anime key frame: cel shading, white outline, speed lines and screentone.',
    swatch: ['#0d0d0d', '#ff3d3d', '#fefefe', '#3d7bff'],
    layerFilters: [
      { filterId: 'cel-shade', params: { levels: 3, smoothness: 0.1, outline: true, outlineThickness: 3, outlineColor: '#0d0d0d', saturation: 20 } },
    ],
    layerEffects: [
      { effectId: 'stroke', params: { color: '#ffffff', size: 8, position: 'outside' } },
      { effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.6, angle: 120, distance: 12, size: 18 } },
    ],
    overlays: [
      { assetId: 'speed-lines', params: { color: '#0d0d0d' }, blendMode: 'multiply', opacity: 0.75, name: 'Speed Lines' },
      { assetId: 'halftone-dots', params: { size: 6, angle: 45, color: '#0d0d0d' }, blendMode: 'multiply', opacity: 0.2, name: 'Screentone' },
    ],
    adjustments: [
      { filterId: 'vibrance', params: { vibrance: 22 }, name: 'Vibrance' },
      { filterId: 'brightness-contrast', params: { contrast: 18 }, name: 'Contrast' },
    ],
  },
  {
    id: 'faded-film',
    name: 'Faded Film',
    category: 'Retro',
    description: 'Washed-out analog film: faded curve, warm light leak and grain.',
    swatch: ['#2f2a2a', '#7b6d64', '#d8b99c', '#f3e9dc'],
    overlays: [
      { assetId: 'light-leak', params: { seed: 9 }, blendMode: 'screen', opacity: 0.5, name: 'Light Leak' },
      { assetId: 'film-grain', params: {}, blendMode: 'overlay', opacity: 0.45, name: 'Grain' },
      { assetId: 'dust-specks', params: {}, blendMode: 'screen', opacity: 0.35, name: 'Dust' },
    ],
    adjustments: [
      { filterId: 'color-lookup', params: { preset: 'faded-film', intensity: 0.9 }, name: 'Faded Film' },
      { filterId: 'curves', params: { curves: FADE_CURVE }, name: 'Fade' },
      { filterId: 'vibrance', params: { vibrance: -20 }, name: 'Mute' },
    ],
  },
  {
    id: 'glitch-signal',
    name: 'Glitch Signal',
    category: 'Retro',
    description: 'Corrupted broadcast: slice glitch, RGB split, scanlines and cold contrast.',
    swatch: ['#050510', '#ff004c', '#00ffd5', '#f0f0f0'],
    layerFilters: [
      { filterId: 'glitch', params: { amount: 0.5, slices: 14, seed: 7 } },
      { filterId: 'chromatic-aberration', params: { amount: 8, angle: 0 } },
    ],
    overlays: [{ assetId: 'scanlines-overlay', params: {}, blendMode: 'overlay', opacity: 0.4, name: 'Scanlines' }],
    adjustments: [
      { filterId: 'color-lookup', params: { preset: 'cross-process', intensity: 0.6 }, name: 'Cross Process' },
      { filterId: 'brightness-contrast', params: { contrast: 22 }, name: 'Contrast' },
    ],
  },
];
