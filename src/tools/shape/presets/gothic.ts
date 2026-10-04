/** Gothic & ornamental shapes: tendrils, swirls, flourishes, arches, crosses, moons. */
import type { ShapePresetDef } from '../../../registry';
import {
  angularSpiralPts,
  cubicPts,
  fmt,
  joinRuns,
  mirrorPts,
  mirrorX,
  poly,
  polys,
  preset,
  rotatePts,
  spiralPts,
  symPath,
  taperedStroke,
  type Pt,
} from './pathKit';

const C = 'Gothic & Ornaments';

/** Smooth spiral tendril: a curved stem flowing into a clockwise spiral, tapering to a point. */
function spiralSwirl(): string {
  const stem = cubicPts([6, 104], [10, 84], [22, 66], [24, 42], 30);
  const spiral = spiralPts(58, 42, 34, 180, 2.1, 0.32, 1, 160);
  const line = joinRuns(stem, spiral);
  return poly(taperedStroke(line, (t) => 0.8 + 13 * Math.pow(1 - t, 0.75)));
}

/** Angular "birdcage" tendril: thick stem that turns into a sharp-cornered spiral. */
function angularTendril(): string {
  // Stem bends left then climbs into a squarish spiral (sharp corners), tapering to a hook.
  const stem = cubicPts([40, 200], [52, 160], [6, 140], [12, 96], 28);
  const spiral = angularSpiralPts([12, 96], -48, 58, 9, 74, 0.78, 1);
  const line = joinRuns(stem, spiral);
  return poly(taperedStroke(line, (t) => 1.4 + 18 * Math.pow(1 - t, 0.8), { miterLimit: 2.4 }));
}

/** Point-symmetric S scroll with curls at both ends. */
function scrollFlourish(): string {
  const half = joinRuns(cubicPts([0, 0], [12, -8], [30, -10], [46, -8], 24), spiralPts(46, 4, 12, -90, 1.7, 0.28, 1, 80));
  const other = rotatePts(half, 180, 0, 0);
  const line = joinRuns([...other].reverse(), half);
  return poly(taperedStroke(line, (t) => 0.8 + 8 * Math.pow(Math.sin(Math.PI * t), 1.3)));
}

function fleurDeLis(): string {
  return symPath(
    [50, 0],
    [
      ['C', 58, 11, 65, 24, 64, 36],
      ['C', 63, 46, 59, 53, 57, 60],
      ['C', 61, 46, 71, 33, 84, 31],
      ['C', 96, 29, 102, 40, 99, 50],
      ['C', 97, 58, 89, 62, 84, 57],
      ['C', 88, 52, 86, 46, 80, 47],
      ['C', 74, 48, 72, 56, 76, 62],
      ['L', 77, 62],
      ['L', 77, 71],
      ['L', 58, 71],
      ['C', 64, 75, 72, 81, 73, 94],
      ['C', 66, 90, 60, 86, 56, 84],
      ['C', 55, 94, 53, 104, 50, 114],
    ],
    50,
  );
}

function gothicArch(): string {
  const outer = 'M0 150L0 86.6A100 100 0 0 1 50 0A100 100 0 0 1 100 86.6L100 150Z';
  const inner = 'M12 138L88 138L88 86.6A88 88 0 0 0 50 14.18A88 88 0 0 0 12 86.6Z';
  return outer + inner;
}

function ornateCorner(): string {
  const arm = joinRuns(cubicPts([4, 4], [30, 0], [58, 2], [80, 8], 30), spiralPts(80, 18, 10, -90, 1.35, 0.32, 1, 60));
  const top = taperedStroke(arm, (t) => 0.8 + 8 * Math.pow(1 - t, 0.6));
  const left = top.map((p) => [p[1], p[0]] as Pt);
  // Small inner curls mirrored about the diagonal.
  const curl = joinRuns(cubicPts([14, 14], [30, 16], [44, 22], [48, 34], 20), spiralPts(42, 36, 6, -18, 1.1, 0.35, 1, 40));
  const curlA = taperedStroke(curl, (t) => 0.8 + 4.5 * Math.pow(1 - t, 0.7));
  const curlB = curlA.map((p) => [p[1], p[0]] as Pt);
  const knot: Pt[] = [
    [0, 0],
    [16, 3],
    [20, 20],
    [3, 16],
  ];
  return polys([top, left, knot, curlA, curlB]);
}

function dividerFlourish(): string {
  const tan = Math.atan2(-10, 20) * (180 / Math.PI);
  const start = tan - 90;
  const r0 = 10;
  const end: Pt = [170, 22];
  const center: Pt = [end[0] - r0 * Math.cos((start * Math.PI) / 180), end[1] - r0 * Math.sin((start * Math.PI) / 180)];
  const line = joinRuns(cubicPts([106, 20], [130, 6], [150, 32], end, 30), spiralPts(center[0], center[1], r0, start, 1.4, 0.32, 1, 60));
  const right = taperedStroke(line, (t) => 0.8 + 6 * Math.pow(1 - t, 0.7));
  const left = mirrorX(right, 100);
  const diamond: Pt[] = [
    [100, 8],
    [110, 20],
    [100, 32],
    [90, 20],
  ];
  return polys([right, left, diamond]);
}

