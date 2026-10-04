/**
 * Procedural brush tip generators (deterministic, via core/noise). Each returns an n×n canvas
 * painted white with alpha = paint coverage. Noise is sampled in normalized tip coordinates so
 * a tip looks the same at every cached size.
 */
import { createCanvas, ctx2d, ctxRead } from '../../../core/canvas';
import { createNoise2D, fbm, hash2, rng } from '../../../core/noise';

type Noise = (x: number, y: number) => number;

const noises = new Map<number, Noise>();
function noise(seed: number): Noise {
  let n = noises.get(seed);
  if (!n) {
    n = createNoise2D(seed);
    noises.set(seed, n);
  }
  return n;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smooth(e0: number, e1: number, x: number) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
const frac = (x: number) => x - Math.floor(x);

/** Rasterize a scalar field over normalized coords u,v ∈ [-1,1] (r = radius). */
function field(n: number, f: (u: number, v: number, r: number, x: number, y: number) => number): HTMLCanvasElement {
  const c = createCanvas(n, n);
  const ctx = ctxRead(c);
  const img = ctx.createImageData(n, n);
  const d = img.data;
  for (let y = 0; y < n; y++) {
    const v = ((y + 0.5) / n) * 2 - 1;
    for (let x = 0; x < n; x++) {
      const u = ((x + 0.5) / n) * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      const val = r > 1.42 ? 0 : clamp01(f(u, v, r, x, y));
      const i = (y * n + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(val * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function chalkTip(n: number) {
  const n1 = noise(11),
    n2 = noise(12);
  return field(n, (u, v, r, x, y) => {
    const edge = r + fbm(n1, u * 2.2, v * 2.2, 3) * 0.22;
    const shape = 1 - smooth(0.7, 0.95, edge);
    const g = smooth(-0.35, 0.25, fbm(n2, u * 9, v * 9, 2));
    return shape * (0.2 + 0.8 * g) * (0.85 + 0.15 * hash2(x, y, 3));
  });
}

export function charcoalTip(n: number) {
  const n1 = noise(21),
    n2 = noise(22);
  return field(n, (u, v, r) => {
    const shape = 1 - smooth(0.55, 1, r + fbm(n1, u * 2, v * 2, 3) * 0.25);
    const streak = n2(u * 1.2, v * 16) * 0.75 + fbm(n1, u * 7, v * 7, 2) * 0.45;
    return shape * smooth(-0.55, 0.55, streak);
  });
}

export function grungeTip1(n: number) {
  const n1 = noise(31),
    n2 = noise(32);
  return field(n, (u, v, r, x, y) => {
    const e = r + fbm(n1, u * 1.8, v * 1.8, 4) * 0.55;
    const shape = 1 - smooth(0.52, 0.66, e);
    const holes = smooth(-0.3, 0.05, fbm(n2, u * 5, v * 5, 3));
    const speck = r < 0.97 && hash2(x, y, 9) > 0.988 ? 0.8 : 0;
    return Math.max(shape * holes, speck);
  });
}

export function grungeTip2(n: number) {
  const n1 = noise(41),
    n2 = noise(42);
  return field(n, (u, v) => {
    const e = Math.max(Math.abs(u), Math.abs(v)) * 0.88 + fbm(n1, u * 2.4, v * 2.4, 4) * 0.4;
    const shape = 1 - smooth(0.58, 0.72, e);
    const tex = smooth(-0.12, 0.32, fbm(n2, u * 8, v * 8, 4));
    return shape * tex;
  });
}

export function splatterTip(n: number) {
  const c = createCanvas(n, n);
  const ctx = ctx2d(c);
  const rand = rng(51);
  const n1 = noise(52);
  const cx = n / 2;
  ctx.fillStyle = '#fff';
  // Main blob with a noisy rim.
  ctx.beginPath();
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const rr = n * (0.2 + 0.06 * n1(Math.cos(a) * 1.5, Math.sin(a) * 1.5) + 0.03 * n1(Math.cos(a) * 5, Math.sin(a) * 5));
    const x = cx + Math.cos(a) * rr,
      y = cx + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.fill();
  // Droplets and streaks flung outwards.
  for (let i = 0; i < 34; i++) {
    const a = rand() * Math.PI * 2;
    const dist = (0.24 + rand() * 0.24) * n;
    const rad = n * (0.006 + rand() * 0.035) * (1.25 - dist / (n * 0.5));
    const x = cx + Math.cos(a) * dist,
      y = cx + Math.sin(a) * dist;
    ctx.beginPath();
    if (rand() < 0.35) ctx.ellipse(x, y, rad * 2.6, rad * 0.8, a, 0, Math.PI * 2);
    else ctx.arc(x, y, Math.max(0.6, rad), 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

export function sprayTip(n: number) {
  const c = createCanvas(n, n);
  const ctx = ctx2d(c);
  const rand = rng(61);
  const count = Math.min(24000, Math.round(n * n * 0.05));
  const dot = Math.max(1, n / 140);
  ctx.fillStyle = '#fff';
  for (let i = 0; i < count; i++) {
    // Box-Muller gaussian distribution, clipped to the tip.
    const r = Math.sqrt(-2 * Math.log(rand() + 1e-9)) * 0.32;
    if (r > 0.98) continue;
    const a = rand() * Math.PI * 2;
    ctx.globalAlpha = 0.35 + rand() * 0.65;
    ctx.fillRect(n / 2 + Math.cos(a) * r * (n / 2), n / 2 + Math.sin(a) * r * (n / 2), dot, dot);
  }
  return c;
}

export function dryBrushTip(n: number) {
  const n1 = noise(71),
    n2 = noise(72);
  return field(n, (u, v) => {
    const taper = 1 - smooth(0.55, 1, Math.abs(u));
    const sides = 1 - smooth(0.8, 1, Math.abs(v));
    const bristle = smooth(-0.15, 0.45, n1(0.37, v * 11) + n1(1.7, v * 27) * 0.4);
    const streak = 0.75 + 0.25 * n2(u * 2, v * 45);
    return taper * sides * bristle * streak;
  });
}

export function smokeTip(n: number) {
  const n1 = noise(81),
    n2 = noise(82);
  return field(n, (u, v, r) => {
    const wisp = fbm(n1, u * 1.6 + 3, v * 1.6, 5) + 0.35 * (1 - r) + 0.15 * n2(u * 4, v * 4);
    return smooth(-0.15, 0.85, wisp) * (1 - smooth(0.35, 1, r)) * 0.95;
  });
}

export function sparkleTip(n: number) {
  return field(n, (u, v, r) => {
    const core = Math.exp(-((r / 0.11) ** 2));
    const rayH = Math.exp(-Math.abs(v) / 0.022) * (1 - Math.abs(u)) ** 2.2;
    const rayV = Math.exp(-Math.abs(u) / 0.022) * (1 - Math.abs(v)) ** 2.2;
    const p = (u + v) / Math.SQRT2,
      q = (u - v) / Math.SQRT2;
    const dl = Math.max(0, 1 - Math.abs(p) * 1.6),
      dr = Math.max(0, 1 - Math.abs(q) * 1.6);
    const rayD = (Math.exp(-Math.abs(q) / 0.018) * dl ** 2 + Math.exp(-Math.abs(p) / 0.018) * dr ** 2) * 0.45;
    const halo = 0.3 * Math.exp(-((r / 0.32) ** 2));
    return core + rayH + rayV + rayD + halo;
  });
}

export function halftoneTip(n: number) {
  const cells = 6;
  return field(n, (u, v, r) => {
    const cu = ((u + 1) / 2) * cells,
      cv = ((v + 1) / 2) * cells;
    const fu = frac(cu) - 0.5,
      fv = frac(cv) - 0.5;
    const d = Math.sqrt(fu * fu + fv * fv);
    // Dots shrink towards the edge → a soft halftone falloff.
    const ccx = (Math.floor(cu) + 0.5) / cells * 2 - 1,
      ccy = (Math.floor(cv) + 0.5) / cells * 2 - 1;
    const cr = Math.sqrt(ccx * ccx + ccy * ccy);
    const dotR = 0.46 * Math.max(0, 1 - cr ** 1.6);
    const aa = 0.5 / (n / cells);
    return (1 - smooth(dotR - aa, dotR + aa, d)) * (1 - smooth(0.95, 1.05, r));
  });
}

export function squareTip(n: number) {
  const aa = 1 / n;
  return field(n, (u, v) => 1 - smooth(1 - aa * 2.5, 1, Math.max(Math.abs(u), Math.abs(v))));
}

export function hairStrandsTip(n: number) {
  const rand = rng(91);
  const strands: { v: number; r: number; a: number }[] = [];
  const count = 15;
  for (let k = 0; k < count; k++) {
    strands.push({
      v: -0.88 + (1.76 * k) / (count - 1) + (rand() - 0.5) * 0.06,
      r: 0.03 + rand() * 0.045,
      a: 0.45 + rand() * 0.55,
    });
  }
  return field(n, (u, v) => {
    let val = 0;
    const aa = 1.2 / n;
    for (const s of strands) {
      const d = Math.sqrt(u * u + (v - s.v) * (v - s.v));
      const c = s.a * (1 - smooth(s.r - aa, s.r + aa, d));
      if (c > val) val = c;
    }
    return val;
  });
}

export function crossHatchTip(n: number) {
  const n1 = noise(101),
    n2 = noise(102);
  const k = 5;
  const line = (t: number, w: number) => 1 - smooth(w, w + 0.06, Math.abs(frac(t) - 0.5));
  return field(n, (u, v, r) => {
    const shape = 1 - smooth(0.7, 0.95, r + fbm(n1, u * 2, v * 2, 3) * 0.2);
    const p = ((u + v) / Math.SQRT2) * k + n2(u * 3, v * 3) * 0.08;
    const q = ((u - v) / Math.SQRT2) * k + n2(v * 3, u * 3) * 0.08;
    const lines = Math.max(line(p, 0.07), line(q, 0.06) * 0.85);
    return shape * lines * (0.7 + 0.3 * smooth(-0.5, 0.5, n2(u * 10, v * 10)));
  });
}

export function scratchesTip(n: number) {
  const c = createCanvas(n, n);
  const ctx = ctx2d(c);
  const rand = rng(111);
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  const s = n / 128;
  for (let i = 0; i < 9; i++) {
    const a = (rand() - 0.5) * 0.7;
    const len = n * (0.35 + rand() * 0.6);
    const cx = n / 2 + (rand() - 0.5) * n * 0.6;
    const cy = n / 2 + (rand() - 0.5) * n * 0.6;
    const dx = (Math.cos(a) * len) / 2,
      dy = (Math.sin(a) * len) / 2;
    ctx.globalAlpha = 0.35 + rand() * 0.65;
    ctx.lineWidth = Math.max(0.6, (0.5 + rand() * 1.8) * s);
    ctx.beginPath();
    ctx.moveTo(cx - dx, cy - dy);
    ctx.quadraticCurveTo(cx + (rand() - 0.5) * n * 0.1, cy + (rand() - 0.5) * n * 0.1, cx + dx, cy + dy);
    ctx.stroke();
  }
  // Fade the ends so scratches don't look stamped.
  const g = ctx.createRadialGradient(n / 2, n / 2, n * 0.2, n / 2, n / 2, n * 0.5);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, n, n);
  return c;
}

export function roughInkTip(n: number) {
  const n1 = noise(121),
    n2 = noise(122);
  return field(n, (u, v, r) => {
    const th = Math.atan2(v, u);
    const cx = Math.cos(th),
      sy = Math.sin(th);
    const rr = 0.84 + 0.08 * n1(cx * 2.5, sy * 2.5) + 0.04 * n2(cx * 9, sy * 9);
    const aa = 2.5 / n;
    return 1 - smooth(rr - aa, rr, r);
  });
}

export function watercolorTip(n: number) {
  const n1 = noise(131),
    n2 = noise(132);
  return field(n, (u, v, r) => {
    const e = r + fbm(n1, u * 2, v * 2, 4) * 0.3;
    const inside = 1 - smooth(0.68, 0.74, e);
    const rim = smooth(0.3, 0.72, e);
    const gran = 0.82 + 0.18 * fbm(n2, u * 12, v * 12, 2);
    return inside * (0.28 + 0.72 * rim) * gran * 0.9;
  });
}

export function glowDotTip(n: number) {
  return field(n, (_u, _v, r) => Math.max(Math.exp(-((r / 0.2) ** 2)), 0.6 * Math.exp(-((r / 0.52) ** 2))) * (1 - smooth(0.85, 1, r)));
}

export function markerTip(n: number) {
  const n1 = noise(141);
  return field(n, (u, v) => {
    const d = (Math.abs(u) / 0.95) ** 6 + (Math.abs(v) / 0.62) ** 6;
    const shape = 1 - smooth(0.65, 1, d);
    return shape * (0.82 + 0.18 * n1(u * 1.2, v * 26));
  });
}
