/**
 * Test-only reference: the adjustment pixel loops exactly as they were before the performance pass
 * (commit f08283b), kept verbatim so perf.test.ts can check the optimized versions stay identical
 * (or within ±1 per channel). Not imported by the app.
 */
import type { Gradient, ParamValues } from '../../core/types';
import { BAYER4, clamp01, clamp255, gradientLutFloat, hslToRgbInto, lum3, luma, rgbOf, sCurve, setLumInto, type Pixels } from './math';
import { bool, num, str } from './params';

const scratch = new Float64Array(3);

/** Per-channel LUTs, byte at a time (old math.applyLuts). */
export function applyLuts(img: Pixels, r: ArrayLike<number>, g: ArrayLike<number> = r, b: ArrayLike<number> = r): void {
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = r[d[i]];
    d[i + 1] = g[d[i + 1]];
    d[i + 2] = b[d[i + 2]];
  }
}

/**
 * Vibrance boosts muted colors more than already-saturated ones and protects skin tones; the
 * boost is capped so no channel clips (hue stays stable). Saturation is a uniform scale.
 */
export function vibrancePixels(img: Pixels, vibrance: number, saturation: number): Pixels {
  const vib = Math.max(-1, Math.min(1, vibrance / 100));
  const sat = Math.max(-1, Math.min(1, saturation / 100));
  if (vib === 0 && sat === 0) return img;
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    if (mx === mn) continue; // neutral: nothing to (de)saturate
    const s = (mx - mn) / mx;
    const L = luma(r, g, b);
    let f = 1;
    if (vib > 0) {
      const u = 1 - s;
      let w = u * Math.sqrt(u) * 1.3; // (1 − s)^1.5
      // Skin protection: warm hues (r ≥ g ≥ b, hue ≈ 10°–45°) get a gentler boost.
      if (r >= g && g >= b) {
        const hue = (60 * (g - b)) / (r - b || 1);
        const skin = 1 - Math.abs(hue - 25) / 22;
        if (skin > 0) w *= 1 - 0.6 * skin;
      }
      // Cap the vibrance boost so the most extreme channel just reaches 0 or 255 (no clipping).
      let cap = Infinity;
      if (mx > L) cap = (255 - L) / (mx - L);
      if (mn < L) cap = Math.min(cap, L / (L - mn));
      f = Math.min(1 + vib * w, Math.max(1, cap));
    } else if (vib < 0) {
      f = 1 + vib * (1 - s * 0.5);
    }
    f *= 1 + sat;
    if (f < 0) f = 0;
    d[i] = L + (r - L) * f;
    d[i + 1] = L + (g - L) * f;
    d[i + 2] = L + (b - L) * f;
  }
  return img;
}

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
  const shift = hue / 60; // in hue sectors
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    if (shift !== 0 && !(r === g && g === b)) {
      // HSL hue rotation keeps max/min (L and S are unchanged): only the sector and the
      // intermediate channel change. Equivalent to rgb→hsl→rotate→rgb, without trig/calls.
      const M = r > g ? (r > b ? r : b) : g > b ? g : b;
      const m = r < g ? (r < b ? r : b) : g < b ? g : b;
      const C = M - m;
      let h = M === r ? (g - b) / C : M === g ? (b - r) / C + 2 : (r - g) / C + 4;
      h += shift;
      h = h - 6 * Math.floor(h / 6);
      const sector = h | 0;
      const f = h - sector;
      const up = m + C * f;
      const down = M - C * f;
      switch (sector) {
        case 0:
          r = M;
          g = up;
          b = m;
          break;
        case 1:
          r = down;
          g = M;
          b = m;
          break;
        case 2:
          r = m;
          g = M;
          b = up;
          break;
        case 3:
          r = m;
          g = down;
          b = M;
          break;
        case 4:
          r = up;
          g = m;
          b = M;
          break;
        default:
          r = M;
          g = m;
          b = down;
      }
    }
    if (sat !== 0) {
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx !== mn) {
        const L = (mx + mn) / 2; // HSL lightness (0..255)
        if (sat > 0) {
          // Photoshop's saturation increase (approaches full saturation without hue shifts).
          const l01 = L / 255;
          const delta = (mx - mn) / 255;
          const s = l01 > 0.5 ? delta / (2 - (mx + mn) / 255) : delta / ((mx + mn) / 255);
          let alpha = sat + s >= 1 ? s : 1 - sat;
          alpha = alpha > 0 ? 1 / alpha - 1 : 255;
          r = r + (r - L) * alpha;
          g = g + (g - L) * alpha;
          b = b + (b - L) * alpha;
        } else {
          r = L + (r - L) * (1 + sat);
          g = L + (g - L) * (1 + sat);
          b = L + (b - L) * (1 + sat);
        }
      }
    }
    if (light > 0) {
      r = r + (255 - r) * light;
      g = g + (255 - g) * light;
      b = b + (255 - b) * light;
    } else if (light < 0) {
      r = r + r * light;
      g = g + g * light;
      b = b + b * light;
    }
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
  return img;
}

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
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r0 = d[i],
      g0 = d[i + 1],
      b0 = d[i + 2];
    const mx = r0 > g0 ? (r0 > b0 ? r0 : b0) : g0 > b0 ? g0 : b0;
    const mn = r0 < g0 ? (r0 < b0 ? r0 : b0) : g0 < b0 ? g0 : b0;
    const k = (mx + mn) * 3;
    let r = clamp255(r0 + off[k]);
    let g = clamp255(g0 + off[k + 1]);
    let b = clamp255(b0 + off[k + 2]);
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
  }
  return img;
}

