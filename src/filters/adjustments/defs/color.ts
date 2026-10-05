/**
 * Color adjustments: Vibrance, Hue/Saturation, Color Balance, Black & White, Photo Filter,
 * Channel Mixer, Selective Color.
 */
import { Camera, Gem, Palette, Pipette, Scale, Shuffle, SunMoon } from 'lucide-react';
import type { ParamDef, ParamValues } from '../../../core/types';
import type { FilterDef } from '../../../registry';
import { ALPHA_MASK, MEMO_SHIFT, applyLuts, clamp255, colorMemo, hslToRgbInto, luma, pixelWords, readWords, rgbOf, type Pixels } from '../math';
import { bool, boolP, colorP, num, numP, pctP, selectP, str } from '../params';

const scratch = new Float64Array(3);

/* ================================================================== */
/* Vibrance                                                            */
/* ================================================================== */

/**
 * Vibrance boosts muted colors more than already-saturated ones and protects skin tones; the
 * boost is capped so no channel clips (hue stays stable). Saturation is a uniform scale.
 */
export function vibrancePixels(img: Pixels, vibrance: number, saturation: number): Pixels {
  const vib = Math.max(-1, Math.min(1, vibrance / 100));
  const sat = Math.max(-1, Math.min(1, saturation / 100));
  if (vib === 0 && sat === 0) return img;
  const d = img.data;
  const live = pixelWords(img);
  const u = live ?? readWords(img);
  // results are read back from the live words into the color memo (none on the byte fallback)
  const memo = live ? colorMemo(`vib:${vib}:${sat}`) : null;
  const ck = memo ? memo.keys : NO_MEMO,
    cv = memo ? memo.vals : NO_MEMO;
  const { S, W, SK } = vibranceTables();
  const sat1 = 1 + sat;
  let prev = ~u[0];
  for (let q = 0, n = u.length; q < n; q++) {
    const p = u[q];
    const j = q << 2;
    if (p === prev) {
      // same pixel as the previous one → same result
      d[j] = d[j - 4];
      d[j + 1] = d[j - 3];
      d[j + 2] = d[j - 2];
      continue;
    }
    prev = p;
    if (p >>> 24 === 0) continue;
    const rgb = p & 0xffffff;
    let slot = 0;
    if (memo) {
      slot = Math.imul(rgb, -1640531535) >>> MEMO_SHIFT;
      if (ck[slot] === rgb) {
        u[q] = (p & ALPHA_MASK) | cv[slot];
        continue;
      }
    }
    px: {
      const r = p & 255,
        g = (p >> 8) & 255,
        b = (p >> 16) & 255;
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      if (mx === mn) break px; // neutral: nothing to (de)saturate
      const t = (mx << 8) | mn;
      const L = 0.299 * r + 0.587 * g + 0.114 * b; // luma()
      let f: number;
      if (vib > 0) {
        let w = W[t]; // (1 − s)^1.5 · 1.3
        // Skin protection: warm hues (r ≥ g ≥ b, hue ≈ 10°–45°) get a gentler boost.
        if (r >= g && g >= b) w *= SK[((r - b) << 8) | (g - b)];
        f = 1 + vib * w;
        // Cap the boost so the most extreme channel just reaches 0 or 255 (no clipping). The
        // caps (two divisions) only matter when the boost gets near them: a conservative test
        // skips them for every color the cap can't change (min(f, max(1, cap)) = f).
        if ((mx > L && f * (mx - L) > (255 - L) * CAP_SAFE) || (mn < L && f * (L - mn) > L * CAP_SAFE)) {
          let cap = Infinity;
          if (mx > L) cap = (255 - L) / (mx - L);
          if (mn < L) cap = Math.min(cap, L / (L - mn));
          f = Math.min(f, Math.max(1, cap));
        }
      } else if (vib < 0) {
        f = 1 + vib * (1 - S[t] * 0.5);
      } else f = 1;
      f *= sat1;
      if (f < 0) f = 0;
      d[j] = L + (r - L) * f;
      d[j + 1] = L + (g - L) * f;
      d[j + 2] = L + (b - L) * f;
    }
    if (memo) {
      ck[slot] = rgb;
      cv[slot] = u[q] & 0xffffff;
    }
  }
  return img;
}

/** Below this fraction of a cap the vibrance boost certainly stays under it (float error ≪ 1e-9). */
const CAP_SAFE = 1 - 1e-9;
const NO_MEMO = new Int32Array(0);

let vibTables: { S: Float64Array; W: Float64Array; SK: Float64Array } | null = null;
/**
 * Parameter-independent vibrance tables, same arithmetic as the per-pixel formulas: per (max,
 * min) the HSV saturation s = (max − min)/max and the boost weight (1 − s)^1.5 · 1.3, and per
 * (C = r − b, g − b) of warm colors the skin-protection factor.
 */
