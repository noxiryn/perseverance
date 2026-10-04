/** UI & badge shapes for game thumbnails/icons: banners, badges, tags, buttons, trophies, coins. */
import type { ShapePresetDef } from '../../../registry';
import { circle, insetConvex, mirrorX, poly, polys, preset, regularPts, scalePts, starPts, symPath, translatePts, type Pt } from './pathKit';

const C = 'UI & Badges';

function ribbon(): string {
  // Curved banner with notched ends.
  return 'M0 14Q60 -6 120 14L111 30L120 46Q60 26 0 46L9 30Z';
}

function ribbonFolded(): string {
  const band: Pt[] = [
    [19, 0],
    [101, 0],
    [101, 30],
    [19, 30],
  ];
  const tailL: Pt[] = [
    [0, 10],
    [16.5, 10],
    [16.5, 40],
    [0, 40],
    [8, 25],
  ];
  return polys([band, tailL, mirrorX(tailL, 60)]);
}

function badgeShield(): string {
  const outer = 'M0 6Q50 -4 100 6L100 46C100 82 76 104 50 118C24 104 0 82 0 46Z';
  const inner = 'M9 13Q50 4 91 13L91 46C91 76 71 94 50 107C29 94 9 76 9 46Z';
  // Inner is drawn in the same direction; evenodd turns it into a border, the star fills again.
  return outer + inner + poly(starPts(5, 50, 54, 24, 9.5));
}

function trophy(): string {
  const cup = symPath(
    [50, 0],
    [
      ['L', 80, 0],
      ['L', 80, 8],
      ['L', 92, 8],
      ['C', 99, 8, 100, 12, 100, 18],
      ['C', 100, 34, 90, 44, 76, 47],
      ['C', 72, 55, 64, 61, 56, 63],
      ['L', 56, 76],
      ['C', 56, 79, 61, 81, 66, 82],
      ['L', 66, 88],
      ['L', 76, 88],
      ['L', 76, 100],
      ['L', 50, 100],
    ],
    50,
  );
  const holeR = 'M80 16L78 38C87 33 92 26 92 16Z';
  const holeL = 'M20 16L8 16C8 26 13 33 22 38Z';
  const star = polys([], [starPts(5, 50, 26, 11, 4.4)]);
  return cup + holeR + holeL + star;
}

function pixelHeart(): string {
  const u = 10;
  const pts: Pt[] = (
    [
      [1, 0],
      [3, 0],
      [3, 1],
      [4, 1],
      [4, 0],
      [6, 0],
      [6, 1],
      [7, 1],
      [7, 3],
      [6, 3],
      [6, 4],
      [5, 4],
      [5, 5],
      [4, 5],
      [4, 6],
      [3, 6],
      [3, 5],
      [2, 5],
      [2, 4],
      [1, 4],
      [1, 3],
      [0, 3],
      [0, 1],
      [1, 1],
    ] as Pt[]
  ).map(([x, y]) => [x * u, y * u] as Pt);
  const shine: Pt[] = [
    [1 * u, 1 * u],
    [2 * u, 1 * u],
    [2 * u, 2 * u],
    [1 * u, 2 * u],
  ];
  return polys([pts], [shine]);
}

function energyBolt(): string {
  const bolt: Pt[] = [
    [58, 0],
    [12, 64],
    [42, 64],
    [28, 120],
    [88, 46],
    [56, 46],
    [78, 0],
  ];
  const fitted = translatePts(scalePts(bolt, 0.56), 50 - 50 * 0.56, 50 - 60 * 0.56);
  return circle(50, 50, 50) + polys([], [fitted]);
}

function hexBadge(): string {
  const hex = regularPts(6, 50, 50, 50, -90);
  const chevron: Pt[] = [
    [50, 26],
    [76, 52],
    [64, 64],
    [50, 50],
    [36, 64],
    [24, 52],
  ];
  const chevron2 = translatePts(chevron, 0, 22);
  return polys([hex], [insetConvex(hex, 6)]) + polys([chevron, chevron2]);
}

export const uiPresets: ShapePresetDef[] = [
  preset('ribbon-banner', 'Ribbon Banner', C, ribbon()),
  preset('ribbon-folded', 'Folded Ribbon', C, ribbonFolded()),
  preset('badge-shield', 'Shield Badge', C, badgeShield(), { evenOdd: true }),
  preset('hex-badge', 'Rank Badge', C, hexBadge(), { evenOdd: true }),
  preset('tag', 'Tag', C, polys([[[0, 25], [24, 0], [100, 0], [100, 50], [24, 50]]]) + circle(16, 25, 5, true), { evenOdd: true }),
  preset('starburst-badge', 'Starburst Badge', C, [poly(starPts(24, 50, 50, 50, 43)), circle(50, 50, 37, true), circle(50, 50, 33)], {
    evenOdd: true,
  }),
  preset('play-button', 'Play Button', C, circle(50, 50, 50) + polys([], [[[39, 28], [74, 50], [39, 72]]]), { evenOdd: true }),
  preset('trophy', 'Trophy', C, trophy(), { evenOdd: true }),
  preset('coin', 'Coin', C, [circle(50, 50, 50), circle(50, 50, 43, true), circle(50, 50, 40), polys([], [starPts(5, 50, 52, 22, 9)])], {
    evenOdd: true,
  }),
  preset('heart-health', 'Pixel Heart', C, pixelHeart(), { evenOdd: true }),
  preset('energy-bolt', 'Energy Badge', C, energyBolt(), { evenOdd: true }),
  preset(
    'location-pin',
    'Location Pin',
    C,
    'M50 0C78 0 96 20 96 44C96 72 64 96 50 120C36 96 4 72 4 44C4 20 22 0 50 0Z' + circle(50, 44, 16, true),
    { evenOdd: true },
  ),
];
