import { describe, expect, it } from 'vitest';
import { BRUSH_SETTINGS_DEFAULTS, type BrushSettings } from '../options';
import { previewSettings } from './preview';

const s = (o: Partial<BrushSettings>): BrushSettings => ({ ...BRUSH_SETTINGS_DEFAULTS, ...o });

describe('previewSettings', () => {
  it('fits big brushes into the preview height', () => {
    const p = previewSettings(s({ size: 300 }), 132, 30);
    expect(p.size).toBeLessThanOrEqual(15);
    expect(previewSettings(s({ size: 4 }), 132, 30).size).toBe(4);
  });

  it('keeps scattered dabs inside the box', () => {
    const p = previewSettings(s({ size: 50, spacing: 1.6, scatter: 1 }), 72, 40);
    // Max perpendicular scatter offset is 2·scatter·size (computeDab) + half a dab.
    expect(2 * p.scatter * p.size + p.size / 2).toBeLessThanOrEqual(20);
  });

  it('shows several stamps for sparse stamp brushes', () => {
    const p = previewSettings(s({ size: 260, spacing: 0.9 }), 72, 40);
    const stamps = (72 - p.size) / (p.spacing * p.size);
    expect(stamps).toBeGreaterThanOrEqual(4);
  });

  it('leaves dense brushes and unrelated settings untouched', () => {
    const base = s({ size: 10, spacing: 0.1, flow: 0.4, angle: 30, roundness: 0.5, opacity: 0.7 });
    const p = previewSettings(base, 132, 30);
    expect(p).toEqual(base);
  });
});
