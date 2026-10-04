/** Nature shapes: leaf, cloud, sun, snowflake, wave, tree, mountain, paw print, flower. */
import type { ShapePresetDef } from '../../../registry';
import { circle, cubicPts, ellipse, mirrorPts, polar, poly, polys, preset, rectPts, rotatePts, taperedStroke, type Pt } from './pathKit';

const C = 'Nature';

function leaf(): string {
  const blade = 'M4 96C10 40 48 4 100 0C98 52 62 90 4 96Z';
  const rib = taperedStroke(cubicPts([14, 86], [36, 62], [60, 34], [88, 10], 24), (t) => 3.2 * (1 - t) + 0.4);
  const stem = taperedStroke(
    [
      [0, 100],
      [8, 92],
    ],
    () => 3,
  );
  return blade + polys([stem], [rib]);
}

function cloud(): string {
  return 'M22 72A20 20 0 0 1 20 32.2A26 26 0 0 1 68 22A20 20 0 0 1 96 40A16 16 0 0 1 84 72Z';
}

function sun(): string {
  const rays: Pt[][] = [];
  for (let i = 0; i < 12; i++) {
    const a = i * 30;
    rays.push([polar(50, 50, 31, a - 7), polar(50, 50, 50, a), polar(50, 50, 31, a + 7)]);
  }
  return circle(50, 50, 25) + polys(rays);
}

function snowflake(): string {
  const arm: Pt[][] = [
    rectPts(47.6, 4, 4.8, 46),
    // two V branches on each arm
    ...[
      [16, 9],
      [30, 7],
    ].flatMap(([y, len]) => {
      const l = taperedStroke(
        [
          [50, y + len * 0.8],
          [50 - len * 0.7, y],
        ],
        () => 4,
      );
      const r = taperedStroke(
        [
          [50, y + len * 0.8],
          [50 + len * 0.7, y],
        ],
        () => 4,
      );
      return [l, r];
    }),
  ];
  const all: Pt[][] = [];
  for (let k = 0; k < 6; k++) for (const p of arm) all.push(rotatePts(p, k * 60, 50, 50));
  return polys(all) + circle(50, 50, 6);
}

function wave(): string {
  return 'M0 100L0 82C18 82 30 70 36 50C44 22 66 4 90 6C98 7 104 12 106 18C96 12 82 14 74 24C66 34 68 48 80 52C88 55 96 52 100 46C100 62 88 74 72 76C88 84 104 84 120 78L120 100Z';
}

function tree(): string {
  const half: Pt[] = [
    [50, 0],
    [74, 30],
    [63, 30],
    [86, 58],
    [72, 58],
    [98, 92],
    [57, 92],
    [57, 112],
    [50, 112],
  ];
  return poly(mirrorPts(half, 50));
}

function mountain(): string {
  const body: Pt[] = [
    [0, 80],
    [36, 12],
    [50, 34],
    [64, 18],
    [100, 80],
  ];
  const snow: Pt[] = [
    [27.5, 28],
    [36, 12],
    [46, 27.5],
    [41, 25],
    [36, 31],
    [32, 25],
  ];
  return polys([body], [snow]);
}

function paw(): string {
  const pad = 'M50 48C64 48 80 66 80 80C80 92 70 96 62 94C56 92 54 90 50 90C46 90 44 92 38 94C30 96 20 92 20 80C20 66 36 48 50 48Z';
  return pad + ellipse(14, 46, 9.5, 12.5, false, -24) + ellipse(36, 22, 10, 13.5, false, -8) + ellipse(64, 22, 10, 13.5, false, 8) + ellipse(86, 46, 9.5, 12.5, false, 24);
}

function flower(): string {
  let d = '';
  for (let i = 0; i < 6; i++) {
    const a = -90 + i * 60;
    const [cx, cy] = polar(50, 50, 33, a);
    d += ellipse(cx, cy, 17, 11, false, a);
  }
  return d + circle(50, 50, 12);
}

export const naturePresets: ShapePresetDef[] = [
  preset('leaf', 'Leaf', C, leaf()),
  preset('cloud', 'Cloud', C, cloud()),
  preset('sun', 'Sun', C, sun()),
  preset('snowflake', 'Snowflake', C, snowflake()),
  preset('wave', 'Wave', C, wave()),
  preset('tree', 'Pine Tree', C, tree()),
  preset('mountain', 'Mountain', C, mountain()),
  preset('paw', 'Paw Print', C, paw()),
  preset('flower', 'Flower', C, flower()),
];
