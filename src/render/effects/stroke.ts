/** Stroke: crisp anti-aliased outline from an exact distance transform (outside/inside/center). */
import { fillWithPaint } from '../paint';
import { DEFAULT_GRADIENT, P, alphaOfColor, clamp01, defineEffect, isGradient, num, readAlpha, regionOf, rgbOf, str, workRect } from './common';
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
      const opacity = clamp01(num(p.opacity, 1));
      if (opacity <= 0) return;
      const a = readAlpha(args.content, r);
      const cov = strokeCoverage(a, r.w, r.h, size, pos);
      const gradient = str(p.fillType, 'color') === 'gradient' && isGradient(p.gradient) ? p.gradient : null;
      const color = str(p.color, '#000000');
      const [cr, cg, cb] = gradient ? [255, 255, 255] : rgbOf(color);
      // Opacity (and the color's own alpha) folded into the coverage; the target is empty, so
      // the stroke is written in place.
      const k = gradient ? opacity : opacity * alphaOfColor(color);
      const img = new ImageData(r.w, r.h);
      // One 32-bit store per pixel (RGBA bytes in memory order = little-endian ABGR word).
      const px32 = new Uint32Array(img.data.buffer);
      const rgb = (cb << 16) | (cg << 8) | cr;
      const alpha = new Uint32Array(256);
      for (let v = 0; v < 256; v++) alpha[v] = ((Math.round(v * k) << 24) | rgb) >>> 0;
      for (let i = 0; i < cov.length; i++) {
        const v = cov[i];
        if (v) px32[i] = alpha[v];
      }
      const t = args.target;
      t.putImageData(img, r.x, r.y);
      if (gradient) {
        const b = regionOf(args).bounds;
        const grow = pos === 'inside' ? 0 : pos === 'center' ? size / 2 : size;
        const area = new Path2D();
        area.rect(r.x, r.y, r.w, r.h);
        t.save();
        t.setTransform(1, 0, 0, 1, 0, 0);
        t.globalCompositeOperation = 'source-in';
        fillWithPaint(t, { type: 'gradient', gradient }, { x: b.x - grow, y: b.y - grow, width: b.w + 2 * grow, height: b.h + 2 * grow }, area);
        t.restore();
      }
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

