/**
 * Distort filters (inverse-mapped with premultiplied bilinear sampling): wave, twirl, pinch,
 * spherize, ripple, displace (noise), polar coordinates, shear.
 *
 * Geometry is relative to the filtered image box (like Photoshop, which distorts within the
 * layer/selection bounds); lengths (wavelength, amplitude…) are document px × ctx.scale and
 * periodic patterns are anchored to the document.
 */
import { AudioWaveform, CircleDashed, Globe, MoveDiagonal, Radar, Shrink, Tornado, Waves } from 'lucide-react';
import { createNoise2D } from '../../../core/noise';
import type { FilterDef } from '../../../registry';
import type { Edge, Img } from '../util';
import { anchor, autoEdge, clamp, coarseField, isEmpty, num, pt, remap, str } from '../util';
import { angleP, numP, pctP, pointP, pxP, seedP, selectP } from '../params';

const EDGE_OPTIONS: [string, string][] = [
  ['auto', 'Auto'],
  ['transparent', 'Transparent'],
  ['wrap', 'Wrap around'],
  ['clamp', 'Repeat edge pixels'],
];

function edgeOf(img: Img, v: unknown): Edge {
  const e = str(v, 'auto');
  return e === 'transparent' || e === 'wrap' || e === 'clamp' ? e : autoEdge(img);
}

/** Center (index space) and reference radius (half of the smaller side) for centered distortions. */
function frame(img: Img, center: unknown) {
  const c = pt(center);
  return { cx: c.x * img.width - 0.5, cy: c.y * img.height - 0.5, R: Math.min(img.width, img.height) / 2 };
}

/* ------------------------------------------------------------------ */
/* Wave                                                                */
/* ------------------------------------------------------------------ */

function waveShape(kind: string, t: number): number {
  // t in cycles; returns -1..1
  const f = t - Math.floor(t);
  switch (kind) {
    case 'triangle':
      return f < 0.5 ? f * 4 - 1 : 3 - f * 4;
    case 'square': {
      // slightly softened square to avoid hard tearing
      const s = Math.sin(f * Math.PI * 2);
      return Math.max(-1, Math.min(1, s * 4));
    }
    default:
      return Math.sin(f * Math.PI * 2);
  }
}

