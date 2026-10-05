/**
 * Additional genre templates: versus, update banner, simulator, horror, anime action, showcase,
 * group banner, YouTube story thumbnail and a badge emblem.
 */
import type { Paint, StrokeStyle } from '../core/types';
import { linear, radial, solidPaint as solid } from './builder';
import { defineTemplate } from './define';
import { BANGERS, BEBAS, CARTOON, HORROR, KANJI, SERIF, TYPEWRITER } from './fonts';
import { burstPath } from './layout';
import { vignette } from './reference';

const stroke = (color: string, width: number, align: StrokeStyle['align'] = 'center'): StrokeStyle => ({ paint: solid(color), width, align, join: 'round' });
const gradPaint = (stops: [number, string][], angle = 90): Paint => ({ type: 'gradient', gradient: linear(stops, angle) });
const textStroke = (color: string, width: number) => ({ color, width });

/* ------------------------------------------------------------------ */
/* Versus                                                              */
/* ------------------------------------------------------------------ */

export const versus = defineTemplate({
  id: 'tpl-versus',
  name: 'Versus Split',
  category: 'Thumbnail',
  description: 'Diagonal red vs blue split, two fighters, a yellow “VS” burst and player names.',
  width: 1920,
  height: 1080,
  swatch: ['#7a0010', '#ff3b3b', '#ffd23f', '#1e4bff'],
  background: '#7a0010',
  fonts: [
    [BANGERS, 400],
    [BEBAS, 400],
  ],
  build(b) {
    b.gradient(
      'Red Side',
      linear(
        [
          [0, '#ff4141'],
          [1, '#6d000d'],
        ],
        20,
      ),
    );
    b.path(
      'M560 0 L1000 0 L1000 1000 L440 1000 Z',
      [0, 0, 1000, 1000],
      { x: 0, y: 0, width: 1920, height: 1080 },
      gradPaint(
        [
          [0, '#0b1d8f'],
          [1, '#3d7bff'],
        ],
        200,
      ),
      { name: 'Blue Side' },
    );
    b.asset('speed-lines', { color: '#ffffff', seed: 2 }, { name: 'Speed Lines', blendMode: 'overlay', opacity: 0.35 });
    b.asset('halftone-dots', { size: 8, angle: 45, color: '#000000', seed: 3 }, { name: 'Halftone', blendMode: 'multiply', opacity: 0.18 });
    const divider = b.segment(1095, -30, 825, 1110, 22, solid('#ffffff'), { taper: true, name: 'Divider' });
    b.effect(divider, 'outer-glow', { color: '#ffffff', opacity: 0.8, size: 24, blendMode: 'screen' });

    const p1 = b.character({ cx: 470, top: 190, height: 900, pose: 'sword', style: 'shaded', shirt: '#9e1020', pants: '#3a0a10', hair: '#1a0b0b' });
    b.effect(p1, 'stroke', { color: '#ffffff', size: 6, position: 'outside' });
    b.effect(p1, 'drop-shadow', { color: '#000000', opacity: 0.6, angle: 120, distance: 16, size: 24 });
    const p2 = b.character(
      { cx: 1450, top: 210, height: 880, pose: 'action', style: 'shaded', shirt: '#1534b8', pants: '#0b1640', hair: '#d8d0c0', flipX: true },
      { name: 'Second Character (replace me)' },
    );
    b.effect(p2, 'stroke', { color: '#ffffff', size: 6, position: 'outside' });
    b.effect(p2, 'drop-shadow', { color: '#000000', opacity: 0.6, angle: 60, distance: 16, size: 24 });

    b.group('VS', () => {
      const burst = b.path(burstPath(16, 0.72, 1000, 0.12, 5), [0, 0, 1000, 1000], { x: 960 - 210, y: 470 - 210, width: 420, height: 420 }, solid('#ffd23f'), {
        name: 'Burst',
        stroke: stroke('#111111', 10),
      });
      b.effect(burst, 'drop-shadow', { color: '#000000', opacity: 0.55, angle: 120, distance: 12, size: 14 });
      const vs = b.text('VS', { fontFamily: BANGERS, fontSize: 230, x: 960, y: 340, anchor: 'center', lineHeight: 1, fill: solid('#ffffff'), stroke: textStroke('#111111', 12), rotation: -8 }, { name: 'VS' });
      b.effect(vs, 'long-shadow', { color: '#111111', angle: 135, length: 22, opacity: 1 });
    });

    b.text('PLAYER 1', { fontFamily: BEBAS, fontSize: 120, x: 70, y: 930, letterSpacing: 4, lineHeight: 1, fill: solid('#ffffff') }, { name: 'Player 1' });
    b.text('PLAYER 2', { fontFamily: BEBAS, fontSize: 120, x: 1850, y: 930, anchor: 'end', letterSpacing: 4, lineHeight: 1, fill: solid('#ffffff') }, { name: 'Player 2' });
    vignette(b, 0.45);
  },
});

