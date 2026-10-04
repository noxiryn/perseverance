/** Drop shadow, inner shadow and long shadow. */
import { ctx2d } from '../../core/canvas';
import { acquire, release } from '../surface';
import {
  P,
  blurredCopy,
  bool,
  clamp01,
  colorize,
  defineEffect,
  finish,
  inverseMatte,
  num,
  offsetDir,
  readAlpha,
  regionOf,
  sizeSigma,
  softDilate,
  str,
  type LocalRect,
} from './common';
import { longShadowFade } from './math';

export const dropShadow = defineEffect(
  {
    id: 'drop-shadow',
    name: 'Drop Shadow',
    stage: 'behind',
    order: 10,
    params: [
      P.color('color', 'Color', '#000000'),
      P.blend('multiply'),
      P.opacity(0.75),
      P.angle(120),
      P.px('distance', 'Distance', 10, 500),
      P.percent('spread', 'Spread', 0),
      P.px('size', 'Size', 12, 250),
    ],
    render(args) {
      const p = args.params;
      const s = args.scale;
      const dir = offsetDir(num(p.angle, 120));
      const dist = Math.max(0, num(p.distance, 10)) * s;
      const size = Math.max(0, num(p.size, 12)) * s;
      const spread = clamp01(num(p.spread, 0));
      const dx = dir.x * dist;
      const dy = dir.y * dist;
      let c: HTMLCanvasElement;
      if (spread > 0.001) {
        const base = softDilate(args.content, size * spread, dx, dy);
        c = blurredCopy(base, sizeSigma(size * (1 - spread)));
        release(base);
      } else c = blurredCopy(args.content, sizeSigma(size), dx, dy);
      colorize(c, str(p.color, '#000000'));
      finish(args.target, c, num(p.opacity, 0.75));
    },
  },
  { reach: (p, s) => (Math.max(0, num(p.distance, 10)) + Math.max(0, num(p.size, 12)) * 1.3 + 2) * s },
);

export const innerShadow = defineEffect(
  {
    id: 'inner-shadow',
    name: 'Inner Shadow',
    stage: 'above',
    order: 60,
    params: [
      P.color('color', 'Color', '#000000'),
      P.blend('multiply'),
      P.opacity(0.75),
      P.angle(120),
      P.px('distance', 'Distance', 5, 500),
      P.percent('choke', 'Choke', 0),
      P.px('size', 'Size', 5, 250),
    ],
    render(args) {
      const p = args.params;
      const s = args.scale;
      const dir = offsetDir(num(p.angle, 120));
      const dist = Math.max(0, num(p.distance, 5)) * s;
      const size = Math.max(0, num(p.size, 5)) * s;
      const choke = clamp01(num(p.choke, 0));
      const inv = inverseMatte(args.content, dir.x * dist, dir.y * dist);
      let c: HTMLCanvasElement;
      if (choke > 0.001) {
        const base = softDilate(inv, size * choke);
        c = blurredCopy(base, sizeSigma(size * (1 - choke)));
        release(base);
      } else c = blurredCopy(inv, sizeSigma(size));
      release(inv);
      colorize(c, str(p.color, '#000000'));
      finish(args.target, c, num(p.opacity, 0.75));
    },
  },
  // The inverse matte needs margin around the content so its blur never sees the surface edge.
  { reach: (p, s) => (Math.max(0, num(p.distance, 5)) + Math.max(0, num(p.size, 5)) * 1.3 + 2) * s },
);

/** Rect covering the content bounds and their translation by (tx, ty), clipped to the canvas. */
function sweepRect(b: LocalRect, tx: number, ty: number, W: number, H: number): LocalRect | null {
  const x0 = Math.max(0, Math.floor(Math.min(b.x, b.x + tx)) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(b.y, b.y + ty)) - 2);
  const x1 = Math.min(W, Math.ceil(Math.max(b.x + b.w, b.x + b.w + tx)) + 2);
  const y1 = Math.min(H, Math.ceil(Math.max(b.y + b.h, b.y + b.h + ty)) + 2);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const longShadow = defineEffect(
  {
    id: 'long-shadow',
    name: 'Long Shadow',
    stage: 'behind',
    order: 5,
    params: [
      P.color('color', 'Color', '#000000'),
      P.blend('normal'),
      P.opacity(1),
      P.angle(135),
      P.px('length', 'Length', 60, 2000),
      { key: 'fade', label: 'Fade Out', type: 'boolean', default: false },
    ],
    render(args) {
      const p = args.params;
      const s = args.scale;
      const L = Math.max(0, num(p.length, 60)) * s;
      if (L < 0.5) return;
      const dir = offsetDir(num(p.angle, 135));
      const W = args.content.width;
      const H = args.content.height;
      const c = acquire(W, H);
      const ctx = ctx2d(c);
      if (bool(p.fade, false)) {
        const r = sweepRect(regionOf(args).bounds, dir.x * L, dir.y * L, W, H);
        if (!r) return release(c);
        const a = readAlpha(args.content, r);
        const v = longShadowFade(a, r.w, r.h, dir.x, dir.y, L);
        const img = new ImageData(r.w, r.h);
        const d = img.data;
        for (let i = 0, j = 3; i < v.length; i++, j += 4) {
          d[j - 3] = 255;
          d[j - 2] = 255;
          d[j - 1] = 255;
          d[j] = v[i];
        }
        ctx.putImageData(img, r.x, r.y);
      } else {
        // Union of the silhouette translated by 0..L px along the direction, by doubling.
        ctx.drawImage(args.content, 0, 0);
        let covered = 1;
        let guard = 0;
        while (covered * 2 <= L + 1 && guard++ < 16) {
          ctx.drawImage(c, dir.x * covered, dir.y * covered);
          covered *= 2;
        }
        if (covered < L + 1) {
          const r = L + 1 - covered;
          ctx.drawImage(c, dir.x * r, dir.y * r);
        }
      }
      colorize(c, str(p.color, '#000000'));
      finish(args.target, c, num(p.opacity, 1));
    },
  },
  { reach: (p, s) => (Math.max(0, num(p.length, 60)) + 2) * s },
);