export const wave: FilterDef = {
  id: 'wave',
  name: 'Wave',
  category: 'Distort',
  icon: AudioWaveform,
  description: 'Displaces rows/columns with a sine, triangle or square wave.',
  keywords: ['wavy', 'flag', 'water', 'warp', 'sine'],
  params: [
    selectP('type', 'Type', [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']], 'sine'),
    selectP('direction', 'Direction', [['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['both', 'Both']], 'horizontal'),
    pxP('wavelength', 'Wavelength', 2, 600, 120),
    pxP('amplitude', 'Amplitude', 0, 200, 20),
    angleP('phase', 'Phase', 0),
    selectP('edge', 'Edges', EDGE_OPTIONS, 'auto'),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { ax, ay, s } = anchor(ctx);
    const wl = Math.max(1, num(p.wavelength, 120) * s);
    const amp = num(p.amplitude, 20) * s;
    if (Math.abs(amp) < 0.05) return img;
    const kind = str(p.type, 'sine');
    const dir = str(p.direction, 'horizontal');
    const ph = num(p.phase, 0) / 360;
    const w = img.width;
    return remap(
      img,
      (sx, sy, y) => {
        const rowShift = dir !== 'vertical' ? waveShape(kind, (y + ay) / wl + ph) * amp : 0;
        for (let x = 0; x < w; x++) {
          sx[x] = x + rowShift;
          sy[x] = y + (dir !== 'horizontal' ? waveShape(kind, (x + ax) / wl + ph + 0.25) * amp : 0);
        }
      },
      edgeOf(img, p.edge),
    ) as ImageData;
  },
};

/* ------------------------------------------------------------------ */
/* Twirl                                                               */
/* ------------------------------------------------------------------ */

export const twirl: FilterDef = {
  id: 'twirl',
  name: 'Twirl',
  category: 'Distort',
  icon: Tornado,
  description: 'Rotates the image around a center, more strongly toward the middle.',
  keywords: ['swirl', 'spiral', 'vortex', 'whirlpool'],
  params: [numP('angle', 'Angle', -720, 720, 120, { unit: '°', step: 1 }), pctP('radius', 'Radius', 1, {}, 0.05, 2), pointP('center', 'Center', { x: 0.5, y: 0.5 })],
  apply(img, p) {
    if (isEmpty(img)) return img;
    const { cx, cy, R } = frame(img, p.center);
    const rad = Math.max(1, R * clamp(num(p.radius, 1), 0.05, 2));
    const ang = (num(p.angle, 120) * Math.PI) / 180;
    if (Math.abs(ang) < 1e-3) return img;
    const w = img.width;
    return remap(img, (sx, sy, y) => {
      const dy = y - cy;
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= rad) {
          sx[x] = x;
          sy[x] = y;
          continue;
        }
        const t = 1 - d / rad;
        const a = ang * t * t;
        const c = Math.cos(a),
          sn = Math.sin(a);
        sx[x] = cx + dx * c - dy * sn;
        sy[x] = cy + dx * sn + dy * c;
      }
    }) as ImageData;
  },
};

/* ------------------------------------------------------------------ */
/* Pinch / spherize                                                    */
/* ------------------------------------------------------------------ */

export const pinch: FilterDef = {
  id: 'pinch',
  name: 'Pinch',
  category: 'Distort',
  icon: Shrink,
  description: 'Squeezes toward the center (positive) or bulges outward (negative).',
  keywords: ['squeeze', 'bulge', 'punch', 'bloat'],
  params: [numP('amount', 'Amount', -100, 100, 50, { unit: '%', step: 1 }), pctP('radius', 'Radius', 1, {}, 0.05, 2), pointP('center', 'Center', { x: 0.5, y: 0.5 })],
  apply(img, p) {
    if (isEmpty(img)) return img;
    const amt = clamp(num(p.amount, 50), -100, 100) / 100;
    if (Math.abs(amt) < 1e-3) return img;
    const { cx, cy, R } = frame(img, p.center);
    const rad = Math.max(1, R * clamp(num(p.radius, 1), 0.05, 2));
    const w = img.width;
    return remap(img, (sx, sy, y) => {
      const dy = y - cy;
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= rad || d < 1e-6) {
          sx[x] = x;
          sy[x] = y;
          continue;
        }
        const r = d / rad;
        // GIMP-style pinch: factor > 1 samples farther out (content pulled in), < 1 bulges.
        // Never sample beyond the effect radius so the border stays continuous.
        const scale = Math.min(1 / r, Math.pow(Math.sin((Math.PI / 2) * r), -amt * 0.95));
        sx[x] = cx + dx * scale;
        sy[x] = cy + dy * scale;
      }
    }) as ImageData;
  },
};

export const spherize: FilterDef = {
  id: 'spherize',
  name: 'Spherize',
  category: 'Distort',
  icon: Globe,
  description: 'Wraps the image around a sphere (or cylinder) — fisheye bulge or inward dent.',
  keywords: ['fisheye', 'bulge', 'sphere', 'lens', 'globe'],
  params: [
    numP('amount', 'Amount', -100, 100, 60, { unit: '%', step: 1 }),
    selectP('mode', 'Mode', [['normal', 'Normal'], ['horizontal', 'Horizontal only'], ['vertical', 'Vertical only']], 'normal'),
    pctP('radius', 'Radius', 1, {}, 0.05, 2),
    pointP('center', 'Center', { x: 0.5, y: 0.5 }),
  ],
  apply(img, p) {
    if (isEmpty(img)) return img;
    const amt = clamp(num(p.amount, 60), -100, 100) / 100;
    if (Math.abs(amt) < 1e-3) return img;
    const mode = str(p.mode, 'normal');
    const c = pt(p.center);
    const cx = c.x * img.width - 0.5,
      cy = c.y * img.height - 0.5;
    const k = clamp(num(p.radius, 1), 0.05, 2);
    // elliptical sphere fitted to the box (like Photoshop)
    const rx = Math.max(1, (img.width / 2) * k),
      ry = Math.max(1, (img.height / 2) * k);
    const w = img.width;
    return remap(img, (sx, sy, y) => {
      const v = mode === 'horizontal' ? 0 : (y - cy) / ry;
      for (let x = 0; x < w; x++) {
        const u = mode === 'vertical' ? 0 : (x - cx) / rx;
        const r = Math.sqrt(u * u + v * v);
        if (r >= 1 || r < 1e-6) {
          sx[x] = x;
          sy[x] = y;
          continue;
        }
        // sphere mapping: output radius r ↔ source radius asin(r)/(π/2) (bulge) blended by amount
        const sphere = amt > 0 ? Math.asin(r) / (Math.PI / 2) : Math.sin((r * Math.PI) / 2);
        const a = Math.abs(amt);
        const rs = r + (sphere - r) * a;
        const f = rs / r;
        sx[x] = mode === 'vertical' ? x : cx + (x - cx) * f;
        sy[x] = mode === 'horizontal' ? y : cy + (y - cy) * f;
      }
    }) as ImageData;
  },
};

/* ------------------------------------------------------------------ */
/* Ripple                                                              */
/* ------------------------------------------------------------------ */

export const ripple: FilterDef = {
  id: 'ripple',
  name: 'Ripple',
  category: 'Distort',
  icon: Waves,
  description: 'Concentric water ripples spreading from a center point.',
  keywords: ['water', 'drop', 'pond', 'rings', 'zigzag'],
  params: [
    pxP('amplitude', 'Amplitude', 0, 100, 8),
    pxP('wavelength', 'Wavelength', 2, 300, 40),
    pctP('damping', 'Damping', 0.4),
    angleP('phase', 'Phase', 0),
    pointP('center', 'Center', { x: 0.5, y: 0.5 }),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const s = ctx.scale > 0 ? ctx.scale : 1;
    const amp = num(p.amplitude, 8) * s;
    if (Math.abs(amp) < 0.05) return img;
    const wl = Math.max(1, num(p.wavelength, 40) * s);
    const damp = clamp(num(p.damping, 0.4), 0, 1);
    const ph = (num(p.phase, 0) * Math.PI) / 180;
    const { cx, cy } = frame(img, p.center);
    const maxR = Math.hypot(Math.max(cx, img.width - cx), Math.max(cy, img.height - cy));
    const w = img.width;
    return remap(img, (sx, sy, y) => {
      const dy = y - cy;
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1e-6) {
          sx[x] = x;
          sy[x] = y;
          continue;
        }
        const fall = Math.exp(-damp * 3 * (d / maxR));
        const disp = Math.sin((d / wl) * Math.PI * 2 - ph) * amp * fall * Math.min(1, d / wl);
        const f = (d + disp) / d;
        sx[x] = cx + dx * f;
        sy[x] = cy + dy * f;
      }
    }) as ImageData;
  },
};