function vibranceTables() {
  if (vibTables) return vibTables;
  const S = new Float64Array(65536),
    W = new Float64Array(65536),
    SK = new Float64Array(65536);
  for (let mx = 1; mx < 256; mx++) {
    for (let mn = 0; mn < mx; mn++) {
      const t = (mx << 8) | mn;
      const s = (mx - mn) / mx;
      const u = 1 - s;
      S[t] = s;
      W[t] = u * Math.sqrt(u) * 1.3;
    }
  }
  for (let C = 1; C < 256; C++) {
    for (let gb = 0; gb <= C; gb++) {
      const hue = (60 * gb) / C;
      const skin = 1 - Math.abs(hue - 25) / 22;
      SK[(C << 8) | gb] = skin > 0 ? 1 - 0.6 * skin : 1;
    }
  }
  vibTables = { S, W, SK };
  return vibTables;
}

export const vibrance: FilterDef = {
  id: 'vibrance',
  name: 'Vibrance',
  category: 'Color',
  description: 'Smart saturation: boosts muted colors, protects skin tones and saturated colors from clipping.',
  keywords: ['vibrance', 'saturation', 'pop', 'vivid'],
  icon: Gem,
  adjustment: true,
  params: [numP('vibrance', 'Vibrance', -100, 100, 0), numP('saturation', 'Saturation', -100, 100, 0)],
  apply(img, p) {
    vibrancePixels(img, num(p, 'vibrance', 0), num(p, 'saturation', 0));
    return img;
  },
};

/* ================================================================== */
/* Hue / Saturation                                                    */
/* ================================================================== */

/** Colorize saturation: 0 → 25% (Photoshop's default when ticking Colorize), ±100 → 100% / 0%. */
export function colorizeSaturation(saturation: number): number {
  const s = Math.max(-100, Math.min(100, saturation)) / 100;
  return s >= 0 ? 0.25 + s * 0.75 : 0.25 * (1 + s);
}

export function hueSaturationPixels(img: Pixels, p: ParamValues): Pixels {
  const hue = num(p, 'hue', 0, -180, 180);
  const sat = num(p, 'saturation', 0, -100, 100) / 100;
  const light = num(p, 'lightness', 0, -100, 100) / 100;
  const colorize = bool(p, 'colorize', false);
  const d = img.data;

  if (colorize) {
    // Luma → colorized RGB lookup (H and S are constant): 256×3 table.
    const H = (hue + 360) % 360;
    const S = colorizeSaturation(num(p, 'saturation', 0, -100, 100));
    const table = new Uint8ClampedArray(256 * 3);
    for (let v = 0; v < 256; v++) {
      let L = v / 255;
      L = light > 0 ? L + (1 - L) * light : L * (1 + light);
      hslToRgbInto(H, S, L, scratch);
      table[v * 3] = scratch[0];
      table[v * 3 + 1] = scratch[1];
      table[v * 3 + 2] = scratch[2];
    }
    for (let i = 0, n = d.length; i < n; i += 4) {
      if (d[i + 3] === 0) continue;
      const v = ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29 + 128) >> 8) * 3;
      d[i] = table[v];
      d[i + 1] = table[v + 1];
      d[i + 2] = table[v + 2];
    }
    return img;
  }

  if (hue === 0 && sat === 0 && light === 0) return img;
  const T = hueSatTables(sat, light);
  // Lightness alone is a per-channel curve.
  if (hue === 0 && sat === 0) {
    applyLuts(img, T.lightLut);
    return img;
  }
  // HSL hue rotation keeps max/min (L and S are unchanged): only the sector and the intermediate
  // channel change, so the saturation/lightness of the max and min channels only depend on
  // (max, min) → precomputed 64K tables; only the mid channel is computed per color, with the
  // same float operations as rgb→hsl→rotate→rgb (bit-identical results).
  const shift = hue / 60; // in hue sectors
  const u = pixelWords(img);
  if (!u) {
    hueSatBytes(d, shift, sat, light, T);
    return img;
  }
  const { packed, alpha } = T;
  const sat1 = 1 + sat;
  // Whole pixels as little-endian words (r | g << 8 | b << 16 | a << 24): one load/store each.
  // A pixel equal to the previous one gets the previous result (flat areas, runs of one color);
  // other colors seen before (in this call or an earlier one with the same params) come from
  // the color memo.
  const { keys: ck, vals: cv } = colorMemo(`hs:${shift}:${sat}:${light}`);
  let prev = ~u[0];
  for (let i = 0, n = u.length; i < n; i++) {
    const p = u[i];
    if (p === prev) {
      u[i] = u[i - 1];
      continue;
    }
    prev = p;
    if (p >>> 24 === 0) continue;
    const rgb = p & 0xffffff;
    const slot = Math.imul(rgb, -1640531535) >>> MEMO_SHIFT;
    if (ck[slot] === rgb) {
      u[i] = (p & ALPHA_MASK) | cv[slot];
      continue;
    }
    const o = hueSatColor(p & 255, (p >> 8) & 255, (p >> 16) & 255, shift, sat, sat1, light, packed, alpha, T.lightLut);
    u[i] = (p & ALPHA_MASK) | o;
    ck[slot] = rgb;
    cv[slot] = o;
  }
  return img;
}

