/**
 * Parametric "Color Lookup" looks. Each look is a pure function RGB (0..1) → RGB (0..1) that is
 * sampled once into a LUT_SIZE³ cube (cached), then applied with tetrahedral interpolation.
 * No external LUT files: everything is procedural and works offline.
 *
 * Performance: a cube is built on first use, on the main thread, so the per-sample code is kept
 * allocation-free — colors are parsed once at module load, hue pulls run in a single HSL pass,
 * constant vectors are hoisted. Swatches evaluate the look functions directly on their few
 * sample colors (`applyLookRgb`) instead of building cubes.
 */
import { build3DLut, clamp01, gradientLutFloat, rgbOf, sCurve } from './math';

export const LOOK_PRESETS: [string, string][] = [
  ['teal-orange', 'Teal & Orange'],
  ['bleach-bypass', 'Bleach Bypass'],
  ['crimson', 'Crimson'],
  ['cold-steel', 'Cold Steel'],
  ['golden', 'Golden'],
  ['faded-film', 'Faded Film'],
  ['cross-process', 'Cross Process'],
  ['noir', 'Noir'],
  ['toxic', 'Toxic'],
  ['royal', 'Royal'],
];

/**
 * Cube resolution. The looks are smooth functions, so 25³ samples with tetrahedral
 * interpolation stay within about one 8-bit level of 33³ and build 2.3× faster.
 */
export const LUT_SIZE = 25;

type Vec = Float64Array; // [r, g, b] in 0..1

const L = (c: Vec) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function saturate(c: Vec, f: number) {
  const l = L(c);
  c[0] = l + (c[0] - l) * f;
  c[1] = l + (c[1] - l) * f;
  c[2] = l + (c[2] - l) * f;
}

function contrast(c: Vec, k: number) {
  c[0] = sCurve(clamp01(c[0]), k);
  c[1] = sCurve(clamp01(c[1]), k);
  c[2] = sCurve(clamp01(c[2]), k);
}

/** ASC-CDL style slope / offset / power per channel (constant vectors, hoisted by the callers). */
function cdl(c: Vec, slope: Vec, offset: Vec, power: Vec) {
  c[0] = Math.pow(Math.max(0, c[0] * slope[0] + offset[0]), power[0]);
  c[1] = Math.pow(Math.max(0, c[1] * slope[1] + offset[1]), power[1]);
  c[2] = Math.pow(Math.max(0, c[2] * slope[2] + offset[2]), power[2]);
}
const v3 = (a: number, b: number, c: number): Vec => Float64Array.of(a, b, c);

/** Luma-neutral chroma of a color (r − luma, g − luma, b − luma in 0..1), parsed once. */
function chroma(hex: string): Vec {
  const [r, g, b] = rgbOf(hex);
  const lt = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return v3(r / 255 - lt, g / 255 - lt, b / 255 - lt);
}

/** Adds the chroma of the given colors in shadows / highlights (luma-neutral). */
function splitTone(c: Vec, shadow: Vec | null, sAmt: number, highlight: Vec | null, hAmt: number) {
  const l = clamp01(L(c));
  if (shadow) {
    const w = (1 - smooth(0.05, 0.65, l)) * Math.min(1, l * 8) * sAmt;
    c[0] += shadow[0] * w;
    c[1] += shadow[1] * w;
    c[2] += shadow[2] * w;
  }
  if (highlight) {
    const w = smooth(0.35, 0.95, l) * Math.min(1, (1 - l) * 8) * hAmt;
    c[0] += highlight[0] * w;
    c[1] += highlight[1] * w;
    c[2] += highlight[2] * w;
  }
}

function clampVec(c: Vec) {
  c[0] = clamp01(c[0]);
  c[1] = clamp01(c[1]);
  c[2] = clamp01(c[2]);
}

