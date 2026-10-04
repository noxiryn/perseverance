/** Arrow shapes. */
import type { ShapePresetDef } from '../../../registry';
import { cubicPts, fmt, joinRuns, polar, poly, polys, preset, taperedStroke, type Pt } from './pathKit';

const C = 'Arrows';

/** Ring-segment arrow: band between radii r1<r2 from a0 to a1 (clockwise degrees) with a head at a1. */
function circularArrow(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number, headDeg: number, headOver: number): string {
  const P = (p: Pt) => `${fmt(p[0])} ${fmt(p[1])}`;
  const large = a1 - a0 > 180 ? 1 : 0;
  const mid = (rIn + rOut) / 2;
  const o0 = polar(cx, cy, rOut, a0);
  const o1 = polar(cx, cy, rOut, a1);
  const i1 = polar(cx, cy, rIn, a1);
  const i0 = polar(cx, cy, rIn, a0);
  const h1 = polar(cx, cy, rOut + headOver, a1);
  const tip = polar(cx, cy, mid, a1 + headDeg);
  const h2 = polar(cx, cy, rIn - headOver, a1);
  return (
    `M${P(o0)}A${fmt(rOut)} ${fmt(rOut)} 0 ${large} 1 ${P(o1)}L${P(h1)}L${P(tip)}L${P(h2)}L${P(i1)}` +
    `A${fmt(rIn)} ${fmt(rIn)} 0 ${large} 0 ${P(i0)}Z`
  );
}

export const arrowPresets: ShapePresetDef[] = [
  preset('arrow-straight', 'Arrow', C, poly([[0, 34], [58, 34], [58, 8], [100, 50], [58, 92], [58, 66], [0, 66]])),
  preset('arrow-block-up', 'Block Arrow Up', C, poly([[50, 0], [100, 50], [72, 50], [72, 100], [28, 100], [28, 50], [0, 50]])),
  preset('arrow-double', 'Double Arrow', C, poly([[0, 50], [30, 14], [30, 36], [70, 36], [70, 14], [100, 50], [70, 86], [70, 64], [30, 64], [30, 86]])),
  preset('chevron', 'Chevron', C, poly([[0, 0], [42, 0], [92, 50], [42, 100], [0, 100], [50, 50]])),
  preset(
    'chevron-double',
    'Double Chevron',
    C,
    [poly([[0, 0], [30, 0], [70, 50], [30, 100], [0, 100], [40, 50]]), poly([[48, 0], [78, 0], [118, 50], [78, 100], [48, 100], [88, 50]])],
  ),
  preset('arrow-curved', 'Curved Arrow', C, 'M0 100C0 52 28 24 68 22L68 0L100 36L68 72L68 50C42 52 26 70 26 100Z'),
  preset('arrow-turn', 'Turn Arrow', C, 'M0 100L0 48C0 30 14 18 32 18L62 18L62 0L100 32L62 64L62 46L36 46C31 46 28 49 28 54L28 100Z'),
  preset('arrow-circular', 'Circular Arrow', C, circularArrow(50, 50, 31, 47, -40, 235, 30, 10)),
  preset(
    'arrow-tapered',
    'Swoosh Arrow',
    C,
    (() => {
      // A dynamic tapered shaft along a curve ending in a sharp head.
      const shaft = cubicPts([0, 92], [26, 88], [52, 66], [74, 34], 40);
      const body = taperedStroke(shaft, (t) => 2 + 14 * t);
      const head: Pt[] = [
        [62, 20],
        [100, 0],
        [92, 44],
      ];
      return polys([body, head]);
    })(),
  ),
  preset(
    'arrow-zigzag',
    'Zigzag Arrow',
    C,
    (() => {
      const line = joinRuns([[0, 80], [30, 50], [48, 68], [76, 36]]);
      const body = taperedStroke(line, () => 12, { miterLimit: 2 });
      const head: Pt[] = [
        [64, 22],
        [100, 12],
        [90, 48],
      ];
      return polys([body, head]);
    })(),
  ),
];