export const BW_DEFAULTS = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 };

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

const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;


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
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
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
    if (f0 === 0 && f1 === 0 && f2 === 0) continue;
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
  return img;
}

/** LUT resolution: 4 entries per luma level (index = (r·306 + g·601 + b·117) >> 8 ∈ 0..1020). */
const MAP_SIZE = 1021;

/**
 * Map luminosity through a gradient. Stops with alpha blend the mapped color over the original;
 * `dither` adds an ordered (Bayer 4×4) dither to hide banding in smooth gradients.
 */
export function gradientMapPixels(img: Pixels, gradient: Gradient, reverse: boolean, dither: boolean): Pixels {
  const rev = reverse !== !!gradient.reverse;
  const lut = gradientLutFloat(gradient.stops, rev, MAP_SIZE);
  let opaque = true;
  for (let k = 3; k < lut.length; k += 4) if (lut[k] < 0.999) opaque = false;
  const d = img.data;
  const w = img.width;
  const h = img.height;
  if (!dither && opaque) {
    // Fast path: integer luma index straight into a rounded RGB table.
    const t8 = new Uint8ClampedArray(MAP_SIZE * 3);
    for (let k = 0; k < MAP_SIZE; k++) {
      t8[k * 3] = lut[k * 4];
      t8[k * 3 + 1] = lut[k * 4 + 1];
      t8[k * 3 + 2] = lut[k * 4 + 2];
    }
    for (let i = 0, n = d.length; i < n; i += 4) {
      if (d[i + 3] === 0) continue;
      const k = ((d[i] * 306 + d[i + 1] * 601 + d[i + 2] * 117) >> 8) * 3;
      d[i] = t8[k];
      d[i + 1] = t8[k + 1];
      d[i + 2] = t8[k + 2];
    }
    return img;
  }
  for (let y = 0; y < h; y++) {
    let i = y * w * 4;
    const row = (y & 3) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      let t = (r * 306 + g * 601 + b * 117) / 256;
      let n = 0;
      if (dither) {
        n = BAYER4[row + (x & 3)];
        t += n * 4;
      }
      const k = (t <= 0 ? 0 : t >= MAP_SIZE - 1 ? MAP_SIZE - 1 : Math.round(t)) * 4;
      let mr = lut[k] + n,
        mg = lut[k + 1] + n,
        mb = lut[k + 2] + n;
      const ma = lut[k + 3];
      if (ma < 1) {
        mr = r + (mr - r) * ma;
        mg = g + (mg - g) * ma;
        mb = b + (mb - b) * ma;
      }
      d[i] = mr;
      d[i + 1] = mg;
      d[i + 2] = mb;
    }
  }
  return img;
}

