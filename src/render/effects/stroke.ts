/** Stroke: crisp anti-aliased outline from an exact distance transform (outside/inside/center). */
import { ctx2d } from '../../core/canvas';
import { fillWithPaint } from '../paint';
import { acquire } from '../surface';
import { DEFAULT_GRADIENT, P, defineEffect, finish, isGradient, num, readAlpha, regionOf, rgbOf, str, workRect } from './common';
import { strokeCoverage, type StrokePosition } from './math';

function position(v: unknown): StrokePosition {
  return v === 'inside' || v === 'center' ? v : 'outside';
}

export const stroke = defineEffect(
  {
    id: 'stroke',
    name: 'Stroke',
    stage: 'above',
    order: 80,
    params: [
      P.px('size', 'Size', 4, 250, 1),
      {
        key: 'position',
        label: 'Position',
        type: 'select',
        options: [
          { value: 'outside', label: 'Outside' },
          { value: 'inside', label: 'Inside' },
          { value: 'center', label: 'Center' },
        ],
        default: 'outside',
      },
      P.blend('normal'),
      P.opacity(1),
      {
        key: 'fillType',
        label: 'Fill Type',
        type: 'select',
        options: [
          { value: 'color', label: 'Color' },
          { value: 'gradient', label: 'Gradient' },
        ],
        default: 'color',
      },
      { ...P.color('color', 'Color', '#000000'), showIf: (v) => v.fillType !== 'gradient' },
      { key: 'gradient', label: 'Gradient', type: 'gradient', default: DEFAULT_GRADIENT, showIf: (v) => v.fillType === 'gradient' },
    ],
    render(args) {
      const p = args.params;
      const size = Math.max(0, num(p.size, 4)) * args.scale;
      if (size < 0.05) return;
      const pos = position(p.position);
      const r = workRect(args, size + 2);
      if (!r) return;
      const a = readAlpha(args.content, r);
      const cov = strokeCoverage(a, r.w, r.h, size, pos);
      const gradient = str(p.fillType, 'color') === 'gradient' && isGradient(p.gradient) ? p.gradient : null;
      const [cr, cg, cb] = gradient ? [255, 255, 255] : rgbOf(str(p.color, '#000000'));
      const img = new ImageData(r.w, r.h);
      const d = img.data;
      for (let i = 0, j = 0; i < cov.length; i++, j += 4) {
        d[j] = cr;
        d[j + 1] = cg;
        d[j + 2] = cb;
        d[j + 3] = cov[i];
      }
      const c = acquire(args.content.width, args.content.height);
      const ctx = ctx2d(c);
      ctx.putImageData(img, r.x, r.y);
      if (gradient) {
        const b = regionOf(args).bounds;
        const grow = pos === 'inside' ? 0 : pos === 'center' ? size / 2 : size;
        ctx.globalCompositeOperation = 'source-in';
        fillWithPaint(ctx, { type: 'gradient', gradient }, { x: b.x - grow, y: b.y - grow, width: b.w + 2 * grow, height: b.h + 2 * grow }, fullPath(c));
        ctx.globalCompositeOperation = 'source-over';
      } else {
        const ca = alphaFromColor(str(p.color, '#000000'));
        if (ca < 1) {
          ctx.globalCompositeOperation = 'destination-in';
          ctx.fillStyle = `rgba(0,0,0,${ca})`;
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      finish(args.target, c, num(p.opacity, 1));
    },
  },
  {
    stage: (p) => (position(p.position) === 'outside' ? 'behind' : 'above'),
    clip: (p) => position(p.position) === 'inside',
    reach: (p, s) => {
      const pos = position(p.position);
      const size = Math.max(0, num(p.size, 4));
      return pos === 'inside' ? 0 : (pos === 'center' ? size / 2 : size) * s + 2;
    },
  },
);

function fullPath(c: HTMLCanvasElement): Path2D {
  const path = new Path2D();
  path.rect(0, 0, c.width, c.height);
  return path;
}

function alphaFromColor(color: string): number {
  const s = color.trim();
  if (s[0] === '#' && s.length === 9) return parseInt(s.slice(7, 9), 16) / 255;
  if (s[0] === '#' && s.length === 5) return parseInt(s[4] + s[4], 16) / 255;
  return 1;
}