/**
 * Hue/saturation result of one color (packed r | g << 8 | b << 16). The hue rotation uses the
 * reference arithmetic (sector position (x − y)/C + offset, shifted, wrapped, split into sector
 * and fraction f, mid = min + C·f or max − C·f); the max / min channels come from the tables.
 */
function hueSatColor(r: number, g: number, b: number, shift: number, sat: number, sat1: number, light: number, packed: Int32Array, alpha: Float64Array, lightLut: Uint8ClampedArray): number {
  const M = r > g ? (r > b ? r : b) : g > b ? g : b;
  const m = r < g ? (r < b ? r : b) : g < b ? g : b;
  const C = M - m;
  if (C === 0) {
    // gray: no hue, no saturation → lightness only
    const v = lightLut[r];
    return (v << 16) | (v << 8) | v;
  }
  let sector: number, v: number;
  if (shift === 0) {
    // no rotation: the mid channel keeps its value; sector = where it sits (ties: red, then green)
    v = r + g + b - M - m;
    sector = r >= g ? (g >= b ? 0 : r >= b ? 5 : 4) : r >= b ? 1 : g >= b ? 2 : 3;
  } else {
    let h = M === r ? (g - b) / C : M === g ? (b - r) / C + 2 : (r - g) / C + 4;
    h += shift;
    h = h - 6 * Math.floor(h / 6);
    sector = h | 0;
    const f = h - sector;
    // sectors 0, 2, 4: the mid channel rises (min + C·f); 1, 3, 5 (and a wrap that rounded to 6): it falls
    v = sector & 1 || sector > 5 ? M - C * f : m + C * f;
  }
  const t = (M << 8) | m;
  if (sat > 0) {
    const L = (M + m) / 2;
    v = v + (v - L) * alpha[t];
  } else if (sat < 0) {
    const L = (M + m) / 2;
    v = L + (v - L) * sat1;
  }
  if (light > 0) v = v + (255 - v) * light;
  else if (light < 0) v = v + v * light;
  // rounded half to even, like a byte store (and like the max / min tables)
  let vi = v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
  if (vi - v === 0.5) vi &= ~1;
  const pk = packed[t];
  const hi = pk & 255,
    lo = pk >> 8;
  switch (sector) {
    case 0:
      return hi | (vi << 8) | (lo << 16);
    case 1:
      return vi | (hi << 8) | (lo << 16);
    case 2:
      return lo | (hi << 8) | (vi << 16);
    case 3:
      return lo | (vi << 8) | (hi << 16);
    case 4:
      return vi | (lo << 8) | (hi << 16);
    default:
      return hi | (lo << 8) | (vi << 16);
  }
}

/** Byte-wise variant of the hue/saturation loop (big-endian hosts / unaligned buffers). */
function hueSatBytes(d: Uint8ClampedArray, shift: number, sat: number, light: number, T: HueSatTables) {
  const { packed, alpha, lightLut } = T;
  const sat1 = 1 + sat;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const o = hueSatColor(d[i], d[i + 1], d[i + 2], shift, sat, sat1, light, packed, alpha, lightLut);
    d[i] = o & 255;
    d[i + 1] = (o >> 8) & 255;
    d[i + 2] = o >> 16;
  }
}

interface HueSatTables {
  sat: number;
  light: number;
  /** Final (saturated + lightened, rounded) value of the max channel | min channel << 8, index max·256 + min. */
  packed: Int32Array;
  /** Photoshop saturation-increase factor per (max, min) (sat > 0 only). */
  alpha: Float64Array;
  /** Lightness curve (gray pixels / lightness-only edits). */
  lightLut: Uint8ClampedArray;
}
let hueSatCache: HueSatTables | null = null;