/** 256×3 table: luma (after contrast) → mix(shadow, highlight). */
export function duotoneTable(shadow: string, highlight: string, contrast: number): Uint8ClampedArray {
  const [sr, sg, sb] = rgbOf(shadow);
  const [hr, hg, hb] = rgbOf(highlight);
  const c = Math.max(-100, Math.min(100, contrast)) / 100;
  const t = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    let x = v / 255;
    if (c > 0) x = sCurve(x, 1 + c * 2);
    else if (c < 0) x = 0.5 + (x - 0.5) * (1 + c * 0.7);
    t[v * 3] = sr + (hr - sr) * x;
    t[v * 3 + 1] = sg + (hg - sg) * x;
    t[v * 3 + 2] = sb + (hb - sb) * x;
  }
  return t;
}

export function duotonePixels(img: Pixels, shadow: string, highlight: string, contrast: number): Pixels {
  const t = duotoneTable(shadow, highlight, contrast);
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const k = ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29 + 128) >> 8) * 3;
    d[i] = t[k];
    d[i + 1] = t[k + 1];
    d[i + 2] = t[k + 2];
  }
  return img;
}

/**
 * Per-luma chroma offsets: shadows get the shadow color's chroma, highlights the highlight
 * color's (zero-luma offsets, so brightness is preserved). Balance moves the crossover.
 */
export function splitToningTable(shadowColor: string, highlightColor: string, balance: number, amount: number): Float32Array {
  const chroma = (c: string) => {
    const [r, g, b] = rgbOf(c);
    const l = luma(r, g, b);
    return [r - l, g - l, b - l];
  };
  const cs = chroma(shadowColor);
  const ch = chroma(highlightColor);
  const pivot = 0.5 - (Math.max(-100, Math.min(100, balance)) / 100) * 0.4;
  const amt = Math.max(0, Math.min(1, amount));
  const t = new Float32Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    const u = clamp01((x - (pivot - 0.4)) / 0.8);
    const wh = u * u * (3 - 2 * u);
    const ws = 1 - wh;
    const es = Math.min(1, x * 6);
    const eh = Math.min(1, (1 - x) * 6);
    for (let c = 0; c < 3; c++) t[v * 3 + c] = amt * (ws * es * cs[c] + wh * eh * ch[c]);
  }
  return t;
}

export function splitToningPixels(img: Pixels, p: ParamValues): Pixels {
  const amount = num(p, 'amount', 0.5, 0, 1);
  if (amount === 0) return img;
  const t = splitToningTable(str(p, 'shadowColor', '#1d6f8a'), str(p, 'highlightColor', '#f2a03d'), num(p, 'balance', 0), amount);
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const k = ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29 + 128) >> 8) * 3;
    d[i] += t[k];
    d[i + 1] += t[k + 1];
    d[i + 2] += t[k + 2];
  }
  return img;
}

const sc = new Float64Array(3);

/** Luminance index for the W3C lum (0.3/0.59/0.11) at 4× precision: 0..1020. */
const LUM_STEPS = 1020;