/* ------------------------------------------------------------------ */
/* Update banner                                                       */
/* ------------------------------------------------------------------ */

export const updateBanner = defineTemplate({
  id: 'tpl-update-banner',
  name: 'Update Announcement',
  category: 'Thumbnail',
  description: 'Bright “UPDATE 2” announcement: cartoon lettering with thick outlines, sunburst sky, stars and an “OUT NOW” badge.',
  width: 1920,
  height: 1080,
  swatch: ['#0a4fd6', '#2aa7ff', '#ffe14d', '#ff4d6d'],
  background: '#1a7af0',
  fonts: [
    [CARTOON, 400],
    [BANGERS, 400],
  ],
  build(b) {
    b.gradient(
      'Sky',
      linear([
        [0, '#38b6ff'],
        [1, '#0a4fd6'],
      ]),
    );
    b.asset('sunburst-rays', { rays: 36, center: { x: 0.36, y: 0.46 }, color: '#ffffff', thickness: 0.5, fade: 0.5, seed: 4 }, { name: 'Sunburst', blendMode: 'screen', opacity: 0.35 });
    b.asset('clouds', { color: '#ffffff', seed: 8 }, { name: 'Clouds', opacity: 0.6 });
    b.asset('stars', { color: '#fff7c2', seed: 6 }, { name: 'Sparkles', blendMode: 'screen', opacity: 0.8 });

    const ch = b.character({ cx: 1500, top: 170, height: 900, pose: 'hero', style: 'shaded', shirt: '#ff4d6d', pants: '#2b2b6b', hair: '#ffcc33' });
    b.effect(ch, 'stroke', { color: '#0b2a6b', size: 8, position: 'outside' });
    b.effect(ch, 'outer-glow', { color: '#ffffff', opacity: 0.7, size: 30, blendMode: 'screen' });

    b.group('Title', () => {
      const up = b.text('UPDATE', { fontFamily: CARTOON, fontSize: 230, x: 110, y: 190, lineHeight: 1, fill: solid('#ffe14d'), stroke: textStroke('#1a1a40', 14), rotation: -4 }, { name: 'Update' });
      b.effect(up, 'long-shadow', { color: '#0b1f5c', angle: 135, length: 26, opacity: 1 });
      const box = b.textBox(up);
      const two = b.text('2', { fontFamily: CARTOON, fontSize: 400, x: box.x + box.width + 30, y: 90, lineHeight: 1, fill: solid('#ff4d6d'), stroke: textStroke('#1a1a40', 16), rotation: 8 }, { name: 'Number' });
      b.effect(two, 'long-shadow', { color: '#0b1f5c', angle: 135, length: 30, opacity: 1 });
      const sub = b.text('NEW MAP • PETS • 2X COINS', { fontFamily: BANGERS, fontSize: 82, x: 120, y: 560, letterSpacing: 3, lineHeight: 1, fill: solid('#ffffff'), stroke: textStroke('#1a1a40', 8) }, { name: 'Subtitle' });
      b.effect(sub, 'drop-shadow', { color: '#0b1f5c', opacity: 0.8, angle: 120, distance: 8, size: 4 });
    });

    b.group('Badge', () => {
      const badge = b.rect(120, 700, 430, 120, solid('#ff3355'), { name: 'Badge', cornerRadius: 60, stroke: stroke('#1a1a40', 8), rotation: -3 });
      b.effect(badge, 'drop-shadow', { color: '#0b1f5c', opacity: 0.7, angle: 120, distance: 10, size: 6 });
      b.text('OUT NOW!', { fontFamily: CARTOON, fontSize: 84, x: 335, y: 716, anchor: 'center', lineHeight: 1, fill: solid('#ffffff'), rotation: -3 }, { name: 'Badge Text' });
    });

    b.group('Stars', () => {
      const stars: [number, number, number, number][] = [
        [980, 160, 46, 12],
        [1060, 470, 30, -10],
        [640, 620, 36, 18],
        [1820, 120, 40, -6],
      ];
      for (const [x, y, r, rot] of stars) b.star(x, y, r, 5, 0.48, solid('#ffe14d'), { stroke: stroke('#1a1a40', 6), rotation: rot, name: 'Star' });
    });
  },
});

