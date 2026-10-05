import { describe, expect, it } from 'vitest';
import type { BlendMode } from '../core/types';
import { blendAtop, isBlendable, separableLut } from './blendMath';

/* Independent reference (W3C Compositing and Blending Level 1, written with arrays). */
type RGB = [number, number, number];
const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c: RGB): RGB {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let o = [...c] as RGB;
  if (n < 0) o = o.map((v) => l + ((v - l) * l) / (l - n)) as RGB;
  if (x > 1) o = o.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as RGB;
  return o;
}
const setLum = (c: RGB, l: number) => clipColor(c.map((v) => v + (l - lum(c))) as RGB);
const sat = (c: RGB) => Math.max(...c) - Math.min(...c);
function setSat(c: RGB, s: number): RGB {
  const [mn, md, mx] = [0, 1, 2].sort((i, j) => c[i] - c[j]);
  const o: RGB = [0, 0, 0];
  if (c[mx] > c[mn]) {
    o[md] = ((c[md] - c[mn]) * s) / (c[mx] - c[mn]);
    o[mx] = s;
  }
  return o;
}
const REF_NON_SEP: Record<string, (b: RGB, s: RGB) => RGB> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};
const REF_SEP: Record<string, (b: number, s: number) => number> = {
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  darken: Math.min,
  lighten: Math.max,
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  'linear-dodge': (b, s) => Math.min(1, b + s),
  'hard-light': (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  overlay: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s);
}

function one(mode: BlendMode, b: RGB, s: RGB, a = 255): number[] {
  const dst = new Uint8ClampedArray([...b, a]);
  blendAtop(dst, new Uint8ClampedArray([...s, 17]), mode);
  return Array.from(dst);
}

describe('blendMath (CPU atop blending)', () => {
  it('separable modes match the W3C formulas (all 64K byte pairs, rounded half up)', () => {
    for (const [mode, f] of Object.entries(REF_SEP)) {
      const lut = separableLut(mode as BlendMode)!;
      for (let b = 0; b < 256; b++)
        for (let s = 0; s < 256; s++) {
          const want = Math.min(255, Math.max(0, Math.floor(f(b / 255, s / 255) * 255 + 0.5)));
          if (Math.abs(lut[(b << 8) | s] - want) > 0) expect(`${mode} ${b},${s}: ${lut[(b << 8) | s]}`).toBe(`${mode} ${b},${s}: ${want}`);
        }
    }
  });

  it('non-separable modes match the reference (random colours, ≤ 1 level for float noise at ties)', () => {
    // Two passes over the same pairs: the second one is served by the result memo.
    for (let pass = 0; pass < 2; pass++) {
      const R = rng(7);
      for (const mode of ['hue', 'saturation', 'color', 'luminosity'] as const) {
        for (let k = 0; k < 4000; k++) {
          const b: RGB = [R() & 255, R() & 255, R() & 255];
          const s: RGB = [R() & 255, R() & 255, R() & 255];
          const want = REF_NON_SEP[mode](b.map((v) => v / 255) as RGB, s.map((v) => v / 255) as RGB).map((v) => v * 255);
          const got = one(mode, b, s);
          for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c]), `${mode} ${b} ${s} ch${c}`).toBeLessThanOrEqual(0.5 + 1e-6);
        }
      }
    }
  });

  it('rounds an exact tie up (the case canvas pipelines disagree on)', () => {
    // color(Cb, Cs) here is (222.5, 118.5, 122.5) exactly.
    expect(one('color', [170, 152, 86], [180, 76, 80])).toEqual([223, 119, 123, 255]);
  });

  it('keeps the backdrop alpha, ignores the source alpha, clears uncovered pixels', () => {
    expect(one('multiply', [200, 100, 50], [128, 128, 128], 77)).toEqual([100, 50, 25, 77]);
    expect(one('color', [10, 20, 30], [200, 0, 0], 0)).toEqual([0, 0, 0, 0]);
    expect(one('multiply', [10, 20, 30], [200, 0, 0], 0)).toEqual([0, 0, 0, 0]);
    // 'normal' (not a blend) copies the source colour atop.
    expect(one('normal', [10, 20, 30], [200, 1, 2], 40)).toEqual([200, 1, 2, 40]);
    expect(isBlendable('normal')).toBe(false);
    expect(isBlendable('luminosity')).toBe(true);
  });

  it('gives every pixel the same result wherever it is (runs, positions, buffer sizes)', () => {
    const R = rng(3);
    const n = 300;
    const b = new Uint8ClampedArray(n * 4);
    const s = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      // runs of repeated colours mixed with new ones
      const rep = i > 0 && R() % 3 === 0;
      for (let c = 0; c < 3; c++) {
        b[i * 4 + c] = rep ? b[(i - 1) * 4 + c] : R() & 255;
        s[i * 4 + c] = rep ? s[(i - 1) * 4 + c] : R() & 255;
      }
      b[i * 4 + 3] = rep ? b[(i - 1) * 4 + 3] : (R() & 255) | 1;
    }
    for (const mode of ['hue', 'color', 'soft-light', 'color-dodge'] as const) {
      const all = new Uint8ClampedArray(b);
      blendAtop(all, s, mode);
      for (let i = 0; i < n; i += 37) {
        const px = one(mode, [b[i * 4], b[i * 4 + 1], b[i * 4 + 2]], [s[i * 4], s[i * 4 + 1], s[i * 4 + 2]], b[i * 4 + 3]);
        expect(Array.from(all.slice(i * 4, i * 4 + 4)), `${mode} pixel ${i}`).toEqual(px);
      }
    }
  });
});