/** Per-(max, min) tables of the saturation + lightness steps (cached for the last params). */
function hueSatTables(sat: number, light: number): HueSatTables {
  if (hueSatCache && hueSatCache.sat === sat && hueSatCache.light === light) return hueSatCache;
  const lt = (c: number) => (light > 0 ? c + (255 - c) * light : light < 0 ? c + c * light : c);
  const lightLut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lightLut[v] = lt(v);
  const packed = new Int32Array(65536);
  const q = new Uint8ClampedArray(2); // same rounding as the pixel stores
  const alpha = new Float64Array(sat > 0 ? 65536 : 1);
  for (let M = 1; M < 256; M++) {
    for (let m = 0; m < M; m++) {
      const t = (M << 8) | m;
      const L = (M + m) / 2; // HSL lightness (0..255)
      let vM: number, vm: number;
      if (sat > 0) {
        // Photoshop's saturation increase (approaches full saturation without hue shifts).
        const l01 = L / 255;
        const delta = (M - m) / 255;
        const s = l01 > 0.5 ? delta / (2 - (M + m) / 255) : delta / ((M + m) / 255);
        let a = sat + s >= 1 ? s : 1 - sat;
        a = a > 0 ? 1 / a - 1 : 255;
        alpha[t] = a;
        vM = M + (M - L) * a;
        vm = m + (m - L) * a;
      } else if (sat < 0) {
        vM = L + (M - L) * (1 + sat);
        vm = L + (m - L) * (1 + sat);
      } else {
        vM = M;
        vm = m;
      }
      q[0] = lt(vM);
      q[1] = lt(vm);
      packed[t] = q[0] | (q[1] << 8);
    }
  }
  hueSatCache = { sat, light, packed, alpha, lightLut };
  return hueSatCache;
}

export const hueSaturation: FilterDef = {
  id: 'hue-saturation',
  name: 'Hue/Saturation',
  category: 'Color',
  description: 'Rotate hues, change saturation and lightness, or colorize the image with a single hue.',
  keywords: ['hue', 'saturation', 'lightness', 'colorize', 'sepia', 'desaturate'],
  icon: Palette,
  adjustment: true,
  params: [
    numP('hue', 'Hue', -180, 180, 0, { unit: '°' }),
    numP('saturation', 'Saturation', -100, 100, 0, { hint: 'In Colorize mode 0 = 25% saturation, 100 = full' }),
    numP('lightness', 'Lightness', -100, 100, 0),
    boolP('colorize', 'Colorize', false, { hint: 'Tint the whole image with one hue (sepia, cyanotype…)' }),
  ],
  apply(img, p) {
    hueSaturationPixels(img, p);
    return img;
  },
};

/* ================================================================== */
/* Color Balance                                                       */
/* ================================================================== */

/**
 * Tonal-range weighted color balance (GIMP/Photoshop masks: shadows ‾\_, midtones _/‾\_,
 * highlights _/‾ over HSL lightness). Preserve Luminosity restores the original HSL lightness.
 */
export function colorBalancePixels(img: Pixels, p: ParamValues): Pixels {
  const v = (k: string) => num(p, k, 0, -100, 100) / 100;
  const sh = [v('shadowsR'), v('shadowsG'), v('shadowsB')];
  const md = [v('midR'), v('midG'), v('midB')];
  const hi = [v('highR'), v('highG'), v('highB')];
  if ([...sh, ...md, ...hi].every((x) => x === 0)) return img;
  const preserve = bool(p, 'preserveLuminosity', true);
  // Offsets (0..255 units) per HSL-lightness index (max+min, 0..510).
  const off = new Float32Array(511 * 3);
  const a = 0.25,
    bb = 0.333,
    scale = 0.7;
  const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  for (let k = 0; k < 511; k++) {
    const l = k / 510;
    const ws = cl((l - bb) / -a + 0.5) * scale;
    const wm = cl((l - bb) / a + 0.5) * cl((l + bb - 1) / -a + 0.5) * scale;
    const wh = cl((l + bb - 1) / a + 0.5) * scale;
    for (let c = 0; c < 3; c++) off[k * 3 + c] = (sh[c] * ws + md[c] * wm + hi[c] * wh) * 255;
  }
  const d = img.data;
  const live = pixelWords(img);
  const u = live ?? readWords(img);
  const memo = live ? colorMemo(`cb:${sh}:${md}:${hi}:${preserve}`) : null;
  const ck = memo ? memo.keys : NO_MEMO,
    cv = memo ? memo.vals : NO_MEMO;
  let prev = ~u[0];
  for (let q = 0, n = u.length; q < n; q++) {
    const p = u[q];
    const i = q << 2;
    if (p === prev) {
      // same pixel as the previous one → same result
      d[i] = d[i - 4];
      d[i + 1] = d[i - 3];
      d[i + 2] = d[i - 2];
      continue;
    }
    prev = p;
    if (p >>> 24 === 0) continue;
    const rgb = p & 0xffffff;
    let slot = 0;
    if (memo) {
      slot = Math.imul(rgb, -1640531535) >>> MEMO_SHIFT;
      if (ck[slot] === rgb) {
        u[q] = (p & ALPHA_MASK) | cv[slot];
        continue;
      }
    }
    const r0 = p & 255,
      g0 = (p >> 8) & 255,
      b0 = (p >> 16) & 255;
    const mx = r0 > g0 ? (r0 > b0 ? r0 : b0) : g0 > b0 ? g0 : b0;
    const mn = r0 < g0 ? (r0 < b0 ? r0 : b0) : g0 < b0 ? g0 : b0;
    const k = (mx + mn) * 3;
    let r = r0 + off[k],
      g = g0 + off[k + 1],
      b = b0 + off[k + 2];
    r = r < 0 ? 0 : r > 255 ? 255 : r;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    b = b < 0 ? 0 : b > 255 ? 255 : b;
    if (preserve) {
      // Restore the original HSL lightness keeping hue & saturation (closed form of
      // rgb→hsl→set L→rgb): rescale the chroma around the new lightness.
      const M1 = r > g ? (r > b ? r : b) : g > b ? g : b;
      const m1 = r < g ? (r < b ? r : b) : g < b ? g : b;
      const L2 = mx + mn; // original lightness ×2 (0..510)
      const C1 = M1 - m1;
      if (C1 <= 0) {
        r = g = b = L2 / 2;
      } else {
        const s1 = C1 / (255 - Math.abs(M1 + m1 - 255) || 1);
        const C0 = s1 * (255 - Math.abs(L2 - 255));
        const k0 = C0 / C1;
        const base = L2 / 2 - C0 / 2;
        r = base + (r - m1) * k0;
        g = base + (g - m1) * k0;
        b = base + (b - m1) * k0;
      }
    }
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    if (memo) {
      ck[slot] = rgb;
      cv[slot] = u[q] & 0xffffff;
    }
  }
  return img;
}