/* ------------------------------------------------------------------ */
/* Simulator (bright cartoon)                                          */
/* ------------------------------------------------------------------ */

export const simulatorBright = defineTemplate({
  id: 'tpl-simulator-bright',
  name: 'Simulator Bright',
  category: 'Thumbnail',
  description: 'Bright simulator thumbnail: sunny gradient, cartoon title with thick outline, coins, stars and a big multiplier.',
  width: 1920,
  height: 1080,
  swatch: ['#ff5e3a', '#ff9a1f', '#fff36b', '#7cff4f'],
  background: '#ff9a1f',
  fonts: [
    [CARTOON, 400],
    [BANGERS, 400],
  ],
  build(b) {
    b.gradient(
      'Sunny Background',
      radial([
        [0, '#fff36b'],
        [0.5, '#ff9a1f'],
        [1, '#ff4f3a'],
      ]),
    );
    b.asset('sunburst-rays', { rays: 28, center: { x: 0.5, y: 0.55 }, color: '#ffffff', thickness: 0.55, fade: 0.4, seed: 2 }, { name: 'Sunburst', blendMode: 'screen', opacity: 0.4 });
    b.asset('roblox-studs', { seed: 1 }, { name: 'Studs', blendMode: 'overlay', opacity: 0.15 });

    b.group('Coins', () => {
      const coins: [number, number, number][] = [
        [250, 760, 90],
        [430, 900, 70],
        [1620, 760, 96],
        [1450, 930, 64],
        [1760, 420, 60],
        [170, 420, 58],
      ];
      for (const [x, y, r] of coins) {
        const coin = b.ellipse(x, y, r, r, { type: 'gradient', gradient: radial([[0, '#fff3a0'], [0.6, '#ffc61a'], [1, '#d48a00']], { offsetX: -0.25, offsetY: -0.25 }) }, { name: 'Coin', stroke: stroke('#8a5200', Math.max(5, r * 0.09)) });
        b.effect(coin, 'drop-shadow', { color: '#7a2e00', opacity: 0.5, angle: 120, distance: 8, size: 8 });
        b.text('$', { fontFamily: CARTOON, fontSize: r * 1.2, x, y: y - r * 0.62, anchor: 'center', lineHeight: 1, fill: solid('#a86400') }, { name: 'Coin $' });
      }
    });

    const ch = b.character({ cx: 960, top: 330, height: 760, pose: 'hero', style: 'shaded', shirt: '#2ecc71', pants: '#1f4f8f', hair: '#4a2a12' });
    b.effect(ch, 'stroke', { color: '#ffffff', size: 10, position: 'outside' });
    b.effect(ch, 'drop-shadow', { color: '#7a2e00', opacity: 0.55, angle: 120, distance: 18, size: 20 });

    b.group('Title', () => {
      const mega = b.rect(760, 40, 400, 96, solid('#ff3355'), { name: 'Tag', cornerRadius: 22, stroke: stroke('#5b1a00', 8), rotation: -2 });
      b.effect(mega, 'drop-shadow', { color: '#5b1a00', opacity: 0.6, angle: 120, distance: 8, size: 4 });
      b.text('MEGA', { fontFamily: CARTOON, fontSize: 76, x: 960, y: 50, anchor: 'center', lineHeight: 1, fill: solid('#ffffff'), rotation: -2 }, { name: 'Tag Text' });
      const t = b.text('SIMULATOR', { fontFamily: CARTOON, fontSize: 210, x: 960, y: 140, anchor: 'center', fitWidth: 1300, lineHeight: 1, fill: solid('#ffffff'), stroke: textStroke('#5b2a00', 16) }, { name: 'Title' });
      b.effect(t, 'long-shadow', { color: '#5b2a00', angle: 135, length: 24, opacity: 1 });
    });

    const x = b.text('x1000', { fontFamily: BANGERS, fontSize: 170, x: 1500, y: 470, anchor: 'center', lineHeight: 1, fill: solid('#7cff4f'), stroke: textStroke('#0f4d00', 12), rotation: 10 }, { name: 'Multiplier' });
    b.effect(x, 'drop-shadow', { color: '#0f4d00', opacity: 0.8, angle: 120, distance: 10, size: 4 });
    b.group('Stars', () => {
      for (const [sx, sy, r] of [
        [380, 230, 40],
        [1850, 236, 30],
        [520, 560, 26],
      ] as [number, number, number][])
        b.star(sx, sy, r, 5, 0.48, solid('#ffffff'), { stroke: stroke('#ff7a00', 6), name: 'Star' });
    });
  },
});