/** A hue pull: move hue toward `target` by `amount` (0..1) and scale saturation inside a window. */
interface HuePull {
  center: number;
  width: number;
  target: number;
  amount: number;
  satMul: number;
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/**
 * Apply hue pulls in one RGB → HSL → RGB round trip (pulls are evaluated sequentially in HSL,
 * which equals applying them one after another since the round trip is lossless).
 */
function pullHues(c: Vec, pulls: readonly HuePull[]) {
  const r = c[0],
    g = c[1],
    b = c[2];
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  if (max === min) return;
  const l = (max + min) / 2;
  const d = max - min;
  let s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  let changed = false;
  for (let i = 0; i < pulls.length; i++) {
    if (s < 0.02) break;
    const p = pulls[i];
    let dh = h - p.center;
    dh = ((dh + 540) % 360) - 180;
    const w = 1 - smooth(p.width * 0.5, p.width, Math.abs(dh));
    if (w <= 0) continue;
    let dt = p.target - h;
    dt = ((dt + 540) % 360) - 180;
    h = h + dt * p.amount * w;
    s = clamp01(s * (1 + (p.satMul - 1) * w));
    changed = true;
  }
  if (!changed) return;
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const pp = 2 * l - q;
  c[0] = hue2rgb(pp, q, hh + 1 / 3);
  c[1] = hue2rgb(pp, q, hh);
  c[2] = hue2rgb(pp, q, hh - 1 / 3);
}

function gradientSampler(stops: [number, string][]) {
  const lut = gradientLutFloat(
    stops.map(([offset, color]) => ({ offset, color })),
    false,
    256,
  );
  return (l: number, out: Vec) => {
    const k = Math.round(clamp01(l) * 255) * 4;
    out[0] = lut[k] / 255;
    out[1] = lut[k + 1] / 255;
    out[2] = lut[k + 2] / 255;
  };
}

/* ---------------- per-look constants (parsed once) ---------------- */

const TEAL_ORANGE_PULLS: readonly HuePull[] = [
  { center: 30, width: 70, target: 28, amount: 0.35, satMul: 1.25 }, // skin / warm → orange, richer
  { center: 190, width: 130, target: 188, amount: 0.5, satMul: 0.95 }, // cool & green → teal
];
const TO_SHADOW = chroma('#0b5c66');
const TO_HIGH = chroma('#ffad6b');
const STEEL_SLOPE = v3(0.9, 0.98, 1.08);
const STEEL_OFFSET = v3(-0.02, 0, 0.035);
const STEEL_POWER = v3(1.05, 1, 0.95);
const STEEL_SHADOW = chroma('#10243f');
const STEEL_HIGH = chroma('#dfeaff');
const GOLD_SLOPE = v3(1.1, 1, 0.8);
const GOLD_OFFSET = v3(0.02, 0.01, -0.02);
const GOLD_POWER = v3(0.95, 1, 1.12);
const GOLD_SHADOW = chroma('#4a2a0a');
const GOLD_HIGH = chroma('#ffd27a');
const FADED_SHADOW = chroma('#2f5a52');
const FADED_HIGH = chroma('#f5d9a8');

const toxicMap = gradientSampler([
  [0, '#020a03'],
  [0.3, '#0b3d10'],
  [0.66, '#36c22f'],
  [1, '#eaff86'],
]);
const royalMap = gradientSampler([
  [0, '#070212'],
  [0.3, '#2c0f57'],
  [0.66, '#9047d1'],
  [1, '#ffe6b8'],
]);
const mapped = new Float64Array(3);

const LOOK_FNS: Record<string, (c: Vec) => void> = {
  'teal-orange'(c) {
    pullHues(c, TEAL_ORANGE_PULLS);
    contrast(c, 1.2);
    splitTone(c, TO_SHADOW, 0.45, TO_HIGH, 0.2);
  },
  'bleach-bypass'(c) {
    const l = L(c);
    saturate(c, 0.4);
    for (let i = 0; i < 3; i++) {
      const v = c[i];
      const ov = v < 0.5 ? 2 * v * l : 1 - 2 * (1 - v) * (1 - l);
      c[i] = v + (ov - v) * 0.7;
    }
    contrast(c, 1.15);
    c[2] += 0.012;
  },
  crimson(c) {
    const redness = clamp01((c[0] - Math.max(c[1], c[2])) * 2.6);
    let l = clamp01((L(c) - 0.04) / 0.96);
    l = sCurve(l, 1.35);
    const m = 4 * l * (1 - l);
    const br = clamp01(l + 0.16 * m),
      bg = clamp01(l - 0.06 * m),
      bb = clamp01(l - 0.07 * m);
    const rr = clamp01(c[0] * 1.12 + 0.04),
      rg = c[1] * 0.32,
      rb = c[2] * 0.36;
    c[0] = br + (rr - br) * redness;
    c[1] = bg + (rg - bg) * redness;
    c[2] = bb + (rb - bb) * redness;
  },
  'cold-steel'(c) {
    saturate(c, 0.45);
    cdl(c, STEEL_SLOPE, STEEL_OFFSET, STEEL_POWER);
    contrast(c, 1.2);
    splitTone(c, STEEL_SHADOW, 0.35, STEEL_HIGH, 0.15);
  },
  golden(c) {
    cdl(c, GOLD_SLOPE, GOLD_OFFSET, GOLD_POWER);
    saturate(c, 1.1);
    splitTone(c, GOLD_SHADOW, 0.3, GOLD_HIGH, 0.35);
    contrast(c, 1.1);
  },
  'faded-film'(c) {
    contrast(c, 1.15);
    c[0] = 0.07 + c[0] * 0.86;
    c[1] = 0.08 + c[1] * 0.84;
    c[2] = 0.1 + c[2] * 0.8;
    saturate(c, 0.78);
    splitTone(c, FADED_SHADOW, 0.3, FADED_HIGH, 0.25);
  },
  'cross-process'(c) {
    const l = L(c);
    c[0] = sCurve(clamp01(c[0]), 1.5);
    c[1] = sCurve(clamp01(c[1]), 1.25);
    c[2] = 0.12 + c[2] * 0.72 - 0.06 * smooth(0.5, 1, l);
    saturate(c, 1.15);
  },
  noir(c) {
    let v = 0.45 * c[0] + 0.45 * c[1] + 0.1 * c[2];
    v = clamp01((v - 0.05) / 0.9);
    v = sCurve(v, 1.6);
    c[0] = v * 0.985;
    c[1] = v * 0.995;
    c[2] = Math.min(1, v * 1.02 + 0.005);
  },
  toxic(c) {
    const l = L(c);
    saturate(c, 0.3);
    toxicMap(sCurve(clamp01(l), 1.15), mapped);
    for (let i = 0; i < 3; i++) c[i] += (mapped[i] - c[i]) * 0.8;
  },
  royal(c) {
    const l = L(c);
    saturate(c, 0.4);
    royalMap(sCurve(clamp01(l), 1.1), mapped);
    for (let i = 0; i < 3; i++) c[i] += (mapped[i] - c[i]) * 0.72;
    saturate(c, 1.05);
  },
};

const cache = new Map<string, Float32Array>();

/** The cube for a look id (falls back to identity for unknown ids). Cached. */
export function lookCube(id: string): Float32Array {
  const hit = cache.get(id);
  if (hit) return hit;
  const fn = LOOK_FNS[id];
  const v = new Float64Array(3);
  const cube = build3DLut(LUT_SIZE, (r, g, b, out) => {
    v[0] = r;
    v[1] = g;
    v[2] = b;
    if (fn) {
      fn(v);
      clampVec(v);
    }
    out[0] = v[0];
    out[1] = v[1];
    out[2] = v[2];
  });
  cache.set(id, cube);
  return cube;
}

export function isKnownLook(id: string): boolean {
  return id in LOOK_FNS;
}

const one = new Float64Array(3);

/**
 * Exact look result for one color (0..255 in → 0..255 out in `out`), mixed with the original by
 * `intensity`. No cube is built: used for the small palette previews.
 */
export function applyLookRgb(id: string, r: number, g: number, b: number, intensity: number, out: Float64Array): void {
  const fn = LOOK_FNS[id];
  one[0] = r / 255;
  one[1] = g / 255;
  one[2] = b / 255;
  if (fn) {
    fn(one);
    clampVec(one);
  }
  const t = clamp01(intensity);
  out[0] = r + (one[0] * 255 - r) * t;
  out[1] = g + (one[1] * 255 - g) * t;
  out[2] = b + (one[2] * 255 - b) * t;
}

/**
 * Build the cube of a look during idle time so its first use doesn't stall an interaction
 * (e.g. the default Teal & Orange when a Color Lookup layer is added).
 */
export function prewarmLook(id: string): void {
  if (cache.has(id) || !isKnownLook(id) || typeof window === 'undefined') return;
  const run = () => lookCube(id);
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(run, { timeout: 4000 });
  else window.setTimeout(run, 1500);
}