/* ------------------------------------------------------------------ */
/* Displace (noise)                                                    */
/* ------------------------------------------------------------------ */

const noiseCache = new Map<number, (x: number, y: number) => number>();
function simplex(seed: number) {
  let f = noiseCache.get(seed);
  if (!f) {
    f = createNoise2D(seed);
    if (noiseCache.size > 16) noiseCache.clear();
    noiseCache.set(seed, f);
  }
  return f;
}

export const displaceNoise: FilterDef = {
  id: 'displace-noise',
  name: 'Displace (Noise)',
  category: 'Distort',
  icon: CircleDashed,
  description: 'Organic warping with fractal noise — heat haze, liquid, melted looks.',
  keywords: ['warp', 'liquify', 'heat', 'haze', 'turbulence', 'displacement'],
  params: [
    pxP('amount', 'Amount', 0, 200, 20),
    pxP('scale', 'Scale', 2, 600, 80),
    numP('detail', 'Detail', 1, 6, 3, { step: 1 }),
    selectP('edge', 'Edges', EDGE_OPTIONS, 'auto'),
    seedP(1),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const { ax, ay, s } = anchor(ctx);
    const amt = num(p.amount, 20) * s;
    if (Math.abs(amt) < 0.05) return img;
    const scale = Math.max(1, num(p.scale, 80) * s);
    const oct = clamp(Math.round(num(p.detail, 3)), 1, 6);
    const seed = num(p.seed, 1) | 0;
    const nx = simplex(seed),
      ny = simplex(seed + 7919);
    const w = img.width;
    const fbm = (f: (x: number, y: number) => number, x: number, y: number) => {
      let sum = 0,
        amp = 1,
        norm = 0,
        fr = 1;
      for (let o = 0; o < oct; o++) {
        sum += f(x * fr + o * 13.7, y * fr - o * 7.3) * amp;
        norm += amp;
        amp *= 0.5;
        fr *= 2.03;
      }
      return sum / norm;
    };
    // the displacement is smooth: evaluate it on a grid fine enough for the finest octave
    const step = clamp(Math.floor(scale / Math.pow(2, oct + 1)), 1, 8);
    const fx = coarseField(w, img.height, step, (x, y) => fbm(nx, (x + ax) / scale, (y + ay) / scale) * amt);
    const fy = coarseField(w, img.height, step, (x, y) => fbm(ny, (x + ax) / scale, (y + ay) / scale) * amt);
    return remap(
      img,
      (sx, sy, y) => {
        const o = y * w;
        for (let x = 0; x < w; x++) {
          sx[x] = x + fx[o + x];
          sy[x] = y + fy[o + x];
        }
      },
      edgeOf(img, p.edge),
    ) as ImageData;
  },
};