/* ------------------------------------------------------------------ */
/* Horror                                                              */
/* ------------------------------------------------------------------ */

export const horror = defineTemplate({
  id: 'tpl-horror',
  name: 'Horror Fog',
  category: 'Thumbnail',
  description: 'Dark fog, a red-lit silhouette, dripping Creepster title and film grain.',
  width: 1920,
  height: 1080,
  swatch: ['#050303', '#2a0c0c', '#d01818', '#9aa3ad'],
  background: '#050303',
  fonts: [
    [HORROR, 400],
    [TYPEWRITER, 400],
  ],
  build(b) {
    b.gradient(
      'Darkness',
      radial(
        [
          [0, '#2a0c0c'],
          [1, '#040202'],
        ],
        { offsetX: 0.2, scale: 1.1 },
      ),
    );
    b.asset('fog', { color: '#8f9aa6', seed: 3 }, { name: 'Fog (back)', blendMode: 'screen', opacity: 0.45 });
    b.gradient(
      'Red Glow',
      radial(
        [
          [0, '#ff1a1a'],
          [0.45, '#a0000088'],
          [1, '#5a000000'],
        ],
        { offsetX: 0.26, offsetY: 0.05, scale: 0.75 },
      ),
      { blendMode: 'screen', opacity: 0.8 },
    );
    const ch = b.character({ cx: 1440, top: 250, height: 900, pose: 'idle', style: 'flat', silhouette: '#050505' });
    b.effect(ch, 'outer-glow', { color: '#ff2020', opacity: 0.8, size: 40, blendMode: 'screen' });
    b.asset('fog', { color: '#c9d0d8', seed: 9 }, { name: 'Fog (front)', blendMode: 'screen', opacity: 0.3 });

    b.group('Title', () => {
      const t = b.text("DON'T BLINK", { fontFamily: HORROR, fontSize: 200, x: 100, y: 300, fitWidth: 900, lineHeight: 1.05, fill: solid('#d01818') }, { name: 'Title' });
      b.effect(t, 'outer-glow', { color: '#ff0000', opacity: 0.55, size: 26, blendMode: 'screen' });
      b.text('A HORROR EXPERIENCE', { fontFamily: TYPEWRITER, fontSize: 48, x: 108, y: 560, letterSpacing: 10, lineHeight: 1.1, fill: solid('#cfcfcf') }, { name: 'Subtitle' });
    });

    b.asset('film-scratches', { density: 0.5, color: '#ffffff', seed: 7 }, { name: 'Scratches', blendMode: 'screen', opacity: 0.3 });
    b.asset('film-grain', { seed: 5 }, { name: 'Grain', blendMode: 'overlay', opacity: 0.5 });
    vignette(b, 0.85);
  },
});

/* ------------------------------------------------------------------ */
/* Anime action                                                        */
/* ------------------------------------------------------------------ */

