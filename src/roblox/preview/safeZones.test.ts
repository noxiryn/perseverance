import { describe, expect, it } from 'vitest';
import { ICON_CORNER, safeZoneFormat, safeZoneLayout } from './safeZones';

describe('safe zones', () => {
  it('detects the document format', () => {
    expect(safeZoneFormat(512, 512)).toBe('icon');
    expect(safeZoneFormat(1024, 1020)).toBe('icon');
    expect(safeZoneFormat(1920, 1080)).toBe('thumbnail');
    expect(safeZoneFormat(1280, 720)).toBe('thumbnail');
    expect(safeZoneFormat(1000, 400)).toBe('other');
  });

  it('square docs get the rounded icon mask, badge circle and keep box', () => {
    const l = safeZoneLayout(512, 512);
    const mask = l.shapes.find((s) => s.role === 'mask')!;
    expect(mask).toMatchObject({ kind: 'roundRect', dimOutside: true, radius: 512 * ICON_CORNER });
    expect(l.shapes.find((s) => s.role === 'badge')).toMatchObject({ kind: 'circle', rect: { x: 0, y: 0, width: 512, height: 512 } });
    const keep = l.shapes.find((s) => s.role === 'keep')!;
    expect(keep.rect.x).toBeCloseTo(51.2);
    expect(keep.rect.width).toBeCloseTo(409.6);
  });

  it('16:9 docs get the 90% title-safe box, edge margins and UI overlap areas', () => {
    const l = safeZoneLayout(1920, 1080);
    const title = l.shapes.find((s) => s.role === 'title')!;
    expect(title.rect).toEqual({ x: 96, y: 54, width: 1728, height: 972 });
    expect(l.shapes.some((s) => s.role === 'keep')).toBe(true);
    const ui = l.shapes.filter((s) => s.role === 'ui');
    expect(ui.length).toBeGreaterThanOrEqual(3);
    for (const s of ui) {
      expect(s.rect.x).toBeGreaterThanOrEqual(0);
      expect(s.rect.y).toBeGreaterThanOrEqual(0);
      expect(s.rect.x + s.rect.width).toBeLessThanOrEqual(1920 + 1e-6);
      expect(s.rect.y + s.rect.height).toBeLessThanOrEqual(1080 + 1e-6);
    }
  });

  it('other ratios show centered square and 16:9 crops', () => {
    const l = safeZoneLayout(2000, 800);
    const crops = l.shapes.filter((s) => s.role === 'crop');
    expect(crops.length).toBe(2);
    const sq = crops.find((s) => s.kind === 'roundRect')!;
    expect(sq.rect).toMatchObject({ x: 600, y: 0, width: 800, height: 800 });
    const wide = crops.find((s) => s.kind === 'rect')!;
    expect(wide.rect.width / wide.rect.height).toBeCloseTo(16 / 9, 3);
    expect(wide.rect.height).toBe(800);
  });
});
