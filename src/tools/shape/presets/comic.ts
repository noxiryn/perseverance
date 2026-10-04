/** Comic shapes: speech/thought/shout bubbles, bursts and impact stars. */
import type { ShapePresetDef } from '../../../registry';
import { circle, fmt, polar, poly, preset, scallopPath, starPts, type Pt } from './pathKit';

const C = 'Comic';
const P = (p: Pt) => `${fmt(p[0])} ${fmt(p[1])}`;

/** Ellipse speech bubble with a curved tail between two ellipse angles (degrees, screen space). */
function speechBubble(cx: number, cy: number, rx: number, ry: number, aStart: number, aEnd: number, tip: Pt, bend: Pt, bend2: Pt): string {
  const s = polar(cx, cy, rx, aStart, ry);
  const e = polar(cx, cy, rx, aEnd, ry);
  // Long way around from aStart back to aEnd (counter-clockwise on screen).
  return `M${P(s)}A${fmt(rx)} ${fmt(ry)} 0 1 0 ${P(e)}Q${P(bend)} ${P(tip)}Q${P(bend2)} ${P(s)}Z`;
}

// Deterministic "random" spike lengths for bursts.
const SHOUT = [1, 0.86, 0.97, 0.82, 1, 0.9, 0.84, 0.98, 0.88, 1, 0.83, 0.95, 0.87, 0.99, 0.85, 0.93, 0.89, 0.96];
const BOOM = [1, 0.72, 0.94, 0.66, 0.88, 1, 0.7, 0.92, 0.78, 0.98, 0.68, 0.9, 0.8, 0.96];

export const comicPresets: ShapePresetDef[] = [
  preset('bubble-speech', 'Speech Bubble', C, speechBubble(50, 38, 50, 36, 100, 124, [8, 100], [20, 86], [28, 90])),
  preset(
    'bubble-speech-box',
    'Caption Bubble',
    C,
    'M10 0L90 0Q100 0 100 10L100 54Q100 64 90 64L40 64L18 90L24 64L10 64Q0 64 0 54L0 10Q0 0 10 0Z',
  ),
  preset(
    'bubble-thought',
    'Thought Bubble',
    C,
    [scallopPath(54, 38, 44, 32, 11, 1.18, -80), circle(18, 84, 7.5), circle(7, 98, 4.5)],
  ),
  preset(
    'bubble-shout',
    'Shout Bubble',
    C,
    (() => {
      const pts = starPts(
        18,
        50,
        40,
        SHOUT.map((k) => 50 * k),
        SHOUT.map((k) => 40 * (0.96 + (k - 0.9) * 0.3)),
        -90,
        0.78,
      );
      // Stretch one lower-left spike into a tail.
      const tailIdx = 22;
      pts[tailIdx] = [10, 100];
      return poly(pts);
    })(),
  ),
  preset(
    'burst-explosion',
    'Explosion Burst',
    C,
    poly(
      starPts(
        14,
        50,
        50,
        BOOM.map((k) => 50 * k),
        BOOM.map((k, i) => 50 * (0.42 + ((i * 7) % 5) * 0.035) * (0.9 + k * 0.1)),
        -84,
      ),
    ),
  ),
  preset('impact-star', 'Impact Star', C, poly(starPts(8, 50, 50, [50, 30, 44, 26, 50, 32, 42, 28], 9, -90))),
  preset('burst-sfx', 'SFX Burst', C, poly(starPts(20, 50, 30, [50, 44, 48, 42], [38, 36], -90, 0.6))),
];
