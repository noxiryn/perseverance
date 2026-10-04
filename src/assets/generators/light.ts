/**
 * Light & Glow: sunburst-rays, light-rays, lens-flare, bokeh, glow-orb.
 */
import type { AssetDef } from '../../registry';
import { P, defineAsset } from '../lib/params';
import { softSprite, tintSprite } from '../lib/raster';
import { TAU, drawUpscaled, makeRand, mixRGB, newCanvas, num, pointParam, rgbOf, rgba, str, unitOf } from '../lib/util';

/* ------------------------------------------------------------------ */
/* sunburst-rays                                                       */
/* ------------------------------------------------------------------ */

const sunburstRays = defineAsset(
  {
    id: 'sunburst-rays',
    name: 'Sunburst Rays',
    category: 'Light & Glow',
    tags: ['sunburst', 'rays', 'radial', 'halo', 'burst', 'comic', 'retro', 'glow'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    defaultOpacity: 0.9,
    params: [
      P.num('rays', 'Rays', 8, 400, 150),
      P.point('center', 'Center', { x: 0.5, y: 0.42 }),
      P.color('color', 'Color', '#fff1cc'),
      P.pct('thickness', 'Ray width', 0.32),
      P.pct('fade', 'Fade', 0.6),
      P.select(
        'style',
        'Style',
        [
          ['fine', 'Fine halo lines'],
          ['bold', 'Bold comic wedges'],
        ],
        'fine',
      ),
      P.num('length', 'Length', 0.2, 2, 0.85, { step: 0.01, unit: '×' }),
      P.pct('inner', 'Inner radius', 0.12, { max: 0.6 }),
      P.num('rings', 'Rings', 0, 12, 4),
      P.pct('glow', 'Center glow', 0.45),
      P.seed(61),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 61));
      const n = Math.max(4, Math.round(num(p, 'rays', 150)));
      const ctr = pointParam(p, 'center', { x: 0.5, y: 0.42 });
      const cx = ctr.x * W;
      const cy = ctr.y * H;
      const color = str(p, 'color', '#fff1cc');
      const thick = num(p, 'thickness', 0.32);
      const fade = num(p, 'fade', 0.6);
      const bold = str(p, 'style', 'fine') === 'bold';
      const M = Math.min(W, H);
      const far = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.05;
      const R = bold ? Math.max(far, M * num(p, 'length', 0.85)) : M * num(p, 'length', 0.85);
      const r0 = M * num(p, 'inner', 0.12);
      const [c, ctx] = newCanvas(W, H);
      const period = TAU / n;
      const path = new Path2D();
      for (let i = 0; i < n; i++) {
        if (bold && i % 2) continue;
        const a = i * period + (bold ? 0 : (r() - 0.5) * period * 0.7);
        const half = (period * thick * (bold ? 1 : 0.5 + r())) / 2;
        const rs = bold ? r0 : r0 * (1 + r() * 0.35);
        const re = bold ? R : R * (0.45 + r() * r() * 0.55 + (r() < 0.25 ? 0.25 : 0));
        // a thin wedge: narrow at the start, wider at the end (perspective lines)
        const w0 = bold ? half * 0.15 : half * 0.08;
        path.moveTo(cx + Math.cos(a - w0) * rs, cy + Math.sin(a - w0) * rs);
        path.lineTo(cx + Math.cos(a - half) * re, cy + Math.sin(a - half) * re);
        if (bold) path.arc(cx, cy, re, a - half, a + half);
        else path.lineTo(cx + Math.cos(a + half) * re, cy + Math.sin(a + half) * re);
        path.lineTo(cx + Math.cos(a + w0) * rs, cy + Math.sin(a + w0) * rs);
        path.closePath();
      }
      ctx.fillStyle = color;
      ctx.fill(path);
      // concentric rings (broken arcs) like printed halo graphics
      const rings = Math.round(num(p, 'rings', 4));
      if (rings > 0) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineCap = 'butt';
        for (let k = 0; k < rings; k++) {
          const rr = r0 + (R - r0) * ((k + 0.6 + r() * 0.3) / (rings + 0.6)) * 0.9;
          ctx.lineWidth = Math.max(0.6, u * (0.8 + r() * 1.8));
          ctx.setLineDash([u * (6 + r() * 60), u * (3 + r() * 16), u * (1 + r() * 4), u * (4 + r() * 10)]);
          ctx.lineDashOffset = r() * 100;
          ctx.globalAlpha = 0.45 + r() * 0.4;
          ctx.beginPath();
          ctx.arc(cx, cy, rr, 0, TAU);
          ctx.stroke();
        }
        ctx.restore();
      }
      // radial alpha mask: clear hole in the center, fade towards the ends
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      const hole = r0 / R;
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(Math.min(0.98, hole * 0.9), 'rgba(0,0,0,0)');
      g.addColorStop(Math.min(0.99, hole * 1.35 + 0.02), 'rgba(0,0,0,1)');
      const fStart = Math.min(0.995, Math.max(hole * 1.4 + 0.03, 1 - fade * 0.85));
      g.addColorStop(fStart, 'rgba(0,0,0,1)');
      g.addColorStop(1, `rgba(0,0,0,${bold ? (1 - fade).toFixed(3) : '0'})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      const glow = num(p, 'glow', 0.45);
      if (glow > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const gg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r0 * 2.6, M * 0.25));
        gg.addColorStop(0, rgba(color, 0.65 * glow));
        gg.addColorStop(0.35, rgba(color, 0.28 * glow));
        gg.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = gg;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'mid' },
);

/* ------------------------------------------------------------------ */
/* light-rays (god rays)                                               */
/* ------------------------------------------------------------------ */

const lightRays = defineAsset(
  {
    id: 'light-rays',
    name: 'Light Rays',
    category: 'Light & Glow',
    tags: ['god rays', 'light', 'beams', 'volumetric', 'heaven', 'sun', 'shafts'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color', 'Color', '#fff2d2'),
      P.point('source', 'Source', { x: 0.25, y: -0.05 }),
      P.angle('angle', 'Direction', -60),
      P.num('spread', 'Spread', 10, 160, 55, { unit: '°' }),
      P.num('count', 'Beams', 3, 40, 14),
      P.num('length', 'Length', 0.3, 2, 1.2, { step: 0.01, unit: '×' }),
      P.pct('softness', 'Softness', 0.55),
      P.pct('intensity', 'Intensity', 0.7),
      P.seed(67),
    ],
    generate(p, { width: W, height: H }) {
      const r = makeRand(num(p, 'seed', 67));
      const src = pointParam(p, 'source', { x: 0.25, y: -0.05 });
      const dir = (-num(p, 'angle', -60) * Math.PI) / 180;
      const spread = (num(p, 'spread', 55) * Math.PI) / 180;
      const n = Math.max(1, Math.round(num(p, 'count', 14)));
      const intensity = num(p, 'intensity', 0.7);
      const soft = num(p, 'softness', 0.55);
      const color = str(p, 'color', '#fff2d2');
      const s = Math.min(1, Math.sqrt(220_000 / (W * H)));
      const w = Math.max(2, Math.round(W * s));
      const h = Math.max(2, Math.round(H * s));
      const L = Math.hypot(w, h) * num(p, 'length', 1.2);
      const sx = src.x * w;
      const sy = src.y * h;
      const [lo, lctx] = newCanvas(w, h);
      lctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const a = dir + (((i + 0.5) / n - 0.5) * spread + (r() - 0.5) * (spread / n) * 1.4);
        const half = (spread / n) * (0.12 + r() * 0.45);
        const len = L * (0.5 + r() * 0.5);
        const g = lctx.createRadialGradient(sx, sy, 0, sx, sy, len);
        const al = (0.18 + r() * 0.32) * intensity;
        g.addColorStop(0, rgba(color, al));
        g.addColorStop(0.45, rgba(color, al * 0.55));
        g.addColorStop(1, rgba(color, 0));
        lctx.fillStyle = g;
        lctx.beginPath();
        lctx.moveTo(sx, sy);
        lctx.arc(sx, sy, len, a - half, a + half);
        lctx.closePath();
        lctx.fill();
      }
      // source glow
      const sg = lctx.createRadialGradient(sx, sy, 0, sx, sy, Math.min(w, h) * 0.35);
      sg.addColorStop(0, rgba(color, 0.6 * intensity));
      sg.addColorStop(1, rgba(color, 0));
      lctx.fillStyle = sg;
      lctx.fillRect(0, 0, w, h);
      const [c, ctx] = newCanvas(W, H);
      ctx.filter = `blur(${Math.max(1, Math.min(W, H) * (0.004 + soft * 0.02))}px)`;
      drawUpscaled(ctx, lo, W, H);
      ctx.filter = 'none';
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* lens-flare                                                          */
/* ------------------------------------------------------------------ */

function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, rad: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rot + (i / 6) * TAU;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
}

const lensFlare = defineAsset(
  {
    id: 'lens-flare',
    name: 'Lens Flare',
    category: 'Light & Glow',
    tags: ['lens flare', 'flare', 'sun', 'light', 'anamorphic', 'cinematic', 'glow'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.point('position', 'Position', { x: 0.72, y: 0.28 }),
      P.num('brightness', 'Brightness', 0.1, 2, 1, { step: 0.01, unit: '×' }),
      P.color('color', 'Tint', '#ffb36b'),
      P.pct('streak', 'Anamorphic streak', 0.6),
      P.pct('ghosts', 'Ghosts', 0.6),
      P.num('rays', 'Star rays', 0, 16, 6),
      P.seed(71),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 71));
      const pos = pointParam(p, 'position', { x: 0.72, y: 0.28 });
      const b = num(p, 'brightness', 1);
      const tint = rgbOf(str(p, 'color', '#ffb36b'));
      const lx = pos.x * W;
      const ly = pos.y * H;
      const M = Math.min(W, H);
      const [c, ctx] = newCanvas(W, H);
      ctx.globalCompositeOperation = 'lighter';
      const radial = (x: number, y: number, rad: number, stops: [number, string][]) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        for (const [o, col] of stops) g.addColorStop(o, col);
        ctx.fillStyle = g;
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      };
      // wide atmospheric glow
      radial(lx, ly, M * 0.6, [
        [0, rgba(tint, 0.35 * b)],
        [0.3, rgba(tint, 0.12 * b)],
        [1, rgba(tint, 0)],
      ]);
      // core
      radial(lx, ly, M * 0.12, [
        [0, rgba('#ffffff', Math.min(1, 1 * b))],
        [0.15, rgba('#fff8ec', Math.min(1, 0.9 * b))],
        [0.4, rgba(tint, 0.45 * b)],
        [1, rgba(tint, 0)],
      ]);
      // anamorphic streak
      const streak = num(p, 'streak', 0.6);
      if (streak > 0) {
        ctx.save();
        ctx.translate(lx, ly);
        ctx.scale(1, 0.018 + 0.01 * (1 - streak));
        const sl = W * (0.4 + streak * 0.6);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, sl);
        g.addColorStop(0, rgba('#e8f2ff', 0.9 * b * streak));
        g.addColorStop(0.2, rgba('#9cc8ff', 0.45 * b * streak));
        g.addColorStop(1, 'rgba(80,140,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-sl, -sl, sl * 2, sl * 2);
        ctx.restore();
      }
      // star rays
      const rays = Math.round(num(p, 'rays', 6));
      if (rays > 0) {
        const a0 = r() * Math.PI;
        for (let i = 0; i < rays; i++) {
          const a = a0 + (i / rays) * Math.PI;
          const len = M * (0.12 + r() * 0.16) * b;
          ctx.save();
          ctx.translate(lx, ly);
          ctx.rotate(a);
          const g = ctx.createLinearGradient(-len, 0, len, 0);
          g.addColorStop(0, 'rgba(255,255,255,0)');
          g.addColorStop(0.5, rgba('#ffffff', 0.55 * Math.min(1, b)));
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(-len, 0);
          ctx.lineTo(0, -1.4 * u);
          ctx.lineTo(len, 0);
          ctx.lineTo(0, 1.4 * u);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
      // halo ring with chromatic edge
      {
        const hr = M * 0.28;
        const g = ctx.createRadialGradient(lx, ly, hr * 0.86, lx, ly, hr * 1.04);
        g.addColorStop(0, 'rgba(255,60,40,0)');
        g.addColorStop(0.35, `rgba(255,80,60,${(0.07 * b).toFixed(3)})`);
        g.addColorStop(0.55, `rgba(120,255,140,${(0.06 * b).toFixed(3)})`);
        g.addColorStop(0.75, `rgba(90,140,255,${(0.08 * b).toFixed(3)})`);
        g.addColorStop(1, 'rgba(90,140,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(lx - hr * 1.1, ly - hr * 1.1, hr * 2.2, hr * 2.2);
      }
      // ghosts along the axis through the image center
      const ghosts = num(p, 'ghosts', 0.6);
      if (ghosts > 0) {
        const cx = W / 2;
        const cy = H / 2;
        const vx = cx - lx;
        const vy = cy - ly;
        const n = Math.round(4 + ghosts * 6);
        const palette = [tint, { r: 120, g: 255, b: 170 }, { r: 110, g: 160, b: 255 }, { r: 255, g: 120, b: 200 }, mixRGB(tint, { r: 255, g: 255, b: 255 }, 0.5)];
        for (let i = 0; i < n; i++) {
          const t = 0.3 + r() * 1.9;
          const x = lx + vx * t;
          const y = ly + vy * t;
          const rad = M * (0.015 + r() ** 2 * 0.11);
          const col = palette[Math.floor(r() * palette.length)];
          const al = (0.05 + r() * 0.12) * b * ghosts;
          if (r() < 0.45) {
            hexPath(ctx, x, y, rad, r() * TAU);
            ctx.fillStyle = rgba(col, al);
            ctx.fill();
            ctx.strokeStyle = rgba(col, al * 1.4);
            ctx.lineWidth = Math.max(0.5, u);
            ctx.stroke();
          } else {
            radial(x, y, rad, [
              [0, rgba(col, al * 0.6)],
              [0.75, rgba(col, al)],
              [0.92, rgba(col, al * 1.6)],
              [1, rgba(col, 0)],
            ]);
          }
        }
      }
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* bokeh                                                               */
/* ------------------------------------------------------------------ */

function bokehDisc(ctx: CanvasRenderingContext2D, x: number, y: number, rad: number, col: string, a: number, hex: boolean, rot: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
  g.addColorStop(0, rgba(col, a * 0.55));
  g.addColorStop(0.7, rgba(col, a * 0.7));
  g.addColorStop(0.9, rgba(col, a));
  g.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = g;
  if (hex) hexPath(ctx, x, y, rad, rot);
  else {
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, TAU);
  }
  ctx.fill();
}

const bokeh = defineAsset(
  {
    id: 'bokeh',
    name: 'Bokeh',
    category: 'Light & Glow',
    tags: ['bokeh', 'lights', 'blur', 'circles', 'dreamy', 'night', 'city lights'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color1', 'Color 1', '#ffb347'),
      P.color('color2', 'Color 2', '#ff4f9a'),
      P.color('color3', 'Color 3', '#7fd4ff'),
      P.num('count', 'Count', 5, 300, 70),
      P.num('size', 'Size', 10, 300, 70, { unit: 'px' }),
      P.pct('blur', 'Depth blur', 0.35),
      P.select('shape', 'Aperture', ['circle', 'hexagon'], 'circle'),
      P.seed(73),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 73));
      const cols = [str(p, 'color1', '#ffb347'), str(p, 'color2', '#ff4f9a'), str(p, 'color3', '#7fd4ff')];
      const n = Math.round(num(p, 'count', 70));
      const size = num(p, 'size', 70) * u;
      const blur = num(p, 'blur', 0.35);
      const hex = str(p, 'shape', 'circle') === 'hexagon';
      const [c, ctx] = newCanvas(W, H);
      const layers: [number, number][] = [
        [0.55, blur * 14],
        [0.3, blur * 5],
        [0.15, 0],
      ];
      for (const [frac, bl] of layers) {
        const [lc, lctx] = newCanvas(W, H);
        lctx.globalCompositeOperation = 'lighter';
        const k = Math.round(n * frac);
        for (let i = 0; i < k; i++) {
          // cluster towards a diagonal band for a natural composition
          const t = r();
          const x = (t + (r() - 0.5) * 0.5) * W;
          const y = (0.25 + 0.5 * (1 - t) + (r() - 0.5) * 0.7) * H;
          const rad = size * (0.25 + r() ** 1.5 * 1.3) * (bl > 0 ? 1.3 : 0.8);
          bokehDisc(lctx, x, y, rad, cols[Math.floor(r() * 3)], 0.12 + r() * 0.4, hex, 0.3);
        }
        if (bl > 0) ctx.filter = `blur(${bl * u}px)`;
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(lc, 0, 0);
        ctx.filter = 'none';
      }
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* glow-orb (element)                                                  */
/* ------------------------------------------------------------------ */

const glowOrb = defineAsset(
  {
    id: 'glow-orb',
    name: 'Glow Orb',
    category: 'Light & Glow',
    tags: ['glow', 'orb', 'light', 'magic', 'energy', 'sticker', 'sparkle'],
    sizing: { width: 640, height: 640 },
    defaultBlendMode: 'screen',
    params: [
      P.color('color', 'Glow color', '#8b7cf6'),
      P.color('core', 'Core color', '#ffffff'),
      P.pct('intensity', 'Intensity', 0.8),
      P.pct('coreSize', 'Core size', 0.25),
      P.num('rays', 'Sparkle rays', 0, 12, 4),
      P.pct('rings', 'Energy ring', 0.3),
      P.seed(79),
    ],
    generate(p, { width: W, height: H }) {
      const r = makeRand(num(p, 'seed', 79));
      const color = str(p, 'color', '#8b7cf6');
      const core = str(p, 'core', '#ffffff');
      const k = num(p, 'intensity', 0.8);
      const cs = num(p, 'coreSize', 0.25);
      const cx = W / 2;
      const cy = H / 2;
      const R = Math.min(W, H) / 2;
      const [c, ctx] = newCanvas(W, H);
      ctx.globalCompositeOperation = 'lighter';
      // outer glow: exponential falloff
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        g.addColorStop(t, rgba(color, Math.exp(-t * 4.2) * (1 - t) * k));
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      // core
      const cr = R * (0.1 + cs * 0.5);
      const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
      g2.addColorStop(0, rgba(core, Math.min(1, k * 1.2)));
      g2.addColorStop(0.55, rgba(core, 0.8 * k));
      g2.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, W, H);
      const rings = num(p, 'rings', 0.3);
      if (rings > 0) {
        ctx.lineWidth = Math.max(1, R * 0.012);
        for (let i = 0; i < 2; i++) {
          const rr = cr * (1.5 + i * 0.6 + r() * 0.2);
          ctx.strokeStyle = rgba(color, 0.35 * rings * k);
          ctx.setLineDash([R * 0.1 * r() + R * 0.04, R * 0.05]);
          ctx.beginPath();
          ctx.arc(cx, cy, rr, r() * TAU, r() * TAU + TAU);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      const rays = Math.round(num(p, 'rays', 4));
      const sprite = tintSprite(softSprite(64, 0), core, 'orb');
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * Math.PI + (rays % 2 ? 0 : Math.PI / (rays * 2)) * 0;
        const len = R * (i % 2 ? 0.6 : 0.95);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a);
        ctx.globalAlpha = 0.75 * k;
        ctx.drawImage(sprite, -len, -R * 0.018, len * 2, R * 0.036);
        ctx.restore();
      }
      // tiny satellites
      const sp = tintSprite(softSprite(32, 0.4), core, 'orb-s');
      for (let i = 0; i < 10; i++) {
        const a = r() * TAU;
        const d = R * (0.35 + r() * 0.5);
        const s = R * (0.01 + r() * 0.03);
        ctx.globalAlpha = (0.3 + r() * 0.6) * k;
        ctx.drawImage(sp, cx + Math.cos(a) * d - s, cy + Math.sin(a) * d - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;
      return c;
    },
  },
  { bg: 'dark' },
);

export const lightAssets: AssetDef[] = [sunburstRays, lightRays, lensFlare, bokeh, glowOrb];