const balanceGroup = (prefix: string, group: string): ParamDef[] => [
  numP(`${prefix}R`, 'Cyan ↔ Red', -100, 100, 0, { group }),
  numP(`${prefix}G`, 'Magenta ↔ Green', -100, 100, 0, { group }),
  numP(`${prefix}B`, 'Yellow ↔ Blue', -100, 100, 0, { group }),
];

export const colorBalance: FilterDef = {
  id: 'color-balance',
  name: 'Color Balance',
  category: 'Color',
  description: 'Shift colors separately in the shadows, midtones and highlights.',
  keywords: ['color balance', 'tint', 'warm', 'cool', 'teal', 'orange', 'grade'],
  icon: Scale,
  adjustment: true,
  params: [
    ...balanceGroup('shadows', 'Shadows'),
    ...balanceGroup('mid', 'Midtones'),
    ...balanceGroup('high', 'Highlights'),
    boolP('preserveLuminosity', 'Preserve Luminosity', true, { group: 'Options' }),
  ],
  apply(img, p) {
    colorBalancePixels(img, p);
    return img;
  },
};

/* ================================================================== */
/* Black & White                                                       */
/* ================================================================== */

export const BW_DEFAULTS = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 };

/**
 * Photoshop Black & White: gray = min + (max − mid)·w[primary] + (mid − min)·w[secondary],
 * where primary is the max channel's color and secondary the max+mid pair (Y/C/M).
 */
export function blackWhiteGray(r: number, g: number, b: number, w: { reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number }): number {
  let mx: number, md: number, mn: number, primary: number, secondary: number;
  if (r >= g && r >= b) {
    mx = r;
    primary = w.reds;
    if (g >= b) {
      md = g;
      mn = b;
      secondary = w.yellows;
    } else {
      md = b;
      mn = g;
      secondary = w.magentas;
    }
  } else if (g >= r && g >= b) {
    mx = g;
    primary = w.greens;
    if (r >= b) {
      md = r;
      mn = b;
      secondary = w.yellows;
    } else {
      md = b;
      mn = r;
      secondary = w.cyans;
    }
  } else {
    mx = b;
    primary = w.blues;
    if (r >= g) {
      md = r;
      mn = g;
      secondary = w.magentas;
    } else {
      md = g;
      mn = r;
      secondary = w.cyans;
    }
  }
  return mn + ((mx - md) * primary) / 100 + ((md - mn) * secondary) / 100;
}

/** Tint table: adds the tint color's chroma (zero-luma offset) strongest in the midtones. */
export function tintTable(color: string, strength = 1): Float32Array {
  const [tr, tg, tb] = rgbOf(color);
  const lt = luma(tr, tg, tb);
  const t = new Float32Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    const k = Math.pow(4 * x * (1 - x), 0.75) * strength * 0.62;
    t[v * 3] = (tr - lt) * k;
    t[v * 3 + 1] = (tg - lt) * k;
    t[v * 3 + 2] = (tb - lt) * k;
  }
  return t;
}

