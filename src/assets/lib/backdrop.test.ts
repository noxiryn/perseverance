import { describe, expect, it } from 'vitest';
import type { ParamDef } from '../../core/types';
import { LIGHT_BACKDROP, adaptToBackdrop, darkShade, meanLuminance } from './backdrop';

const rays = { params: [{ key: 'color', label: 'Color', type: 'color', default: '#fff1cc' } as ParamDef] };
const noColor = { params: [] as ParamDef[] };

describe('backdrop-aware placement', () => {
  it('places Screen rays dark in Multiply on a white canvas', () => {
    const a = adaptToBackdrop(rays, { color: '#fff1cc' }, 'screen', 1);
    expect(a.changed).toBe(true);
    expect(a.blendMode).toBe('multiply');
    expect(a.params.color).toBe(darkShade('#fff1cc'));
  });

  it('keeps the default on dark backdrops and for non-light blends', () => {
    expect(adaptToBackdrop(rays, {}, 'screen', 0.1).changed).toBe(false);
    expect(adaptToBackdrop(rays, {}, 'multiply', 1).changed).toBe(false);
    expect(adaptToBackdrop(rays, {}, 'screen', null).changed).toBe(false);
    expect(adaptToBackdrop(rays, {}, 'screen', LIGHT_BACKDROP - 0.01).changed).toBe(false);
  });

  it('respects a colour the user picked and flags colourless assets', () => {
    const picked = adaptToBackdrop(rays, { color: '#ff0000' }, 'screen', 1);
    expect(picked.changed).toBe(false);
    expect(picked.invisible).toBe(true);
    expect(adaptToBackdrop(noColor, {}, 'screen', 1).invisible).toBe(true);
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
});
