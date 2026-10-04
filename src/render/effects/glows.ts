/** Outer glow and inner glow. */
import { ctx2d } from '../../core/canvas';
import { acquire, release } from '../surface';
import { P, blurredCopy, boostAlpha, clamp01, colorize, defineEffect, finish, inverseMatte, num, sizeSigma, softDilate, str } from './common';

/** Glow matte: (optionally spread) matte blurred so the edge sits at full intensity. */
function glowMatte(src: HTMLCanvasElement, size: number, spread: number): HTMLCanvasElement {
  let c: HTMLCanvasElement;
  if (spread > 0.001) {
    const base = softDilate(src, size * spread);
    c = blurredCopy(base, sizeSigma(size * (1 - spread)));
    release(base);
  } else c = blurredCopy(src, sizeSigma(size));
  boostAlpha(c, 2);
  return c;
}

export const outerGlow = defineEffect(
  {
    id: 'outer-glow',
    name: 'Outer Glow',
    stage: 'behind',
    order: 20,
    params: [
      P.color('color', 'Color', '#ffffff'),
      P.blend('screen'),
      P.opacity(0.75),
      P.percent('spread', 'Spread', 0),
      P.px('size', 'Size', 18, 250),
    ],
    render(args) {
      const p = args.params;
      const size = Math.max(0, num(p.size, 18)) * args.scale;
      const spread = clamp01(num(p.spread, 0));
      if (size < 0.25 && spread < 0.001) return;
      const c = glowMatte(args.content, size, spread);
      colorize(c, str(p.color, '#ffffff'));
      finish(args.target, c, num(p.opacity, 0.75));
    },
  },
  { reach: (p, s) => (Math.max(0, num(p.size, 18)) * 1.3 + 2) * s },
);

export const innerGlow = defineEffect(
  {
    id: 'inner-glow',
    name: 'Inner Glow',
    stage: 'above',
    order: 50,
    params: [
      P.color('color', 'Color', '#fff6c2'),
      P.blend('screen'),
      P.opacity(0.75),
      {
        key: 'source',
        label: 'Source',
        type: 'select',
        options: [
          { value: 'edge', label: 'Edge' },
          { value: 'center', label: 'Center' },
        ],
        default: 'edge',
      },
      P.percent('choke', 'Choke', 0),
      P.px('size', 'Size', 10, 250),
    ],
    render(args) {
      const p = args.params;
      const size = Math.max(0, num(p.size, 10)) * args.scale;
      const choke = clamp01(num(p.choke, 0));
      const inv = inverseMatte(args.content);
      const edge = glowMatte(inv, size, choke);
      release(inv);
      let c = edge;
      if (str(p.source, 'edge') === 'center') {
        c = acquire(args.content.width, args.content.height);
        const ctx = ctx2d(c);
        ctx.drawImage(args.content, 0, 0);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(edge, 0, 0);
        release(edge);
      }
      colorize(c, str(p.color, '#fff6c2'));
      finish(args.target, c, num(p.opacity, 0.75));
    },
  },
  { reach: (p, s) => (Math.max(0, num(p.size, 10)) * 1.3 + 2) * s },
);