export function blackWhitePixels(img: Pixels, p: ParamValues): Pixels {
  const w = {
    reds: num(p, 'reds', BW_DEFAULTS.reds, -200, 300),
    yellows: num(p, 'yellows', BW_DEFAULTS.yellows, -200, 300),
    greens: num(p, 'greens', BW_DEFAULTS.greens, -200, 300),
    cyans: num(p, 'cyans', BW_DEFAULTS.cyans, -200, 300),
    blues: num(p, 'blues', BW_DEFAULTS.blues, -200, 300),
    magentas: num(p, 'magentas', BW_DEFAULTS.magentas, -200, 300),
  };
  const tint = bool(p, 'tint', false) ? tintTable(str(p, 'tintColor', '#e1c58f')) : null;
  const wR = w.reds / 100,
    wY = w.yellows / 100,
    wG = w.greens / 100,
    wC = w.cyans / 100,
    wB = w.blues / 100,
    wM = w.magentas / 100;
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    // Inlined blackWhiteGray(): min + (max−mid)·w[primary] + (mid−min)·w[secondary].
    let v: number;
    if (r >= g) {
      if (g >= b) v = b + (r - g) * wR + (g - b) * wY;
      else if (r >= b) v = g + (r - b) * wR + (b - g) * wM;
      else v = g + (b - r) * wB + (r - g) * wM;
    } else if (r >= b) v = b + (g - r) * wG + (r - b) * wY;
    else if (g >= b) v = r + (g - b) * wG + (b - r) * wC;
    else v = r + (b - g) * wB + (g - r) * wC;
    const gray = v < 0 ? 0 : v > 255 ? 255 : v;
    if (tint) {
      const k = Math.round(gray) * 3;
      d[i] = gray + tint[k];
      d[i + 1] = gray + tint[k + 1];
      d[i + 2] = gray + tint[k + 2];
    } else {
      d[i] = gray;
      d[i + 1] = gray;
      d[i + 2] = gray;
    }
  }
  return img;
}

const bwWeight = (key: keyof typeof BW_DEFAULTS, label: string): ParamDef =>
  numP(key, label, -200, 300, BW_DEFAULTS[key], { unit: '%', group: 'Color Weights' });

export const blackWhite: FilterDef = {
  id: 'black-white',
  name: 'Black & White',
  category: 'Color',
  description: 'Convert to grayscale with control over how bright each color becomes; optional tint.',
  keywords: ['black and white', 'grayscale', 'monochrome', 'b&w', 'noir', 'infrared'],
  icon: SunMoon,
  adjustment: true,
  params: [
    bwWeight('reds', 'Reds'),
    bwWeight('yellows', 'Yellows'),
    bwWeight('greens', 'Greens'),
    bwWeight('cyans', 'Cyans'),
    bwWeight('blues', 'Blues'),
    bwWeight('magentas', 'Magentas'),
    boolP('tint', 'Tint', false, { group: 'Tint' }),
    colorP('tintColor', 'Tint Color', '#e1c58f', { group: 'Tint', showIf: (v) => !!v.tint }),
  ],
  apply(img, p) {
    blackWhitePixels(img, p);
    return img;
  },
};

/* ================================================================== */
/* Photo Filter                                                        */
/* ================================================================== */

export function photoFilterPixels(img: Pixels, color: string, density: number, preserveLuminosity: boolean): Pixels {
  const dn = Math.max(0, Math.min(1, density));
  if (dn === 0) return img;
  const [fr, fg, fb] = rgbOf(color);
  const mr = 1 - dn + (dn * fr) / 255;
  const mg = 1 - dn + (dn * fg) / 255;
  const mb = 1 - dn + (dn * fb) / 255;
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r0 = d[i],
      g0 = d[i + 1],
      b0 = d[i + 2];
    let r = r0 * mr,
      g = g0 * mg,
      b = b0 * mb;
    if (preserveLuminosity) {
      const shift = luma(r0, g0, b0) - luma(r, g, b);
      r += shift;
      g += shift;
      b += shift;
    }
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
  return img;
}

export const photoFilter: FilterDef = {
  id: 'photo-filter',
  name: 'Photo Filter',
  category: 'Color',
  description: 'Simulate a colored lens filter (warming, cooling, sepia…).',
  keywords: ['photo filter', 'warming', 'cooling', 'lens filter', 'tint'],
  icon: Camera,
  adjustment: true,
  params: [
    colorP('color', 'Filter Color', '#ec8a00'),
    pctP('density', 'Density', 0.25),
    boolP('preserveLuminosity', 'Preserve Luminosity', true),
  ],
  apply(img, p) {
    photoFilterPixels(img, str(p, 'color', '#ec8a00'), num(p, 'density', 0.25, 0, 1), bool(p, 'preserveLuminosity', true));
    return img;
  },
};

/* ================================================================== */
/* Channel Mixer                                                       */
/* ================================================================== */