function thornVine(): string {
  const N = 80;
  const line: Pt[] = [];
  const yAt = (x: number) => 20 + 7 * Math.sin((x / 200) * Math.PI * 3);
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * 200;
    line.push([x, yAt(x)]);
  }
  const vine = taperedStroke(line, (t) => 1.5 + 4.5 * Math.min(1, Math.sin(Math.PI * t) * 2.5));
  const thorns: Pt[][] = [];
  for (let k = 0; k < 7; k++) {
    const x = 18 + k * 27;
    const y = yAt(x);
    const dy = (yAt(x + 0.5) - yAt(x - 0.5)) / 1;
    const len = Math.hypot(1, dy);
    const tx = 1 / len;
    const ty = dy / len;
    const side = k % 2 === 0 ? -1 : 1;
    const nx = -ty * side;
    const ny = tx * side;
    thorns.push([
      [x - tx * 6, y - ty * 6],
      [x + tx * 6, y + ty * 6],
      [x + nx * 16 + tx * 7, y + ny * 16 + ty * 7],
    ]);
  }
  return polys([vine, ...thorns]);
}

function crescent(): string {
  const [x1, y1, r1] = [50, 50, 50];
  const [x2, y2, r2] = [72, 36, 43];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(r1 * r1 - a * a);
  const bx = x1 + (a * dx) / d;
  const by = y1 + (a * dy) / d;
  const p: Pt = [bx - (h * dy) / d, by + (h * dx) / d];
  const q: Pt = [bx + (h * dy) / d, by - (h * dx) / d];
  // Outer: long way around circle 1 (away from circle 2). Inner: the arc of circle 2 inside circle 1.
  const angle = (pt: Pt, cx: number, cy: number) => Math.atan2(pt[1] - cy, pt[0] - cx);
  const a2p = angle(p, x2, y2);
  const a2q = angle(q, x2, y2);
  // From q to p clockwise around circle 2 (passing its far-left side).
  let span = a2p - a2q;
  while (span < 0) span += Math.PI * 2;
  const large2 = span > Math.PI ? 1 : 0;
  return `M${fmt(p[0])} ${fmt(p[1])}A${r1} ${r1} 0 1 1 ${fmt(q[0])} ${fmt(q[1])}A${r2} ${r2} 0 ${large2} 0 ${fmt(p[0])} ${fmt(p[1])}Z`;
}

function gothicCross(): string {
  const half: Pt[] = [
    [50, 0],
    [62, 14],
    [57, 19],
    [57, 38],
    [81, 38],
    [86, 33],
    [100, 45],
    [86, 57],
    [81, 52],
    [57, 52],
    [57, 118],
    [64, 126],
    [50, 142],
  ];
  return poly(mirrorPts(half, 50));
}

function bat(): string {
  return symPath(
    [100, 34],
    [
      ['L', 104, 22],
      ['L', 109, 34],
      ['C', 124, 36, 152, 20, 198, 12],
      ['Q', 186, 30, 190, 54],
      ['Q', 174, 40, 158, 52],
      ['Q', 144, 44, 132, 64],
      ['Q', 122, 52, 111, 60],
      ['C', 111, 68, 106, 74, 100, 80],
    ],
    100,
  );
}

function coffin(): string {
  const outline: Pt[] = [
    [30, 0],
    [70, 0],
    [100, 32],
    [78, 150],
    [22, 150],
    [0, 32],
  ];
  const cross: Pt[] = [
    [46, 30],
    [54, 30],
    [54, 46],
    [66, 46],
    [66, 54],
    [54, 54],
    [54, 84],
    [46, 84],
    [46, 54],
    [34, 54],
    [34, 46],
    [46, 46],
  ];
  return polys([outline], [cross]);
}

export const gothicPresets: ShapePresetDef[] = [
  preset('spiral-swirl', 'Spiral Swirl', C, spiralSwirl()),
  preset('gothic-tendril', 'Gothic Tendril', C, angularTendril()),
  preset('scroll-flourish', 'Scroll Flourish', C, scrollFlourish()),
  preset('fleur-de-lis', 'Fleur-de-lis', C, fleurDeLis()),
  preset('gothic-arch', 'Gothic Arch', C, gothicArch(), { evenOdd: true }),
  preset('ornate-corner', 'Ornate Corner', C, ornateCorner()),
  preset('divider-flourish', 'Divider Flourish', C, dividerFlourish()),
  preset('thorn-vine', 'Thorn Vine', C, thornVine()),
  preset('crescent-moon', 'Crescent Moon', C, crescent()),
  preset('gothic-cross', 'Gothic Cross', C, gothicCross()),
  preset('quatrefoil', 'Quatrefoil', C, 'M25 25A27 27 0 1 1 75 25A27 27 0 1 1 75 75A27 27 0 1 1 25 75A27 27 0 1 1 25 25Z'),
  preset('bat', 'Bat', C, bat()),
  preset('coffin', 'Coffin', C, coffin(), { evenOdd: true }),
];