export const animeAction = defineTemplate({
  id: 'tpl-anime-action',
  name: 'Anime Action',
  category: 'Thumbnail',
  description: 'Manga impact frame: radial speed lines, screentone, a red slash, cel-shaded fighter and a Bangers “IMPACT!”.',
  width: 1920,
  height: 1080,
  swatch: ['#f6f1e6', '#111111', '#e8202a', '#ffdd00'],
  background: '#f6f1e6',
  fonts: [
    [BANGERS, 400],
    [KANJI, 900, '必殺技'],
    [BEBAS, 400],
  ],
  build(b) {
    b.solid('Paper', '#f6f1e6');
    b.asset('speed-lines', { color: '#111111', seed: 4 }, { name: 'Speed Lines', blendMode: 'multiply', opacity: 0.9 });
    b.asset('manga-screentone', { seed: 2 }, { name: 'Screentone', blendMode: 'multiply', opacity: 0.25 });
    b.text('必殺技', { fontFamily: KANJI, fontWeight: 900, fontSize: 240, x: 1880, y: 40, anchor: 'end', lineHeight: 1, fill: solid('#111111') }, { name: 'Kanji', opacity: 0.12 });
    b.segment(160, 940, 1780, 170, 70, solid('#e8202a'), { taper: true, name: 'Red Slash', opacity: 0.92 });

    const ch = b.character({ cx: 1360, top: 160, height: 940, pose: 'action', style: 'shaded', shirt: '#1d1d2b', pants: '#2b2b3d', hair: '#f2f2f2' });
    b.smartFilter(ch, 'cel-shade', { levels: 3, smoothness: 0.1, outline: true, outlineThickness: 3, outlineColor: '#0d0d0d', saturation: 20 });
    b.effect(ch, 'stroke', { color: '#ffffff', size: 10, position: 'outside' });
    b.effect(ch, 'drop-shadow', { color: '#000000', opacity: 0.55, angle: 120, distance: 14, size: 16 });

    b.group('Title', () => {
      const t = b.text('IMPACT!', { fontFamily: BANGERS, fontSize: 260, x: 90, y: 250, lineHeight: 1, fill: solid('#ffdd00'), stroke: textStroke('#111111', 12), rotation: -10 }, { name: 'Impact' });
      b.effect(t, 'long-shadow', { color: '#e8202a', angle: 135, length: 28, opacity: 1 });
      b.text('EPISODE 01', { fontFamily: BEBAS, fontSize: 64, x: 120, y: 620, letterSpacing: 8, lineHeight: 1, fill: solid('#111111') }, { name: 'Episode' });
    });
    b.asset('halftone-dots', { size: 6, angle: 45, color: '#111111', seed: 8 }, { name: 'Halftone', blendMode: 'multiply', opacity: 0.18 });
  },
});

/* ------------------------------------------------------------------ */
/* Showcase                                                            */
/* ------------------------------------------------------------------ */

export const showcase = defineTemplate({
  id: 'tpl-showcase',
  name: 'Clean Showcase',
  category: 'Thumbnail',
  description: 'Minimal dark gradient with a soft spotlight, big clean title, accent line and a rim-lit character.',
  width: 1920,
  height: 1080,
  swatch: ['#07070a', '#16161f', '#8b7cf6', '#f2f2f2'],
  background: '#0b0b10',
  fonts: [
    [BEBAS, 400],
    [SERIF, 500],
  ],
  build(b) {
    b.gradient(
      'Backdrop',
      linear(
        [
          [0, '#1a1a26'],
          [1, '#060609'],
        ],
        135,
      ),
    );
    b.gradient(
      'Spotlight',
      radial(
        [
          [0, '#40406a'],
          [1, '#40406a00'],
        ],
        { offsetX: 0.3, offsetY: -0.05, scale: 0.8 },
      ),
      { blendMode: 'screen', opacity: 0.85 },
    );
    b.asset('bokeh', { color1: '#8b7cf6', color2: '#5a5aa8', color3: '#c9c2ff', seed: 3 }, { name: 'Bokeh', blendMode: 'screen', opacity: 0.3 });

    const ch = b.character({ cx: 1440, top: 180, height: 940, pose: 'arms-crossed', style: 'shaded', shirt: '#22222e', pants: '#15151c', hair: '#0f0f14' });
    b.smartFilter(ch, 'rim-light', { color: '#b9b2ff', width: 14, angle: 135, intensity: 0.85 });
    b.effect(ch, 'drop-shadow', { color: '#000000', opacity: 0.7, angle: 120, distance: 20, size: 40 });

    b.group('Title', () => {
      b.rect(126, 330, 140, 6, solid('#8b7cf6'), { name: 'Accent Line' });
      b.text('YOUR GAME', { fontFamily: BEBAS, fontSize: 230, x: 120, y: 360, letterSpacing: 6, lineHeight: 1, fill: solid('#f4f4f8') }, { name: 'Title' });
      b.text('SHOWCASE', { fontFamily: SERIF, fontWeight: 500, fontSize: 46, x: 128, y: 600, letterSpacing: 18, lineHeight: 1.1, fill: solid('#a9a9c8') }, { name: 'Subtitle' });
      b.text('AVAILABLE NOW ON ROBLOX', { fontFamily: BEBAS, fontSize: 40, x: 128, y: 690, letterSpacing: 4, lineHeight: 1, fill: solid('#7d7d99') }, { name: 'Tagline' });
    });
    vignette(b, 0.5);
  },
});

