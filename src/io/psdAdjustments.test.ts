import { describe, expect, it } from 'vitest';
import { readPsd, writePsd, type Psd } from 'ag-psd';
import type { Gradient, ParamValues } from '../core/types';
import { colorizeSatFromPsd, colorizeSatToPsd, fromPsdAdjustment, SELECTIVE_RANGES, toPsdAdjustment } from './psdAdjustments';

/** Export → Photoshop structure → (optionally through a real PSD file) → import. */
function roundTrip(filterId: string, params: ParamValues, viaFile = false) {
  const a = toPsdAdjustment(filterId, params);
  expect(a).not.toBeNull();
  let back = a!;
  if (viaFile) {
    const psd: Psd = { width: 4, height: 4, children: [{ name: 'Adj', adjustment: a! }] };
    const buf = writePsd(psd, { noBackground: true });
    const read = readPsd(buf, { skipCompositeImageData: true, skipLayerImageData: true, skipThumbnail: true });
    back = read.children![0].adjustment!;
  }
  const imported = fromPsdAdjustment(back);
  expect(imported?.filterId).toBe(filterId);
  return imported!.params;
}

describe('PSD adjustment mapping', () => {
  it('maps color balance both ways (through a PSD file)', () => {
    const p = { shadowsR: 10, shadowsG: -20, shadowsB: 30, midR: -40, midG: 50, midB: -60, highR: 70, highG: -80, highB: 90, preserveLuminosity: false };
    expect(roundTrip('color-balance', p, true)).toEqual(p);
  });

  it('maps black & white weights and tint (through a PSD file)', () => {
    const p = { reds: -50, yellows: 120, greens: 40, cyans: 60, blues: 250, magentas: 80, tint: true, tintColor: '#e1c58f' };
    const out = roundTrip('black-white', p, true);
    expect(out).toMatchObject({ reds: -50, yellows: 120, greens: 40, cyans: 60, blues: 250, magentas: 80, tint: true });
    expect(String(out.tintColor).toLowerCase()).toBe('#e1c58f');
  });

  it('maps photo filter color, density and luminosity (through a PSD file)', () => {
    const out = roundTrip('photo-filter', { color: '#ec8a00', density: 0.37, preserveLuminosity: true }, true);
    expect(String(out.color).toLowerCase()).toBe('#ec8a00');
    expect(out.density).toBeCloseTo(0.37, 5);
    expect(out.preserveLuminosity).toBe(true);
  });

  it('maps the channel mixer in color and monochrome mode (through a PSD file)', () => {
    const color = { monochrome: false, rr: 80, rg: 10, rb: 10, gr: -20, gg: 120, gb: 0, br: 5, bg: 5, bb: 90 };
    expect(roundTrip('channel-mixer', color, true)).toEqual(color);
    const mono = roundTrip('channel-mixer', { monochrome: true, rr: 30, rg: 59, rb: 11, gr: 0, gg: 100, gb: 0, br: 0, bg: 0, bb: 100 }, true);
    expect(mono).toMatchObject({ monochrome: true, rr: 30, rg: 59, rb: 11 });
  });

  it('maps selective color ranges and method (through a PSD file)', () => {
    const p: ParamValues = { method: 'absolute' };
    SELECTIVE_RANGES.forEach((r, i) => {
      p[`${r}C`] = i * 3 - 10;
      p[`${r}M`] = i ? -i * 2 : 0;
      p[`${r}Y`] = i * 5;
      p[`${r}K`] = 20 - i;
    });
    expect(roundTrip('selective-color', p, true)).toEqual(p);
  });

  it('maps an opaque gradient map with reverse and dither (through a PSD file)', () => {
    const gradient: Gradient = {
      kind: 'linear',
      angle: 0,
      scale: 1,
      stops: [
        { offset: 0, color: '#1a0800' },
        { offset: 0.55, color: '#d9661a' },
        { offset: 1, color: '#fff2c4' },
      ],
    };
    const out = roundTrip('gradient-map', { gradient, reverse: true, dither: true }, true);
    expect(out.reverse).toBe(true);
    expect(out.dither).toBe(true);
    const stops = (out.gradient as { stops: { offset: number; color: string }[] }).stops;
    expect(stops.map((s) => s.color.toLowerCase())).toEqual(['#1a0800', '#d9661a', '#fff2c4']);
    expect(stops.map((s) => Math.round(s.offset * 100))).toEqual([0, 55, 100]);
  });

  it('writes Hue/Saturation colorize into the colorize fields (through a PSD file)', () => {
    const a = toPsdAdjustment('hue-saturation', { hue: -150, saturation: 0, lightness: -10, colorize: true });
    expect(a?.type).toBe('hue/saturation');
    if (a?.type !== 'hue/saturation') return;
    expect(a.master?.a).toBe(256); // colorize flag byte
    expect(a.master?.b).toBe(210); // hue 0..360
    expect(a.master?.c).toBe(25); // Photoshop's default colorize saturation
    expect(a.master?.d).toBe(-10);
    const out = roundTrip('hue-saturation', { hue: -150, saturation: 0, lightness: -10, colorize: true }, true);
    expect(out).toMatchObject({ colorize: true, hue: -150, saturation: 0, lightness: -10 });
    // Plain hue/saturation keeps working.
    expect(roundTrip('hue-saturation', { hue: 30, saturation: -40, lightness: 5, colorize: false }, true)).toMatchObject({
      hue: 30,
      saturation: -40,
      lightness: 5,
      colorize: false,
    });
  });

  it('converts the colorize saturation scale both ways', () => {
    expect(colorizeSatToPsd(0)).toBeCloseTo(25);
    expect(colorizeSatToPsd(100)).toBeCloseTo(100);
    expect(colorizeSatToPsd(-100)).toBeCloseTo(0);
    for (const v of [-100, -60, 0, 33, 100]) expect(colorizeSatFromPsd(colorizeSatToPsd(v))).toBeCloseTo(v, 6);
  });

  it('still maps the basic tonal adjustments', () => {
    expect(roundTrip('brightness-contrast', { brightness: 20, contrast: -10 }, true)).toEqual({ brightness: 20, contrast: -10 });
    expect(roundTrip('posterize', { levels: 6 }, true)).toEqual({ levels: 6 });
    expect(roundTrip('threshold', { level: 140 }, true)).toEqual({ level: 140 });
  });

  it('returns null for adjustments Photoshop does not have (they are baked instead)', () => {
    for (const id of ['duotone', 'split-toning', 'color-lookup', 'solid-tint', 'vignette', 'halftone']) expect(toPsdAdjustment(id, {})).toBeNull();
    const translucent: ParamValues = {
      gradient: {
        kind: 'linear' as const,
        angle: 0,
        scale: 1,
        stops: [
          { offset: 0, color: '#00000080' },
          { offset: 1, color: '#ffffff' },
        ],
      },
    };
    expect(toPsdAdjustment('gradient-map', translucent)).toBeNull();
  });

  it('ignores noise gradient maps on import', () => {
    expect(fromPsdAdjustment({ type: 'gradient map', gradientType: 'noise' })).toBeNull();
  });
});