export function channelMixerPixels(img: Pixels, p: ParamValues): Pixels {
  const k = (key: string, def: number) => num(p, key, def, -200, 200) / 100;
  const rr = k('rr', 100),
    rg = k('rg', 0),
    rb = k('rb', 0);
  const gr = k('gr', 0),
    gg = k('gg', 100),
    gb = k('gb', 0);
  const br = k('br', 0),
    bg = k('bg', 0),
    bb = k('bb', 100);
  const mono = bool(p, 'monochrome', false);
  if (!mono && rr === 1 && gg === 1 && bb === 1 && !rg && !rb && !gr && !gb && !br && !bg) return img;
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    if (mono) {
      const v = rr * r + rg * g + rb * b;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    } else {
      d[i] = rr * r + rg * g + rb * b;
      d[i + 1] = gr * r + gg * g + gb * b;
      d[i + 2] = br * r + bg * g + bb * b;
    }
  }
  return img;
}

const mix = (key: string, label: string, def: number, group: string, showIf: (v: ParamValues) => boolean): ParamDef =>
  numP(key, label, -200, 200, def, { unit: '%', group, showIf });
const isMono = (v: ParamValues) => !!v.monochrome;
const notMono = (v: ParamValues) => !v.monochrome;

export const channelMixer: FilterDef = {
  id: 'channel-mixer',
  name: 'Channel Mixer',
  category: 'Color',
  description: 'Rebuild each output channel from a mix of the red, green and blue inputs (or a custom gray).',
  keywords: ['channel mixer', 'channels', 'swap', 'monochrome', 'infrared'],
  icon: Shuffle,
  adjustment: true,
  params: [
    boolP('monochrome', 'Monochrome', false),
    mix('rr', 'Red', 100, 'Red Output', notMono),
    mix('rg', 'Green', 0, 'Red Output', notMono),
    mix('rb', 'Blue', 0, 'Red Output', notMono),
    // Same keys, shown as the gray mix while Monochrome is on (only one set renders at a time).
    mix('rr', 'Red', 100, 'Gray Output', isMono),
    mix('rg', 'Green', 0, 'Gray Output', isMono),
    mix('rb', 'Blue', 0, 'Gray Output', isMono),
    mix('gr', 'Red', 0, 'Green Output', notMono),
    mix('gg', 'Green', 100, 'Green Output', notMono),
    mix('gb', 'Blue', 0, 'Green Output', notMono),
    mix('br', 'Red', 0, 'Blue Output', notMono),
    mix('bg', 'Green', 0, 'Blue Output', notMono),
    mix('bb', 'Blue', 100, 'Blue Output', notMono),
  ],
  apply(img, p) {
    channelMixerPixels(img, p);
    return img;
  },
};

/* ================================================================== */
/* Selective Color                                                     */
/* ================================================================== */

export const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;
export type SelectiveRange = (typeof SELECTIVE_RANGES)[number];
export const RANGE_LABELS: Record<SelectiveRange, string> = {
  reds: 'Reds',
  yellows: 'Yellows',
  greens: 'Greens',
  cyans: 'Cyans',
  blues: 'Blues',
  magentas: 'Magentas',
  whites: 'Whites',
  neutrals: 'Neutrals',
  blacks: 'Blacks',
};

/**
 * Photoshop-style Selective Color. Each pixel belongs to color ranges by amount (e.g. reds =
 * max − mid when red is the max channel; whites/blacks/neutrals by min/max). Each range adjusts
 * cyan (→R), magenta (→G), yellow (→B) and black, relative to the existing ink or absolute.
 */
