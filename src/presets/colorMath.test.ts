import { describe, expect, it } from 'vitest';
import { contrastRatio, describeColor, harmony, normalizeHex, opaqueHex, relativeLuminance, wcagLevel } from './colorMath';
import { GRADIENT_PRESETS, GRADIENT_CATEGORIES } from './gradients';
import { BUILTIN_PALETTES, DEFAULT_PALETTE_ID } from './palettes';

describe('normalizeHex', () => {
  it('accepts short, long and alpha forms', () => {
    expect(normalizeHex('f80')).toBe('#ff8800');
    expect(normalizeHex('#FF8800')).toBe('#ff8800');
    expect(normalizeHex('ff8800cc')).toBe('#ff8800');
    expect(normalizeHex('#abcd')).toBe('#aabbcc');
  });
  it('rejects garbage', () => {
    expect(normalizeHex('zzz')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });
  it('opaqueHex drops alpha', () => {
    expect(opaqueHex('#11223344')).toBe('#112233');
  });
});

describe('WCAG contrast', () => {
  it('black on white is 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });
  it('same color is 1:1', () => {
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
  it('matches known values', () => {
    // #767676 is the classic lightest gray passing AA on white (4.54:1)
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });
  it('levels', () => {
    expect(wcagLevel(7.2)).toBe('AAA');
    expect(wcagLevel(4.6)).toBe('AA');
    expect(wcagLevel(3.1)).toBe('AA Large');
    expect(wcagLevel(2)).toBe('Fail');
  });
});

describe('harmonies', () => {
  it('complementary of red is cyan', () => {
    expect(harmony('#ff0000', 'complementary')).toEqual(['#ff0000', '#00ffff']);
  });
  it('triadic of red', () => {
    expect(harmony('#ff0000', 'triadic')).toEqual(['#ff0000', '#00ff00', '#0000ff']);
  });
  it('every rule includes the base color', () => {
    for (const k of ['complementary', 'analogous', 'triadic', 'split-complementary', 'tetradic', 'monochrome'] as const) {
      const out = harmony('#3a7bd5', k);
      expect(out).toContain('#3a7bd5');
      expect(out.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    }
  });
  it('sizes', () => {
    expect(harmony('#3a7bd5', 'tetradic')).toHaveLength(4);
    expect(harmony('#3a7bd5', 'split-complementary')).toHaveLength(3);
    expect(harmony('#3a7bd5', 'analogous')).toHaveLength(5);
    expect(harmony('#3a7bd5', 'monochrome')).toHaveLength(5);
  });
});

describe('describeColor', () => {
  it('names basics', () => {
    expect(describeColor('#000000')).toBe('Black');
    expect(describeColor('#ffffff')).toBe('White');
    expect(describeColor('#808080')).toBe('Gray');
    expect(describeColor('#ff0000')).toBe('Red');
    expect(describeColor('#0000ff')).toBe('Blue');
    expect(describeColor('#00ff00')).toBe('Green');
    expect(describeColor('#5a3a1a')).toMatch(/Brown/);
    expect(describeColor('#330000')).toBe('Dark Red');
  });
});

describe('preset data', () => {
  it('has 45+ gradient presets with valid stops in the required categories', () => {
    expect(GRADIENT_PRESETS.length).toBeGreaterThanOrEqual(45);
    const ids = new Set(GRADIENT_PRESETS.map((g) => g.id));
    expect(ids.size).toBe(GRADIENT_PRESETS.length);
    for (const cat of ['Gradient Maps', 'Duotones', 'Light', 'Metals', 'Fades', 'Vivid']) {
      expect(GRADIENT_CATEGORIES).toContain(cat);
      expect(GRADIENT_PRESETS.some((g) => g.category === cat)).toBe(true);
    }
    for (const g of GRADIENT_PRESETS) {
      expect(g.gradient.stops.length).toBeGreaterThanOrEqual(2);
      for (const s of g.gradient.stops) {
        expect(s.offset).toBeGreaterThanOrEqual(0);
        expect(s.offset).toBeLessThanOrEqual(1);
        expect(s.color).toMatch(/^#([0-9a-f]{6}|[0-9a-f]{8})$/);
      }
    }
  });
  it('gradient maps run dark → light', () => {
    for (const g of GRADIENT_PRESETS.filter((x) => x.category === 'Gradient Maps')) {
      const first = relativeLuminance(g.gradient.stops[0].color);
      const last = relativeLuminance(g.gradient.stops[g.gradient.stops.length - 1].color);
      expect(last, g.name).toBeGreaterThan(first);
    }
  });
  it('fades end transparent', () => {
    for (const g of GRADIENT_PRESETS.filter((x) => x.category === 'Fades')) {
      expect(g.gradient.stops.some((s) => s.color.length === 9 && s.color.endsWith('00'))).toBe(true);
    }
  });
  it('has 22+ palettes with the default Swatches first', () => {
    expect(BUILTIN_PALETTES.length).toBeGreaterThanOrEqual(23);
    expect(BUILTIN_PALETTES[0].id).toBe(DEFAULT_PALETTE_ID);
    expect(BUILTIN_PALETTES[0].colors[0]).toBe('#000000');
    for (const name of ['Gothic Paper', 'Amber Halftone', 'Noir Press', 'Crimson Film', 'Classic Bricks', 'Grayscale Ramp', 'Skin Tones', 'Metallics']) {
      expect(BUILTIN_PALETTES.some((p) => p.name === name), name).toBe(true);
    }
    for (const p of BUILTIN_PALETTES) for (const c of p.colors) expect(c, p.name).toMatch(/^#[0-9a-f]{6}$/);
  });
});
