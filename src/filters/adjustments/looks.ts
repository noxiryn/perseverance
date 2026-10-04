/**
 * Parametric "Color Lookup" looks. Each look is a pure function RGB (0..1) → RGB (0..1) that is
 * sampled once into a 33³ cube (cached), then applied with trilinear interpolation.
 * No external LUT files: everything is procedural and works offline.
 */
import { build3DLut, clamp01, gradientLutFloat, hslToRgbInto, rgbOf, rgbToHslInto, sCurve } from './math';

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

export const LUT_SIZE = 33;

type Vec = Float64Array; // [r, g, b] in 0..1

const L = (c: Vec) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function saturate(c: Vec, f: number) {
  const l = L(c);
  for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * f;
}

function contrast(c: Vec, k: number) {
  for (let i = 0; i < 3; i++) c[i] = sCurve(clamp01(c[i]), k);
}

/** ASC-CDL style slope / offset / power per channel. */
function cdl(c: Vec, slope: number[], offset: number[], power: number[]) {
  for (let i = 0; i < 3; i++) c[i] = Math.pow(Math.max(0, c[i] * slope[i] + offset[i]), power[i]);
}

/** Adds the chroma of the given colors in shadows / highlights (luma-neutral). */
function splitTone(c: Vec, shadow: string | null, sAmt: number, highlight: string | null, hAmt: number) {
  const l = clamp01(L(c));
  if (shadow) {
    const [r, g, b] = rgbOf(shadow).map((v) => v / 255);
    const lt = 0.299 * r + 0.587 * g + 0.114 * b;
    const w = (1 - smooth(0.05, 0.65, l)) * Math.min(1, l * 8) * sAmt;
    c[0] += (r - lt) * w;
    c[1] += (g - lt) * w;
    c[2] += (b - lt) * w;
  }
  if (highlight) {
    const [r, g, b] = rgbOf(highlight).map((v) => v / 255);
    const lt = 0.299 * r + 0.587 * g + 0.114 * b;
    const w = smooth(0.35, 0.95, l) * Math.min(1, (1 - l) * 8) * hAmt;
    c[0] += (r - lt) * w;
    c[1] += (g - lt) * w;
    c[2] += (b - lt) * w;
  }
}

function clampVec(c: Vec) {
  for (let i = 0; i < 3; i++) c[i] = clamp01(c[i]);
}

const hsl = new Float64Array(3);
const tmp = new Float64Array(3);

/** Move hue toward `target` by `amount` (0..1) and scale saturation, inside a hue window. */
function pullHue(c: Vec, center: number, width: number, target: number, amount: number, satMul: number) {
  rgbToHslInto(c[0] * 255, c[1] * 255, c[2] * 255, hsl);
  if (hsl[1] < 0.02) return;
  let dh = hsl[0] - center;
  dh = ((dh + 540) % 360) - 180;
  const w = 1 - smooth(width * 0.5, width, Math.abs(dh));
  if (w <= 0) return;
  let dt = target - hsl[0];
  dt = ((dt + 540) % 360) - 180;
  const h = hsl[0] + dt * amount * w;
  const s = clamp01(hsl[1] * (1 + (satMul - 1) * w));
  hslToRgbInto(h, s, hsl[2], tmp);
  c[0] = tmp[0] / 255;
  c[1] = tmp[1] / 255;
  c[2] = tmp[2] / 255;
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
    pullHue(c, 30, 70, 28, 0.35, 1.25); // skin / warm → orange, richer
    pullHue(c, 190, 130, 188, 0.5, 0.95); // cool & green → teal
    contrast(c, 1.2);
    splitTone(c, '#0b5c66', 0.45, '#ffad6b', 0.2);
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
    cdl(c, [0.9, 0.98, 1.08], [-0.02, 0, 0.035], [1.05, 1, 0.95]);
    contrast(c, 1.2);
    splitTone(c, '#10243f', 0.35, '#dfeaff', 0.15);
  },
  golden(c) {
    cdl(c, [1.1, 1, 0.8], [0.02, 0.01, -0.02], [0.95, 1, 1.12]);
    saturate(c, 1.1);
    splitTone(c, '#4a2a0a', 0.3, '#ffd27a', 0.35);
    contrast(c, 1.1);
  },
  'faded-film'(c) {
    contrast(c, 1.15);
    c[0] = 0.07 + c[0] * 0.86;
    c[1] = 0.08 + c[1] * 0.84;
    c[2] = 0.1 + c[2] * 0.8;
    saturate(c, 0.78);
    splitTone(c, '#2f5a52', 0.3, '#f5d9a8', 0.25);
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
