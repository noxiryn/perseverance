/** Basic shapes: stars, bursts, hearts, polygons, frames. All original geometry. */
import type { ShapePresetDef } from '../../../registry';
import { circle, insetConvex, poly, polys, preset, regularPts, rotatePts, scallopPath, starPts, symPath, type Pt } from './pathKit';

const C = 'Basic';

function plusPts(cx: number, cy: number, half: number, arm: number): Pt[] {
  return [
    [cx - arm, cy - half],
    [cx + arm, cy - half],
    [cx + arm, cy - arm],
    [cx + half, cy - arm],
    [cx + half, cy + arm],
    [cx + arm, cy + arm],
    [cx + arm, cy + half],
    [cx - arm, cy + half],
    [cx - arm, cy + arm],
    [cx - half, cy + arm],
    [cx - half, cy - arm],
    [cx - arm, cy - arm],
  ];
}

export const basicPresets: ShapePresetDef[] = [
  preset('star-5', '5-Point Star', C, poly(starPts(5, 50, 50, 50, 19.1))),
  preset('star-6', '6-Point Star', C, poly(starPts(6, 50, 50, 50, 28.87))),
  preset('star-8', '8-Point Star', C, poly(starPts(8, 50, 50, 50, 30))),
  preset('star-4-sparkle', 'Sparkle', C, 'M50 0Q55 45 100 50Q55 55 50 100Q45 55 0 50Q45 45 50 0Z'),
  preset('star-rounded', 'Soft Star', C, (() => {
    // 5-point star with rounded tips: quadratic corners at the outer points.
    const pts = starPts(5, 50, 50, 50, 22);
    let d = '';
    for (let i = 0; i < pts.length; i += 2) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const tip = pts[i];
      const next = pts[i + 1];
      const a: Pt = [tip[0] + (prev[0] - tip[0]) * 0.28, tip[1] + (prev[1] - tip[1]) * 0.28];
      const b: Pt = [tip[0] + (next[0] - tip[0]) * 0.28, tip[1] + (next[1] - tip[1]) * 0.28];
      d += `${i === 0 ? 'M' : 'L'}${a[0].toFixed(2)} ${a[1].toFixed(2)}Q${tip[0].toFixed(2)} ${tip[1].toFixed(2)} ${b[0].toFixed(2)} ${b[1].toFixed(2)}L${next[0].toFixed(2)} ${next[1].toFixed(2)}`;
    }
    return `${d}Z`;
  })()),
  preset('burst-12', '12-Point Burst', C, poly(starPts(12, 50, 50, 50, 38))),
  preset('burst-16', '16-Point Burst', C, poly(starPts(16, 50, 50, 50, 40))),
  preset('burst-24', '24-Point Burst', C, poly(starPts(24, 50, 50, 50, 42))),
  preset(
    'heart',
    'Heart',
    C,
    symPath(
      [50, 18],
      [
        ['C', 54, 9, 62, 3, 73, 3],
        ['C', 88, 3, 99, 14, 99, 30],
        ['C', 99, 52, 80, 70, 50, 92],
      ],
      50,
    ),
  ),
  preset('diamond', 'Diamond', C, poly([[35, 0], [70, 50], [35, 100], [0, 50]])),
  preset('triangle', 'Triangle', C, poly([[50, 0], [100, 86.6], [0, 86.6]])),
  preset('hexagon', 'Hexagon', C, poly(regularPts(6, 50, 50, 50, -90))),
  preset('octagon', 'Octagon', C, poly(regularPts(8, 50, 50, 50, -67.5))),
  preset('cross-x', 'Cross (X)', C, poly(rotatePts(plusPts(50, 50, 52, 12), 45, 50, 50))),
  preset('plus', 'Plus', C, poly(plusPts(50, 50, 50, 16))),
  preset('check', 'Check Mark', C, poly([[0, 54], [15, 39], [36, 60], [85, 11], [100, 26], [36, 89]])),
  preset('ring', 'Ring', C, [circle(50, 50, 50), circle(50, 50, 34, true)], { evenOdd: true }),
  preset(
    'circle-frame',
    'Circle Frame',
    C,
    [scallopPath(50, 50, 46, 46, 28, 1.25), circle(50, 50, 40, true), circle(50, 50, 37), circle(50, 50, 35, true)],
    { evenOdd: true },
  ),
  preset(
    'square-frame',
    'Square Frame',
    C,
    polys([[[0, 0], [100, 0], [100, 100], [0, 100]]], [insetConvex([[0, 0], [100, 0], [100, 100], [0, 100]], 12)]),
    { evenOdd: true },
  ),
];
