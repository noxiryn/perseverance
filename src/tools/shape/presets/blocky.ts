/** Blocky (brick-game style) shapes: generic blocky avatar, studded brick, cube, pixel sword. */
import type { ShapePresetDef } from '../../../registry';
import { circle, poly, polys, preset, rectPts, roundRect, type Pt } from './pathKit';
import { traceGrid } from '../trace';

const C = 'Blocky';

function blockyCharacter(): string {
  // Classic 6-part blocky avatar; thin gaps keep the limbs readable at any size.
  const head = roundRect(27, 0, 26, 25, 4);
  const body = polys([rectPts(20, 28, 40, 40), rectPts(0, 28, 18.5, 40), rectPts(61.5, 28, 18.5, 40), rectPts(20, 69.5, 19.25, 40), rectPts(40.75, 69.5, 19.25, 40)]);
  return head + body;
}

function brick(): string {
  // 2x4 brick seen from the side, studs on top (single outline, no seams).
  const pts: Pt[] = [[0, 14]];
  const studs = [8, 32, 56, 80];
  for (const x of studs) {
    pts.push([x, 14], [x, 2], [x + 2, 0], [x + 10, 0], [x + 12, 2], [x + 12, 14]);
  }
  pts.push([100, 14], [100, 60], [0, 60]);
  const lines = polys([], [rectPts(6, 22, 88, 2.5)]);
  return polys([pts]) + lines;
}

function cube(): string {
  const g = 2.2;
  const top: Pt[] = [
    [50, 0],
    [100, 25],
    [50, 50],
    [0, 25],
  ];
  const left: Pt[] = [
    [0, 25 + g * 1.3],
    [50 - g * 0.6, 50 + g],
    [50 - g * 0.6, 112],
    [0, 87],
  ];
  const right: Pt[] = [
    [100, 25 + g * 1.3],
    [100, 87],
    [50 + g * 0.6, 112],
    [50 + g * 0.6, 50 + g],
  ];
  return polys([top, left, right]);
}

function stud(): string {
  return circle(50, 50, 50) + circle(50, 50, 38, true) + circle(50, 50, 31);
}

function pixelSword(): string {
  // 12×12 diagonal 8-bit sword; the union outline is traced so strokes follow the silhouette.
  const rows = [
    '..........##',
    '.........###',
    '........###.',
    '.......###..',
    '......###...',
    '.#...###....',
    '.##.###.....',
    '..#####.....',
    '...###......',
    '..##.##.....',
    '.##...#.....',
    '##..........',
  ];
  const u = 8;
  const loops = traceGrid(12, 12, (x, y) => rows[y][x] === '#');
  return loops.map((l) => poly(l.map(([x, y]) => [x * u, y * u] as Pt))).join('');
}

export const blockyPresets: ShapePresetDef[] = [
  preset('blocky-character', 'Blocky Avatar', C, blockyCharacter()),
  preset('brick-studs', 'Brick with Studs', C, brick(), { evenOdd: true }),
  preset('cube', 'Cube', C, cube()),
  preset('stud', 'Stud', C, stud(), { evenOdd: true }),
  preset('pixel-sword', 'Pixel Sword', C, pixelSword()),
];