/* ------------------------------------------------------------------ */
/* Polar coordinates                                                   */
/* ------------------------------------------------------------------ */

export const polarCoordinates: FilterDef = {
  id: 'polar-coordinates',
  name: 'Polar Coordinates',
  category: 'Distort',
  icon: Radar,
  description: 'Rectangular → polar (tiny planet / circular bands) or polar → rectangular.',
  keywords: ['tiny planet', 'circular', 'radial', 'unwrap', 'swirl'],
  params: [
    selectP('mode', 'Mode', [['rect-to-polar', 'Rectangular to polar'], ['polar-to-rect', 'Polar to rectangular']], 'rect-to-polar'),
    angleP('rotation', 'Rotation', 0),
  ],
  apply(img, p) {
    if (isEmpty(img)) return img;
    const { width: w, height: h } = img;
    const cx = w / 2,
      cy = h / 2;
    const rot = (num(p.rotation, 0) * Math.PI) / 180;
    const toPolar = str(p.mode, 'rect-to-polar') !== 'polar-to-rect';
    const rmax = Math.min(w, h) / 2;
    const rcorner = Math.hypot(cx, cy);
    return remap(
      img,
      (sx, sy, y) => {
        for (let x = 0; x < w; x++) {
          const px = x + 0.5,
            py = y + 0.5;
          if (toPolar) {
            // output pixel at angle θ / radius r samples source column ∝ θ, row ∝ r (top = center)
            const dx = px - cx,
              dy = py - cy;
            let th = Math.atan2(dx, -dy) - rot; // 0 at top, clockwise
            th = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            const r = Math.sqrt(dx * dx + dy * dy) / rmax;
            sx[x] = (th / (Math.PI * 2)) * w - 0.5;
            sy[x] = r * h - 0.5;
          } else {
            const th = (px / w) * Math.PI * 2 + rot;
            const r = (py / h) * rcorner;
            sx[x] = cx + Math.sin(th) * r - 0.5;
            sy[x] = cy - Math.cos(th) * r - 0.5;
          }
        }
      },
      toPolar ? 'wrap' : autoEdge(img),
    ) as ImageData;
  },
};

/* ------------------------------------------------------------------ */
/* Shear                                                               */
/* ------------------------------------------------------------------ */

export const shear: FilterDef = {
  id: 'shear',
  name: 'Shear',
  category: 'Distort',
  icon: MoveDiagonal,
  description: 'Leans or bends the image sideways along a smooth curve.',
  keywords: ['skew', 'bend', 'lean', 'slant', 'italic'],
  params: [
    pxP('amount', 'Amount', -400, 400, 60, { step: 1 }),
    pctP('curve', 'Bend', 0.6),
    selectP('direction', 'Direction', [['horizontal', 'Horizontal'], ['vertical', 'Vertical']], 'horizontal'),
    selectP('edge', 'Edges', EDGE_OPTIONS, 'auto'),
  ],
  apply(img, p, ctx) {
    if (isEmpty(img)) return img;
    const s = ctx.scale > 0 ? ctx.scale : 1;
    const amt = num(p.amount, 60) * s;
    if (Math.abs(amt) < 0.05) return img;
    const bend = clamp(num(p.curve, 0.6), 0, 1);
    const vertical = str(p.direction, 'horizontal') === 'vertical';
    const { width: w, height: h } = img;
    // offset(t), t ∈ [0,1] along the other axis: blend of a linear lean and a sine bend
    const off = (t: number) => {
      const lean = (t - 0.5) * 2;
      const curve = Math.sin(t * Math.PI);
      return (lean * (1 - bend) + curve * bend) * amt;
    };
    if (!vertical) {
      return remap(
        img,
        (sx, sy, y) => {
          const o = off((y + 0.5) / h);
          for (let x = 0; x < w; x++) {
            sx[x] = x - o;
            sy[x] = y;
          }
        },
        edgeOf(img, p.edge),
      ) as ImageData;
    }
    const cols = new Float32Array(w);
    for (let x = 0; x < w; x++) cols[x] = off((x + 0.5) / w);
    return remap(
      img,
      (sx, sy, y) => {
        for (let x = 0; x < w; x++) {
          sx[x] = x;
          sy[x] = y - cols[x];
        }
      },
      edgeOf(img, p.edge),
    ) as ImageData;
  },
};

export const distortFilters: FilterDef[] = [wave, twirl, pinch, spherize, ripple, displaceNoise, polarCoordinates, shear];
