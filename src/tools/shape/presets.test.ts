import { describe, expect, it } from 'vitest';
import { SHAPE_PRESETS, SHAPE_PRESET_CATEGORIES } from './presets';
import { arcPoints, fitViewBox, flattenPath, mirrorPts, parsePath, pathBounds, signedArea, starPts, symPath, taperedStroke } from './presets/pathKit';
import { simplifyClosed, smoothClosedPath, traceGrid } from './trace';

describe('shape presets library', () => {
  it('has 70+ presets with unique ids in known categories', () => {
    expect(SHAPE_PRESETS.length).toBeGreaterThanOrEqual(70);
    const ids = new Set(SHAPE_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(SHAPE_PRESETS.length);
    for (const p of SHAPE_PRESETS) expect(SHAPE_PRESET_CATEGORIES as readonly string[]).toContain(p.category);
    for (const c of SHAPE_PRESET_CATEGORIES) expect(SHAPE_PRESETS.some((p) => p.category === c)).toBe(true);
  });

  it('every preset parses and its viewBox tightly fits the geometry', () => {
    for (const p of SHAPE_PRESETS) {
      expect(() => parsePath(p.path), p.id).not.toThrow();
      const [x, y, w, h] = p.viewBox;
      expect(w, p.id).toBeGreaterThan(1);
      expect(h, p.id).toBeGreaterThan(1);
      const b = pathBounds(p.path);
      expect(Math.abs(b.minX - x), p.id).toBeLessThan(0.02);
      expect(Math.abs(b.minY - y), p.id).toBeLessThan(0.02);
      expect(Math.abs(b.maxX - (x + w)), p.id).toBeLessThan(0.02);
      expect(Math.abs(b.maxY - (y + h)), p.id).toBeLessThan(0.02);
      // Reasonable aspect ratios (no degenerate slivers).
      expect(Math.max(w / h, h / w), p.id).toBeLessThan(9);
      for (const n of p.path.match(/-?\d*\.?\d+(e[-+]?\d+)?/gi) ?? []) expect(Number.isFinite(Number(n)), p.id).toBe(true);
    }
  });

  it('has the required named designs', () => {
    const ids = new Set(SHAPE_PRESETS.map((p) => p.id));
    for (const id of [
      'star-5', 'star-6', 'star-8', 'burst-12', 'burst-16', 'burst-24', 'heart', 'diamond', 'hexagon', 'cross-x', 'plus', 'check', 'ring', 'circle-frame',
      'arrow-straight', 'arrow-curved', 'chevron', 'arrow-double', 'arrow-circular',
      'bubble-speech', 'bubble-thought', 'bubble-shout', 'burst-explosion', 'impact-star',
      'spiral-swirl', 'scroll-flourish', 'fleur-de-lis', 'gothic-arch', 'ornate-corner', 'divider-flourish', 'thorn-vine', 'crescent-moon', 'gothic-cross',
      'sword', 'crossed-swords', 'katana', 'shield', 'axe', 'dagger', 'crown', 'skull', 'flame', 'lightning-bolt', 'wings', 'claw-slash', 'blood-drop', 'gem', 'potion',
      'ribbon-banner', 'badge-shield', 'tag', 'starburst-badge', 'play-button', 'trophy', 'coin', 'heart-health', 'energy-bolt',
      'blocky-character', 'brick-studs', 'cube',
      'leaf', 'cloud', 'sun', 'snowflake', 'wave', 'tree',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe('pathKit', () => {
  it('parses relative commands, shorthand curves and implicit linetos', () => {
    const cmds = parsePath('m10 10 20 0 v10 h-20 z M0 0 c 10 0 10 10 0 10 s -10 -10 0 -10 q5 5 10 0 t 10 0');
    expect(cmds[0]).toEqual({ c: 'M', x: 10, y: 10 });
    expect(cmds[1]).toEqual({ c: 'L', x: 30, y: 10 });
    expect(cmds[2]).toEqual({ c: 'L', x: 30, y: 20 });
    expect(cmds[3]).toEqual({ c: 'L', x: 10, y: 20 });
    const s = cmds.find((c, i) => c.c === 'C' && i > 6);
    expect(s).toMatchObject({ c: 'C', x1: -10, y1: 10 });
    expect(() => parsePath('M0 0 L 10')).toThrow();
    expect(() => parsePath('M0 0 X 10 10')).toThrow();
  });

  it('accepts glued arc flags', () => {
    const a = parsePath('M0 0A10 10 0 1110 10');
    expect(a[1]).toMatchObject({ c: 'A', large: true, sweep: true, x: 10, y: 10 });
  });

  it('computes arc and circle bounds', () => {
    const b = pathBounds('M0 50A50 50 0 1 1 100 50A50 50 0 1 1 0 50Z');
    expect(b.minX).toBeCloseTo(0, 1);
    expect(b.maxX).toBeCloseTo(100, 1);
    expect(b.minY).toBeCloseTo(0, 1);
    expect(b.maxY).toBeCloseTo(100, 1);
    const half = arcPoints(0, 50, { c: 'A', rx: 50, ry: 50, rot: 0, large: false, sweep: true, x: 100, y: 50 });
    // Clockwise half circle from left to right passes over the top (y < 50).
    expect(Math.min(...half.map((p) => p[1]))).toBeCloseTo(0, 1);
  });

  it('fits a viewBox to curves (not just control points)', () => {
    const vb = fitViewBox('M0 0C0 -100 100 -100 100 0Z');
    expect(vb[1]).toBeCloseTo(-75, 0);
    expect(vb[3]).toBeCloseTo(75, 0);
  });

  it('mirrors symmetric outlines', () => {
    const d = symPath([50, 0], [['L', 100, 50], ['L', 50, 100]], 50);
    const pts = flattenPath(d)[0];
    expect(pts.map((p) => p.map(Math.round))).toEqual([
      [50, 0],
      [100, 50],
      [50, 100],
      [0, 50],
    ]);
    expect(mirrorPts([[5, 0], [10, 5], [5, 10]], 5)).toEqual([[5, 0], [10, 5], [5, 10], [0, 5]]);
  });

  it('builds stars and clockwise tapered strokes', () => {
    const s = starPts(5, 0, 0, 10, 4);
    expect(s.length).toBe(10);
    expect(s[0][0]).toBeCloseTo(0);
    expect(s[0][1]).toBeCloseTo(-10);
    const t = taperedStroke([[0, 0], [10, 0], [20, 0]], () => 4);
    expect(signedArea(t)).toBeGreaterThan(0);
    expect(Math.abs(signedArea(t))).toBeCloseTo(80, 3);
  });
});

describe('traceGrid', () => {
  it('traces a filled block as one clockwise square', () => {
    const loops = traceGrid(3, 3, () => true);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toEqual([[0, 0], [3, 0], [3, 3], [0, 3]]);
    expect(signedArea(loops[0])).toBeGreaterThan(0);
  });

  it('traces holes counter-clockwise', () => {
    const loops = traceGrid(3, 3, (x, y) => !(x === 1 && y === 1));
    expect(loops).toHaveLength(2);
    const areas = loops.map(signedArea).sort((a, b) => a - b);
    expect(areas[0]).toBe(-1);
    expect(areas[1]).toBe(9);
  });

  it('keeps diagonally touching cells as separate loops', () => {
    const loops = traceGrid(2, 2, (x, y) => x === y);
    expect(loops).toHaveLength(2);
    for (const l of loops) expect(signedArea(l)).toBe(1);
  });

  it('simplifies and smooths closed polygons', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 64; i++) pts.push([Math.cos((i / 64) * Math.PI * 2) * 50, Math.sin((i / 64) * Math.PI * 2) * 50]);
    const simple = simplifyClosed(pts, 0.5);
    expect(simple.length).toBeLessThan(40);
    expect(simple.length).toBeGreaterThan(8);
    const d = smoothClosedPath(simple);
    expect(() => parsePath(d)).not.toThrow();
    expect(d.includes('Q')).toBe(true);
  });
});