export function selectiveColorPixels(img: Pixels, p: ParamValues): Pixels {
  // Per range: [cyan, magenta, yellow, black] in -1..1; only ranges with edits are evaluated.
  const adj = new Float32Array(9 * 4);
  const active = new Uint8Array(9);
  let any = false;
  SELECTIVE_RANGES.forEach((r, i) => {
    ['C', 'M', 'Y', 'K'].forEach((c, j) => {
      const v = num(p, `${r}${c}`, 0, -100, 100) / 100;
      adj[i * 4 + j] = v;
      if (v !== 0) active[i] = 1;
    });
    if (active[i]) any = true;
  });
  if (!any) return img;
  const relative = str(p, 'method', 'relative') !== 'absolute';
  // Precomputed per-range channel factors: delta_v = ((−1 − a)·k − a) · (relative ? 1 − v : 1).
  const fac = new Float32Array(9 * 3);
  for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) fac[k * 3 + c] = (-1 - adj[k * 4 + c]) * adj[k * 4 + 3] - adj[k * 4 + c];
  const aR = active[0],
    aY = active[1],
    aG = active[2],
    aC = active[3],
    aB = active[4],
    aM = active[5],
    aW = active[6],
    aN = active[7],
    aK = active[8];
  const d = img.data;
  const live = pixelWords(img);
  const u = live ?? readWords(img);
  const memo = live ? colorMemo(`sc:${adj.join(',')}:${relative}`) : null;
  const ck = memo ? memo.keys : NO_MEMO,
    cv = memo ? memo.vals : NO_MEMO;
  let prev = ~u[0];
  for (let q = 0, n = u.length; q < n; q++) {
    const p = u[q];
    const i = q << 2;
    if (p === prev) {
      // same pixel as the previous one → same result
      d[i] = d[i - 4];
      d[i + 1] = d[i - 3];
      d[i + 2] = d[i - 2];
      continue;
    }
    prev = p;
    if (p >>> 24 === 0) continue;
    const rgb = p & 0xffffff;
    let slot = 0;
    if (memo) {
      slot = Math.imul(rgb, -1640531535) >>> MEMO_SHIFT;
      if (ck[slot] === rgb) {
        u[q] = (p & ALPHA_MASK) | cv[slot];
        continue;
      }
    }
    const r = p & 255,
      g = (p >> 8) & 255,
      b = (p >> 16) & 255;
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const md = r + g + b - mx - mn;
    // Accumulate weighted factors (amount/255 · factor) per channel.
    let f0 = 0,
      f1 = 0,
      f2 = 0;
    if (mx !== mn) {
      const prim = r === mx ? (aR ? 0 : -1) : g === mx ? (aG ? 2 : -1) : aB ? 4 : -1;
      if (prim >= 0) {
        const a = (mx - md) / 255;
        f0 += a * fac[prim * 3];
        f1 += a * fac[prim * 3 + 1];
        f2 += a * fac[prim * 3 + 2];
      }
      const sec = b === mn ? (aY ? 1 : -1) : r === mn ? (aC ? 3 : -1) : aM ? 5 : -1;
      if (sec >= 0) {
        const a = (md - mn) / 255;
        f0 += a * fac[sec * 3];
        f1 += a * fac[sec * 3 + 1];
        f2 += a * fac[sec * 3 + 2];
      }
    }
    if (aW && mn > 128) {
      const a = ((mn - 128) * 2) / 255;
      f0 += a * fac[18];
      f1 += a * fac[19];
      f2 += a * fac[20];
    }
    if (aK && mx < 128) {
      const a = ((128 - mx) * 2) / 255;
      f0 += a * fac[24];
      f1 += a * fac[25];
      f2 += a * fac[26];
    }
    if (aN) {
      const a = 255 - (Math.abs(mx - 127.5) + Math.abs(mn - 127.5));
      if (a > 0) {
        const t = a / 255;
        f0 += t * fac[21];
        f1 += t * fac[22];
        f2 += t * fac[23];
      }
    }
    if (f0 !== 0 || f1 !== 0 || f2 !== 0) {
      if (relative) {
        d[i] = r + f0 * (255 - r);
        d[i + 1] = g + f1 * (255 - g);
        d[i + 2] = b + f2 * (255 - b);
      } else {
        d[i] = r + f0 * 255;
        d[i + 1] = g + f1 * 255;
        d[i + 2] = b + f2 * 255;
      }
    }
    if (memo) {
      ck[slot] = rgb;
      cv[slot] = u[q] & 0xffffff;
    }
  }
  return img;
}

const selectiveParams = (): ParamDef[] => {
  const out: ParamDef[] = [
    // Which range the editor shows. Kept as a param (catalog key) for the generic ParamEditor, but
    // it doesn't affect pixels: the panel editor holds it as view state (presets.VIEW_ONLY_KEYS).
    selectP(
      'range',
      'Colors',
      SELECTIVE_RANGES.map((r) => [r, RANGE_LABELS[r]] as [string, string]),
      'reds',
    ),
  ];
  for (const r of SELECTIVE_RANGES) {
    const showIf = (v: ParamValues) => (v.range ?? 'reds') === r;
    out.push(
      numP(`${r}C`, 'Cyan', -100, 100, 0, { unit: '%', showIf }),
      numP(`${r}M`, 'Magenta', -100, 100, 0, { unit: '%', showIf }),
      numP(`${r}Y`, 'Yellow', -100, 100, 0, { unit: '%', showIf }),
      numP(`${r}K`, 'Black', -100, 100, 0, { unit: '%', showIf }),
    );
  }
  out.push(
    selectP(
      'method',
      'Method',
      [
        ['relative', 'Relative'],
        ['absolute', 'Absolute'],
      ],
      'relative',
      { hint: 'Relative scales the existing ink; Absolute adds a fixed amount (needed to tint pure whites)' },
    ),
  );
  return out;
};

export const selectiveColor: FilterDef = {
  id: 'selective-color',
  name: 'Selective Color',
  category: 'Color',
  description: 'Adjust the cyan/magenta/yellow/black mix of specific color ranges, whites, neutrals and blacks.',
  keywords: ['selective color', 'cmyk', 'reds', 'blacks', 'grade'],
  icon: Pipette,
  adjustment: true,
  params: selectiveParams(),
  apply(img, p) {
    selectiveColorPixels(img, p);
    return img;
  },
};

export const COLOR_DEFS: FilterDef[] = [vibrance, hueSaturation, colorBalance, blackWhite, photoFilter, channelMixer, selectiveColor];
