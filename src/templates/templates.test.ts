import { describe, expect, it } from 'vitest';
import { burstPath, fitFontSize, scaleBox, segmentTransform } from './layout';
import { darken, lighten, shadeSmoke, sideMask, smokeField, smoothstep } from './paint';
import { BILLOW_SMOKE_PARAMS, smokeOptionsFromParams } from './smokeAsset';
import { DOC_PRESETS } from './presets';
import { REFERENCE_TEMPLATES } from './reference';
import { EXTRA_TEMPLATES } from './extra';
import { BLANK_TEMPLATES } from './blank';

describe('layout helpers', () => {
  it('fitFontSize scales the font proportionally to the target width', () => {
    expect(fitFontSize(100, 500, 250)).toBe(50);
    expect(fitFontSize(100, 200, 400)).toBe(200);
    expect(fitFontSize(100, 200, 400, 150)).toBe(150);
    // degenerate measurements leave the size alone; never below 4px
    expect(fitFontSize(80, 0, 300)).toBe(80);
    expect(fitFontSize(80, 300, 0)).toBe(80);
    expect(fitFontSize(80, 100000, 1)).toBe(4);
  });

  it('segmentTransform centers a rotated box on the segment', () => {
    const t = segmentTransform(0, 0, 100, 0, 10);
    expect(t).toMatchObject({ x: 0, y: -5, width: 100, height: 10, rotation: 0 });
    const d = segmentTransform(0, 0, 100, 100, 4);
    expect(d.width).toBeCloseTo(Math.SQRT2 * 100, 6);
    expect(d.rotation).toBeCloseTo(45, 6);
    // box center = segment midpoint
    expect(d.x + d.width / 2).toBeCloseTo(50, 6);
    expect(d.y + d.height / 2).toBeCloseTo(50, 6);
    // never zero-sized
    expect(segmentTransform(5, 5, 5, 5, 0).width).toBeGreaterThan(0);
  });

  it('burstPath emits 2×points vertices, deterministic per seed', () => {
    const p = burstPath(12, 0.6, 1000, 0.1, 3);
    expect(p.startsWith('M')).toBe(true);
    expect(p.trim().endsWith('Z')).toBe(true);
    expect((p.match(/[ML]/g) ?? []).length).toBe(24);
    expect(burstPath(12, 0.6, 1000, 0.1, 3)).toBe(p);
    expect(burstPath(12, 0.6, 1000, 0.1, 4)).not.toBe(p);
    // without jitter all outer points sit on the circle
    const pts = [...burstPath(8, 0.5, 200).matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map((m) => [Number(m[1]) - 100, Number(m[2]) - 100]);
    expect(Math.hypot(pts[0][0], pts[0][1])).toBeCloseTo(100, 0);
    expect(Math.hypot(pts[1][0], pts[1][1])).toBeCloseTo(50, 0);
  });

  it('scaleBox scales about the origin', () => {
    expect(scaleBox({ x: 10, y: 20, width: 30, height: 40 }, 0.5)).toEqual({ x: 5, y: 10, width: 15, height: 20 });
  });
});

describe('procedural smoke', () => {
  it('smoothstep clamps and eases', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('sideMask favours the requested side', () => {
    expect(sideMask('right', 0.95, 0.5, 0.6, 0, 1.78)).toBeGreaterThan(sideMask('right', 0.05, 0.5, 0.6, 0, 1.78));
    expect(sideMask('left', 0.05, 0.5, 0.6, 0, 1.78)).toBeGreaterThan(sideMask('left', 0.95, 0.5, 0.6, 0, 1.78));
    expect(sideMask('bottom', 0.5, 0.95, 0.5, 0, 1.78)).toBeGreaterThan(sideMask('bottom', 0.5, 0.05, 0.5, 0, 1.78));
    expect(sideMask('center', 0.5, 0.55, 0.5, 0, 1)).toBeGreaterThan(sideMask('center', 0.02, 0.02, 0.5, 0, 1));
  });

  it('smokeField is deterministic, bounded and placed on its side', () => {
    const fw = 96;
    const fh = 54;
    const a = smokeField(fw, fh, { color: '#c4141c', side: 'right', coverage: 0.5, seed: 3 });
    const b = smokeField(fw, fh, { color: '#c4141c', side: 'right', coverage: 0.5, seed: 3 });
    expect(a).toEqual(b);
    let left = 0;
    let right = 0;
    for (let j = 0; j < fh; j++)
      for (let i = 0; i < fw; i++) {
        const v = a[j * fw + i];
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        if (i < fw / 4) left += v;
        if (i >= (fw * 3) / 4) right += v;
      }
    expect(right).toBeGreaterThan(left * 4);
    const other = smokeField(fw, fh, { color: '#c4141c', side: 'right', coverage: 0.5, seed: 4 });
    expect(other).not.toEqual(a);
  });

  it('shadeSmoke leaves empty field transparent and tints dense smoke', () => {
    const field = new Float32Array([0, 0.5, 1, 0]);
    const data = new Uint8ClampedArray(16);
    shadeSmoke(field, 2, 2, { color: '#c4141c', density: 1 }, data);
    expect(data[3]).toBe(0);
    expect(data[15]).toBe(0);
    expect(data[7]).toBeGreaterThan(0);
    expect(data[11]).toBe(255);
    // red smoke stays red-dominant
    expect(data[8]).toBeGreaterThan(data[9]);
  });

  it('darken/lighten mix towards black/white', () => {
    expect(darken('#ff8040', 0)).toBe('#ff8040');
    expect(darken('#ff8040', 1)).toBe('#000000');
    expect(lighten('#ff8040', 1)).toBe('#ffffff');
    expect(lighten('#000000', 0.5)).toBe('#808080');
    expect(darken('#fff', 0.5)).toBe('#808080');
  });

  it('smoke asset params map to painter options with safe fallbacks', () => {
    const d = smokeOptionsFromParams({});
    expect(d).toMatchObject({ color: '#c4141c', side: 'right', coverage: 0.6, seed: 7 });
    const o = smokeOptionsFromParams({ side: 'bogus', coverage: Number.NaN, color: '#00ff00', seed: 9 });
    expect(o.side).toBe('right');
    expect(o.coverage).toBe(0.6);
    expect(o.color).toBe('#00ff00');
    expect(o.seed).toBe(9);
    expect(new Set(BILLOW_SMOKE_PARAMS.map((p) => p.key)).size).toBe(BILLOW_SMOKE_PARAMS.length);
  });
});

describe('doc presets', () => {
  const byName = (n: string, cat: string) => DOC_PRESETS.find((p) => p.name === n && p.category === cat);

  it('have unique ids and positive sizes', () => {
    expect(new Set(DOC_PRESETS.map((p) => p.id)).size).toBe(DOC_PRESETS.length);
    for (const p of DOC_PRESETS) {
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
      expect(['Roblox', 'Social', 'Video', 'Print', 'Common']).toContain(p.category);
    }
  });

  it('cover the required formats', () => {
    const want: [string, number, number][] = [
      ['Roblox', 512, 512],
      ['Roblox', 1024, 1024],
      ['Roblox', 1920, 1080],
      ['Roblox', 1280, 720],
      ['Roblox', 728, 90],
      ['Roblox', 160, 600],
      ['Roblox', 300, 250],
      ['Roblox', 585, 559],
      ['Social', 1280, 720],
      ['Social', 960, 540],
      ['Social', 1500, 500],
      ['Social', 1080, 1080],
      ['Social', 1080, 1920],
      ['Video', 1920, 1080],
      ['Video', 3840, 2160],
      ['Print', 2480, 3508],
      ['Common', 1000, 1000],
      ['Common', 2048, 2048],
    ];
    for (const [cat, w, h] of want) expect(DOC_PRESETS.some((p) => p.category === cat && p.width === w && p.height === h), `${cat} ${w}x${h}`).toBe(true);
    expect(DOC_PRESETS.filter((p) => p.category === 'Roblox').length).toBeGreaterThanOrEqual(14);
    expect(byName('T-Shirt', 'Roblox')).toMatchObject({ width: 512, height: 512 });
    expect(byName('YouTube Thumbnail', 'Social')).toMatchObject({ width: 1280, height: 720 });
  });
});

describe('template catalog', () => {
  const all = [...REFERENCE_TEMPLATES, ...EXTRA_TEMPLATES, ...BLANK_TEMPLATES];

  it('has the required templates with the reference sizes', () => {
    const get = (id: string) => all.find((t) => t.id === id);
    expect(get('tpl-gothic-paper')).toMatchObject({ width: 1024, height: 1024 });
    expect(get('tpl-sunburst-icon')).toMatchObject({ width: 512, height: 512 });
    expect(get('tpl-noir-thumbnail')).toMatchObject({ width: 1920, height: 1080 });
    expect(get('tpl-crimson-thumbnail')).toMatchObject({ width: 1920, height: 1080 });
    for (const id of ['tpl-versus', 'tpl-update-banner', 'tpl-simulator-bright', 'tpl-horror', 'tpl-anime-action', 'tpl-showcase', 'tpl-group-banner']) expect(get(id), id).toBeTruthy();
    expect(all.filter((t) => t.category !== 'Blank').length).toBeGreaterThanOrEqual(12);
    expect(BLANK_TEMPLATES.length).toBeGreaterThanOrEqual(4);
  });

  it('ids are unique, metadata complete, categories valid', () => {
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    for (const t of all) {
      expect(['Thumbnail', 'Icon', 'Banner', 'Social', 'Blank']).toContain(t.category);
      expect(t.name.length).toBeGreaterThan(2);
      expect(t.description?.length ?? 0).toBeGreaterThan(10);
      expect(t.width).toBeGreaterThan(0);
      expect(t.height).toBeGreaterThan(0);
      expect(typeof t.build).toBe('function');
    }
  });
});
