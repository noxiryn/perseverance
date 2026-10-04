/** Fantasy & combat shapes: weapons, shields, crowns, skulls, flames, wings, gems, potions. */
import type { ShapePresetDef } from '../../../registry';
import {
  circle,
  cubicPts,
  ellipse,
  insetConvex,
  mirrorPts,
  mirrorX,
  poly,
  polys,
  preset,
  rectPts,
  roundRect,
  rotatePts,
  symPath,
  taperedStroke,
  translatePts,
  type Pt,
} from './pathKit';

const C = 'Fantasy & Combat';

const SWORD_HALF: Pt[] = [
  [20, 0],
  [25, 12],
  [25, 108],
  [38, 104],
  [42, 108],
  [39, 114],
  [24, 114],
  [24, 145],
  [27, 147],
  [28.5, 152],
  [25, 157.5],
  [20, 159],
];

function sword(): string {
  return polys([mirrorPts(SWORD_HALF, 20)], [rectPts(19, 22, 2, 78)]);
}

function crossedSwords(): string {
  const s = mirrorPts(SWORD_HALF, 20);
  const a = rotatePts(s, 38, 20, 80);
  const b = rotatePts(s, -38, 20, 80);
  return polys([a, b]);
}

function katana(): string {
  const blade = 'M52 0C47 30 43 70 43 118L50.5 118C50.5 72 53 32 56.5 4Z';
  const habaki = poly(rectPts(42, 117, 9.5, 7));
  const tsuba = ellipse(46.5, 126.5, 10.5, 3.4);
  const handle = roundRect(42.5, 129, 8, 46, 2.5);
  const wraps: Pt[][] = [];
  for (let y = 135; y <= 167; y += 8) {
    wraps.push([
      [46.5, y - 2.6],
      [48.2, y],
      [46.5, y + 2.6],
      [44.8, y],
    ]);
  }
  return blade + habaki + tsuba + handle + polys([], wraps);
}

function shield(): string {
  return 'M0 6Q50 -4 100 6L100 46C100 82 76 104 50 118C24 104 0 82 0 46Z';
}

function axe(): string {
  return symPath(
    [50, 0],
    [
      ['L', 53.5, 8],
      ['L', 53.5, 24],
      ['C', 62, 22, 74, 12, 84, 2],
      ['C', 98, 20, 100, 52, 86, 70],
      ['C', 76, 60, 64, 52, 53.5, 50],
      ['L', 53.5, 158],
      ['C', 53.5, 162, 52, 164, 50, 164],
    ],
    50,
  );
}

function dagger(): string {
  const half: Pt[] = [
    [20, 0],
    [25.5, 16],
    [25, 62],
    [34, 59],
    [37, 63],
    [34, 67],
    [24, 67],
    [24, 88],
    [26.5, 91],
    [25, 96],
    [20, 98],
  ];
  return polys([mirrorPts(half, 20)], [rectPts(19.2, 18, 1.6, 40)]);
}

function crown(): string {
  const body: Pt[] = [
    [0, 26],
    [24, 58],
    [50, 12],
    [76, 58],
    [100, 26],
    [92, 90],
    [8, 90],
  ];
  const jewels: Pt[][] = [30, 50, 70].map((x) => [
    [x, 97],
    [x + 4, 102],
    [x, 107],
    [x - 4, 102],
  ]);
  return polys([body], []) + circle(0, 22, 6) + circle(50, 8, 6.5) + circle(100, 22, 6) + roundRect(6, 95, 88, 14, 3) + polys([], jewels);
}

function skull(): string {
  const outline = symPath(
    [50, 0],
    [
      ['C', 78, 0, 98, 18, 98, 46],
      ['C', 98, 62, 90, 72, 82, 76],
      ['L', 81, 90],
      ['C', 81, 97, 76, 101.5, 70, 101.5],
      ['L', 50, 101.5],
    ],
    50,
  );
  const eyes = ellipse(31, 49, 13, 11.5, true, 12) + ellipse(69, 49, 13, 11.5, true, -12);
  const nose = polys(
    [],
    [
      [
        [50, 60],
        [56.5, 75],
        [50, 72.5],
        [43.5, 75],
      ],
    ],
  );
  // Tooth gaps stay inside the jaw (the outline bottom is at y = 101.5).
  const teeth = polys([], [rectPts(38.7, 85, 2.6, 12), rectPts(48.7, 85, 2.6, 12), rectPts(58.7, 85, 2.6, 12)]);
  return outline + eyes + nose + teeth;
}

function flame(): string {
  const outer =
    'M50 0C54 18 66 30 70 44C74 36 80 30 84 26C96 46 98 66 92 84C86 104 68 116 50 116C30 116 10 104 6 84C2 66 8 52 18 40C20 50 26 56 32 58C30 40 38 20 50 0Z';
  const inner = 'M50 56C44 72 34 80 34 92C34 102 42 108 50 108C58 108 66 102 66 92C66 78 56 70 50 56Z';
  return outer + inner;
}

