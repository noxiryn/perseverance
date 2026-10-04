/**
 * Text warp mappings (pure). Photoshop-like styles parameterized by bend / horizontal / vertical
 * distortion, each in PERCENT (-100..100) as stored in `TextProps.warp`.
 *
 * `warpPoint` maps a point of the flat layout box (relative to the box center; half sizes a, c)
 * to its warped position (also relative to the box center). The mapping is smooth and defined
 * outside the box too (needed for strokes/descenders in the render padding).
 */
import type { TextWarpStyle } from '../core/types';

export interface WarpParams {
  style: TextWarpStyle;
  /** Percent -100..100 */
  bend: number;
  horizontal: number;
  vertical: number;
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, (Number.isFinite(v) ? v : 0) / 100));

export function isWarpActive(w: WarpParams | null | undefined): boolean {
  if (!w || w.style === 'none') return false;
  return Math.abs(w.bend) > 0.05 || Math.abs(w.horizontal) > 0.05 || Math.abs(w.vertical) > 0.05;
}

/**
 * Map (x, y) relative to the layout box center → warped (X, Y) relative to the center.
 * a = half width, c = half height of the layout box.
 */
export function warpPoint(w: WarpParams, x: number, y: number, a: number, c: number): [number, number] {
  const b = clamp1(w.bend);
  const hd = clamp1(w.horizontal);
  const vd = clamp1(w.vertical);
  const A = Math.max(1e-6, a);
  const C = Math.max(1e-6, c);
  const u = x / A;
  const v = y / C;
  let X = x;
  let Y = y;
  switch (w.style) {
    case 'arc': {
      // Text follows concentric circular arcs; glyphs fan out (rotate).
      if (Math.abs(b) > 1e-4) {
        const theta = b * Math.PI * 0.95; // total sweep of the middle line
        const R = (2 * A) / theta; // signed radius of the middle line
        const alpha = (x / (2 * A)) * theta;
        const r = R - y;
        X = r * Math.sin(alpha);
        Y = R - r * Math.cos(alpha);
      }
      break;
    }
    case 'arch': {
      // Columns stay vertical, shifted along a parabola; the bottom edge flattens.
      const lift = b * C * 1.2 * (1 - u * u);
      const keep = (1 - v) / 2; // 1 at top, 0 at bottom
      Y = y - lift * (0.35 + 0.65 * keep);
      break;
    }
    case 'bulge':
      Y = y * (1 + b * 0.6 * (1 - u * u));
      break;
    case 'flag':
      Y = y - b * C * 0.6 * Math.sin(Math.PI * u);
      break;
    case 'wave':
      Y = y - b * C * 0.5 * Math.sin(Math.PI * 1.5 * u + v * Math.PI * 0.5);
      break;
    case 'rise':
      Y = y - b * C * 0.9 * (u + 0.25 * Math.sin(Math.PI * u));
      break;
    case 'fisheye': {
      const m = 1 + b * 0.5 * (1 - Math.min(1, u * u));
      X = x * (1 + b * 0.35 * (1 - Math.min(1, u * u)));
      Y = y * m * (1 + b * 0.25 * (1 - Math.min(1, v * v)));
      break;
    }
    case 'squeeze':
      Y = y * (1 - b * 0.45 * (1 - u * u));
      X = x * (1 - b * 0.25 * (1 - Math.min(1, v * v)));
      break;
    default:
      break;
  }
  // Perspective-like distortions: one side grows while the other shrinks.
  if (hd) {
    const f = 1 + hd * 0.6 * Math.max(-1.5, Math.min(1.5, X / A));
    Y *= f;
    X *= 1 + hd * 0.12 * Math.max(-1.5, Math.min(1.5, X / A));
  }
  if (vd) {
    const f = 1 + vd * 0.6 * Math.max(-1.5, Math.min(1.5, Y / C));
    X *= f;
    Y *= 1 + vd * 0.12 * Math.max(-1.5, Math.min(1.5, Y / C));
  }
  return [X, Y];
}