/** Blend a solid color onto each pixel with a blend mode (W3C formulas), mixed by `amount`. */
export function solidTintPixels(img: Pixels, color: string, mode: string, amount: number): Pixels {
  const a = Math.max(0, Math.min(1, amount));
  if (a === 0) return img;
  const [tr, tg, tb] = rgbOf(color).map((v) => v / 255);
  const tint = [tr, tg, tb];
  if (mode === 'color') return solidTintColor(img, tr, tg, tb, a);
  if (mode === 'hue') return solidTintHue(img, tr, tg, tb, a);
  const sep = (cb: number, cs: number): number => {
    switch (mode) {
      case 'multiply':
        return cb * cs;
      case 'screen':
        return cb + cs - cb * cs;
      case 'overlay':
        return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
      case 'hard-light':
        return cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
      case 'soft-light': {
        if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
        const dd = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
        return cb + (2 * cs - 1) * (dd - cb);
      }
      default:
        return cs;
    }
  };
  // Separable modes only depend on the channel value → 3 LUTs (pre-mixed by amount).
  const luts = [0, 1, 2].map((c) => {
    const l = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) l[v] = v + (sep(v / 255, tint[c]) * 255 - v) * a;
    return l;
  });
  applyLuts(img, luts[0], luts[1], luts[2]);
  return img;
}

/**
 * W3C "color" blend with a constant source: SetLum(tint, Lum(base)). The result only depends on
 * the base luminance, so it is a 1021-entry table indexed by an integer luminance.
 */
function solidTintColor(img: Pixels, tr: number, tg: number, tb: number, a: number): Pixels {
  const table = new Float32Array((LUM_STEPS + 1) * 3);
  for (let k = 0; k <= LUM_STEPS; k++) {
    setLumInto(tr, tg, tb, k / LUM_STEPS, sc);
    table[k * 3] = sc[0] * 255;
    table[k * 3 + 1] = sc[1] * 255;
    table[k * 3 + 2] = sc[2] * 255;
  }
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    // 0.3/0.59/0.11 × 1024 → index 0..1020 (rounded).
    const k = ((r * 307 + g * 604 + b * 113 + 128) >> 8) * 3;
    d[i] = r + (table[k] - r) * a;
    d[i + 1] = g + (table[k + 1] - g) * a;
    d[i + 2] = b + (table[k + 2] - b) * a;
  }
  return img;
}

/**
 * W3C "hue" blend with a constant source: SetLum(SetSat(tint, Sat(base)), Lum(base)), inlined.
 * SetSat(tint, s) = shape·s where shape = (tint − min) / range has one 0 and one 1 component,
 * so after SetLum the min/max channels are known in closed form (no per-pixel sorting).
 */
function solidTintHue(img: Pixels, tr: number, tg: number, tb: number, a: number): Pixels {
  const mx = Math.max(tr, tg, tb);
  const mn = Math.min(tr, tg, tb);
  const range = mx - mn;
  const d = img.data;
  if (range <= 0) {
    // Gray tint: no hue → the result is the base luminance (gray).
    for (let i = 0, n = d.length; i < n; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const L = 0.3 * r + 0.59 * g + 0.11 * b;
      d[i] = r + (L - r) * a;
      d[i + 1] = g + (L - g) * a;
      d[i + 2] = b + (L - b) * a;
    }
    return img;
  }
  const s0 = (tr - mn) / range,
    s1 = (tg - mn) / range,
    s2 = (tb - mn) / range;
  const ls = lum3(s0, s1, s2);
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    const bmx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const bmn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const s = (bmx - bmn) / 255;
    const L = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
    // SetLum: c = shape·s + (L − lum(shape·s)); min channel = L − s·ls, max = L + s − s·ls.
    const off = L - s * ls;
    let c0 = s0 * s + off,
      c1 = s1 * s + off,
      c2 = s2 * s + off;
    const lo = off;
    const hi = s + off;
    if (lo < 0) {
      const k = L / (L - lo || 1);
      c0 = L + (c0 - L) * k;
      c1 = L + (c1 - L) * k;
      c2 = L + (c2 - L) * k;
    } else if (hi > 1) {
      const k = (1 - L) / (hi - L || 1);
      c0 = L + (c0 - L) * k;
      c1 = L + (c1 - L) * k;
      c2 = L + (c2 - L) * k;
    }
    d[i] = r + (c0 * 255 - r) * a;
    d[i + 1] = g + (c1 * 255 - g) * a;
    d[i + 2] = b + (c2 * 255 - b) * a;
  }
  return img;
}