function wings(): string {
  const top = cubicPts([8, 34], [30, 4], [80, -8], [132, 4], 24);
  const tipsCurve = cubicPts([132, 4], [122, 52], [70, 92], [14, 74], 6);
  const pts: Pt[] = [...top];
  const cx = 44;
  const cy = 28;
  for (let i = 1; i < tipsCurve.length; i++) {
    const a = tipsCurve[i - 1];
    const b = tipsCurve[i];
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    pts.push([mid[0] + (cx - mid[0]) * 0.28, mid[1] + (cy - mid[1]) * 0.28]);
    pts.push(b);
  }
  pts.push([8, 58]);
  const right = translatePts(pts, 140, 0);
  const left = mirrorX(right, 140);
  return polys([right, left]);
}

function clawSlash(): string {
  const strokes: Pt[][] = [];
  for (let i = 0; i < 3; i++) {
    const o = i * 20;
    const shift = i === 1 ? -6 : 0;
    const line = cubicPts([44 + o, 0 + shift], [38 + o, 30], [22 + o, 66], [6 + o, 104 - shift], 40);
    strokes.push(taperedStroke(line, (t) => 0.6 + 9 * Math.pow(Math.sin(Math.PI * t), 0.8)));
  }
  return polys(strokes);
}

function bloodDrop(): string {
  const drop = symPath(
    [50, 0],
    [
      ['C', 50, 0, 88, 48, 88, 74],
      ['C', 88, 96, 71, 112, 50, 112],
    ],
    50,
  );
  return drop + ellipse(66, 80, 4.5, 9, true, -24);
}

function gem(): string {
  const facets: Pt[][] = [
    [[22, 0], [36, 32], [0, 32]],
    [[22, 0], [50, 0], [36, 32]],
    [[50, 0], [64, 32], [36, 32]],
    [[50, 0], [78, 0], [64, 32]],
    [[78, 0], [100, 32], [64, 32]],
    [[0, 32], [36, 32], [50, 100]],
    [[36, 32], [64, 32], [50, 100]],
    [[64, 32], [100, 32], [50, 100]],
  ];
  // Outline ring + inset facets: reads as a cut gem in a single color.
  const outline: Pt[] = [
    [22, 0],
    [78, 0],
    [100, 32],
    [50, 100],
    [0, 32],
  ];
  const outer = poly(outline);
  const innerHole = polys([], [insetConvex(outline, 3.2)]);
  return outer + innerHole + polys(facets.map((f) => insetConvex(f, 2.2)));
}

function potion(): string {
  const flask =
    'M41 0L59 0L59 9L55.5 9L55.5 30C78 36 92 54 92 74C92 98 72 116 50 116C28 116 8 98 8 74C8 54 22 36 44.5 30L44.5 9L41 9Z';
  const bubbles = circle(38, 82, 6, true) + circle(58, 94, 4, true) + circle(62, 72, 3, true);
  const surface = polys([], [[[17, 62], [83, 62], [85, 66], [15, 66]]]);
  return flask + bubbles + surface;
}

function warHammer(): string {
  return polys([
    [
      [8, 6],
      [44, 0],
      [56, 0],
      [92, 6],
      [92, 38],
      [56, 44],
      [44, 44],
      [8, 38],
    ],
    rectPts(44.5, 44, 11, 104),
    [
      [42, 148],
      [58, 148],
      [56, 158],
      [44, 158],
    ],
  ]);
}

export const fantasyPresets: ShapePresetDef[] = [
  preset('sword', 'Sword', C, sword()),
  preset('crossed-swords', 'Crossed Swords', C, crossedSwords()),
  preset('katana', 'Katana', C, katana()),
  preset('dagger', 'Dagger', C, dagger()),
  preset('axe', 'Battle Axe', C, axe()),
  preset('war-hammer', 'War Hammer', C, warHammer()),
  preset('shield', 'Shield', C, shield()),
  preset('crown', 'Crown', C, crown()),
  preset('skull', 'Skull', C, skull(), { evenOdd: true }),
  preset('flame', 'Flame', C, flame(), { evenOdd: true }),
  preset('lightning-bolt', 'Lightning Bolt', C, poly([[58, 0], [12, 64], [42, 64], [28, 120], [88, 46], [56, 46], [78, 0]])),
  preset('wings', 'Wings', C, wings()),
  preset('claw-slash', 'Claw Slash', C, clawSlash()),
  preset('blood-drop', 'Blood Drop', C, bloodDrop(), { evenOdd: true }),
  preset('gem', 'Gem', C, gem(), { evenOdd: true }),
  preset('potion', 'Potion', C, potion(), { evenOdd: true }),
];