/* ------------------------------------------------------------------ */
/* Group banner                                                        */
/* ------------------------------------------------------------------ */

export const groupBanner = defineTemplate({
  id: 'tpl-group-banner',
  name: 'Group Banner',
  category: 'Banner',
  description: 'Community/group banner: emblem, gold serif group name, tagline and a lineup of members.',
  width: 1500,
  height: 500,
  swatch: ['#0d0d12', '#1e1630', '#c9a24a', '#f1e6c8'],
  background: '#0d0d12',
  fonts: [
    [SERIF, 700],
    [BEBAS, 400],
  ],
  build(b) {
    b.gradient(
      'Backdrop',
      linear(
        [
          [0, '#0d0d12'],
          [1, '#241a3a'],
        ],
        0,
      ),
    );
    b.asset('ornate-corners', { color: '#c9a24a', size: 220, thickness: 5, inset: 22 }, { name: 'Ornate Corners', opacity: 0.85 });

    b.group('Members', () => {
      const members: { cx: number; top: number; pose: 'hero' | 'arms-crossed'; shirt: string; name: string }[] = [
        { cx: 1150, top: 96, pose: 'arms-crossed', shirt: '#2a2a38', name: 'Member 2 (replace me)' },
        { cx: 1420, top: 96, pose: 'arms-crossed', shirt: '#2a3340', name: 'Member 3 (replace me)' },
        { cx: 1285, top: 56, pose: 'hero', shirt: '#332a44', name: 'Your Character (replace me)' },
      ];
      for (const m of members) {
        const c = b.character({ cx: m.cx, top: m.top, height: 520, pose: m.pose, style: 'shaded', shirt: m.shirt, pants: '#15151c', hair: '#0f0f14' }, { name: m.name });
        b.smartFilter(c, 'rim-light', { color: '#e9cf8a', width: 8, angle: 135, intensity: 0.75 });
        if (c && m.pose === 'hero') b.characterId = c.id;
      }
    });

    b.group('Emblem', () => {
      const ring = b.ellipse(190, 250, 130, 130, { type: 'gradient', gradient: radial([[0, '#2a2140'], [1, '#100c18']]) }, { name: 'Emblem', stroke: stroke('#c9a24a', 8, 'inside') });
      b.effect(ring, 'outer-glow', { color: '#c9a24a', opacity: 0.35, size: 20, blendMode: 'screen' });
      b.star(190, 250, 78, 5, 0.45, solid('#c9a24a'), { name: 'Emblem Star' });
    });

    b.group('Text', () => {
      const t = b.text('YOUR GROUP', { fontFamily: SERIF, fontWeight: 700, fontSize: 104, x: 360, y: 150, fitWidth: 620, maxFontSize: 104, letterSpacing: 8, lineHeight: 1.05, fill: solid('#f1e6c8') }, { name: 'Group Name' });
      b.effect(t, 'outer-glow', { color: '#c9a24a', opacity: 0.3, size: 16, blendMode: 'screen' });
      b.rect(364, 282, 120, 4, solid('#c9a24a'), { name: 'Divider' });
      b.text('EST. 2024  •  JOIN TODAY', { fontFamily: BEBAS, fontSize: 44, x: 364, y: 306, letterSpacing: 6, lineHeight: 1, fill: solid('#c9a24a') }, { name: 'Tagline' });
    });
    b.asset('film-grain', { seed: 3 }, { name: 'Grain', blendMode: 'overlay', opacity: 0.25 });
    vignette(b, 0.45);
  },
});

/* ------------------------------------------------------------------ */
/* YouTube story thumbnail                                             */
/* ------------------------------------------------------------------ */

