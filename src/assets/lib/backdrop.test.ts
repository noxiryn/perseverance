import { describe, expect, it } from 'vitest';
import type { ParamDef } from '../../core/types';
import { LIGHT_BACKDROP, MAX_ADAPTED_COVERAGE, adaptToBackdrop, darkShade, meanAlpha, meanLuminance } from './backdrop';
import { assetMeta } from './params';
import { BUILTIN_ASSETS } from '../catalog';
import { LIGHT_ONLY_BLENDS } from './backdrop';

const rays = { params: [{ key: 'color', label: 'Color', type: 'color', default: '#fff1cc' } as ParamDef] };
const noColor = { params: [] as ParamDef[] };
const lightVariant = {};
/** Film-scratches-like asset: light scratches over an opaque black base. */
const scratches = {
  params: [
    { key: 'color', label: 'Scratch color', type: 'color', default: '#f2f2f2' } as ParamDef,
    { key: 'background', label: 'Black film base', type: 'boolean', default: true } as ParamDef,
  ],
};
const scratchVariant = { params: { background: false }, note: 'without the black film base' };

describe('backdrop-aware placement', () => {
  it('places Screen rays dark in Multiply on a white canvas', () => {
    const a = adaptToBackdrop(rays, { color: '#fff1cc' }, 'screen', 1, lightVariant);
    expect(a.changed).toBe(true);
    expect(a.blendMode).toBe('multiply');
    expect(a.params.color).toBe(darkShade('#fff1cc'));
  });

  it('keeps the default on dark backdrops and for non-light blends', () => {
    expect(adaptToBackdrop(rays, {}, 'screen', 0.1, lightVariant).changed).toBe(false);
    expect(adaptToBackdrop(rays, {}, 'multiply', 1, lightVariant).changed).toBe(false);
    expect(adaptToBackdrop(rays, {}, 'screen', null, lightVariant).changed).toBe(false);
    expect(adaptToBackdrop(rays, {}, 'screen', LIGHT_BACKDROP - 0.01, lightVariant).changed).toBe(false);
  });

  it('respects a colour the user picked and flags colourless assets', () => {
    const picked = adaptToBackdrop(rays, { color: '#ff0000' }, 'screen', 1, lightVariant);
    expect(picked.changed).toBe(false);
    expect(picked.invisible).toBe(true);
    expect(adaptToBackdrop(noColor, {}, 'screen', 1, lightVariant).invisible).toBe(true);
  });

  it('only adapts assets that declare a light-backdrop variant (glows, flares only get a hint)', () => {
    const a = adaptToBackdrop(rays, { color: '#fff1cc' }, 'screen', 1);
    expect(a.changed).toBe(false);
    expect(a.invisible).toBe(true);
    expect(a.blendMode).toBe('screen');
  });

  it('turns off an opaque base when switching to Multiply (Film Scratches on white)', () => {
    const a = adaptToBackdrop(scratches, { color: '#f2f2f2', background: true }, 'screen', 1, scratchVariant);
    expect(a.changed).toBe(true);
    expect(a.blendMode).toBe('multiply');
    expect(a.params.background).toBe(false);
    expect(a.note).toBe('without the black film base');
    // without the variant's override, an opaque base would black out the canvas: never adapt blindly
    const plain = adaptToBackdrop(scratches, { color: '#f2f2f2', background: true }, 'screen', 1);
    expect(plain.changed).toBe(false);
  });

  it('keeps a non-default value the user chose for a param the variant overrides', () => {
    const custom = { params: [...scratches.params, { key: 'mode', label: 'Mode', type: 'select', default: 'a', options: [] } as unknown as ParamDef] };
    const a = adaptToBackdrop(custom, { color: '#f2f2f2', background: true, mode: 'b' }, 'screen', 1, { params: { mode: 'c' } });
    expect(a.changed).toBe(false);
    expect(a.invisible).toBe(true);
  });

  it('meanAlpha measures coverage', () => {
    expect(meanAlpha(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]))).toBeCloseTo(0.5);
    expect(meanAlpha(new Uint8ClampedArray(0))).toBe(0);
    expect(MAX_ADAPTED_COVERAGE).toBeLessThan(0.6);
  });

  it('dark shades keep the hue and are dark', () => {
    const d = darkShade('#fff1cc');
    const n = parseInt(d.slice(1), 16);
    const r = (n >> 16) & 255,
      g = (n >> 8) & 255,
      b = n & 255;
    expect(r).toBeGreaterThan(b); // still warm
    expect(Math.max(r, g, b)).toBeLessThan(110);
  });

  it('meanLuminance weights transparency with the fallback', () => {
    const white = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
    expect(meanLuminance(white)).toBeCloseTo(1);
    const clear = new Uint8ClampedArray([0, 0, 0, 0]);
    expect(meanLuminance(clear, 0)).toBe(0);
    expect(meanLuminance(clear, 1)).toBe(1);
  });

  it('the catalog opts light overlays in, never assets with an opaque base left on', () => {
    const byId = new Map(BUILTIN_ASSETS.map((a) => [a.id, a]));
    for (const id of ['sunburst-rays', 'light-rays', 'stars', 'dust-specks', 'film-scratches']) expect(assetMeta.get(id)?.onLight, id).toBeTruthy();
    for (const id of ['glow-orb', 'lens-flare', 'bokeh']) expect(assetMeta.get(id)?.onLight, id).toBeFalsy();
    const film = byId.get('film-scratches')!;
    const defaults = Object.fromEntries(film.params.map((p) => [p.key, p.default]));
    const a = adaptToBackdrop(film, defaults, film.defaultBlendMode ?? 'normal', 1, assetMeta.get('film-scratches')?.onLight);
    expect(a.changed).toBe(true);
    expect(a.params.background).toBe(false);
    // every opted-in asset is light-only by default and has the color param its variant darkens
    for (const def of BUILTIN_ASSETS) {
      const v = assetMeta.get(def.id)?.onLight;
      if (!v) continue;
      expect(LIGHT_ONLY_BLENDS.has(def.defaultBlendMode ?? 'normal'), def.id).toBe(true);
      expect(def.params.some((p) => p.key === (v.colorKey ?? 'color') && p.type === 'color'), def.id).toBe(true);
    }
  });
});