export const youtubeStory = defineTemplate({
  id: 'tpl-youtube-story',
  name: 'YouTube Challenge',
  category: 'Social',
  description: 'Loud YouTube thumbnail: “I SURVIVED 100 DAYS” cartoon text, sunburst, outlined character and a red arrow.',
  width: 1280,
  height: 720,
  swatch: ['#ff914d', '#ffde59', '#ffffff', '#ff2020'],
  background: '#ff914d',
  fonts: [[CARTOON, 400]],
  build(b) {
    b.gradient(
      'Background',
      radial(
        [
          [0, '#ffe46b'],
          [1, '#ff7a3d'],
        ],
        { offsetX: -0.25 },
      ),
    );
    b.asset('sunburst-rays', { rays: 30, center: { x: 0.28, y: 0.5 }, color: '#ffffff', thickness: 0.5, fade: 0.4, seed: 7 }, { name: 'Sunburst', blendMode: 'screen', opacity: 0.4 });
    const ch = b.character({ cx: 290, top: 130, height: 640, pose: 'hero', style: 'shaded', shirt: '#2f80ed', pants: '#1b2a4a', hair: '#3a2416' });
    b.effect(ch, 'stroke', { color: '#ffffff', size: 10, position: 'outside' });
    b.effect(ch, 'drop-shadow', { color: '#5a1d00', opacity: 0.5, angle: 120, distance: 14, size: 16 });

    const t = b.text('I SURVIVED\n100 DAYS', { fontFamily: CARTOON, fontSize: 124, x: 1235, y: 120, anchor: 'end', align: 'right', lineHeight: 1.02, fill: solid('#ffffff'), stroke: textStroke('#111111', 12) }, { name: 'Title' });
    b.effect(t, 'long-shadow', { color: '#111111', angle: 135, length: 16, opacity: 1 });
    const arrow = b.path('M0 60 L620 60 L620 0 L1000 100 L620 200 L620 140 L0 140 Z', [0, 0, 1000, 200], { x: 470, y: 470, width: 330, height: 66, rotation: 160 }, solid('#ff2020'), {
      name: 'Arrow',
      stroke: stroke('#ffffff', 6),
    });
    b.effect(arrow, 'drop-shadow', { color: '#000000', opacity: 0.4, angle: 120, distance: 8, size: 8 });
    b.ellipse(300, 260, 150, 150, null, { name: 'Highlight Circle', stroke: stroke('#ff2020', 12) });
  },
});

/* ------------------------------------------------------------------ */
/* Badge emblem                                                        */
/* ------------------------------------------------------------------ */

export const badgeEmblem = defineTemplate({
  id: 'tpl-badge-emblem',
  name: 'Badge Emblem',
  category: 'Icon',
  description: 'Round Roblox badge: gold ring, starburst and bold label on a transparent canvas (badges display as circles).',
  width: 512,
  height: 512,
  swatch: ['#3b1670', '#9b6bff', '#ffd23f', '#ffffff'],
  background: null,
  fonts: [[CARTOON, 400]],
  build(b) {
    b.path(burstPath(20, 0.84, 1000, 0, 1), [0, 0, 1000, 1000], { x: 16, y: 16, width: 480, height: 480 }, solid('#ffd23f'), { name: 'Burst' });
    const disc = b.ellipse(256, 256, 200, 200, { type: 'gradient', gradient: radial([[0, '#9b6bff'], [1, '#3b1670']], { offsetY: -0.2 }) }, { name: 'Disc', stroke: stroke('#1a0b33', 12, 'inside') });
    b.effect(disc, 'inner-shadow', { color: '#000000', opacity: 0.45, angle: 120, distance: 8, size: 20 });
    b.star(256, 168, 42, 5, 0.46, solid('#ffd23f'), { name: 'Star', stroke: stroke('#1a0b33', 5) });
    b.text('MVP', { fontFamily: CARTOON, fontSize: 150, x: 256, y: 230, anchor: 'center', lineHeight: 1, fill: solid('#ffffff'), stroke: textStroke('#1a0b33', 10) }, { name: 'Label' });
    b.guide('vertical', 256);
    b.guide('horizontal', 256);
  },
});

export const EXTRA_TEMPLATES = [versus, updateBanner, simulatorBright, horror, animeAction, showcase, groupBanner, youtubeStory, badgeEmblem];

