/**
 * Contract tests for the built-in asset catalog (ids / param keys from ARCHITECTURE §5.6) and
 * the pure layout helpers of the generators and of placement.
 */
import { describe, expect, it } from 'vitest';
import type { ParamDef } from '../core/types';
import type { AssetDef } from '../registry';
import { BUILTIN_ASSETS, CATEGORY_ORDER } from './catalog';
import { USER_CATEGORY, assetIdOfLayer, assetLayerSize, fitSize } from './place';
import { matchesQuery } from './ui/store';
import { sideMask } from './generators/atmosphere';
import { borderDepth, perimeterPoint } from './generators/torn';
import { curlPoints, tendrilGeometry } from './generators/tendrils';
import { crumpleHeight } from './generators/paper';
import { worleyGrid } from './lib/raster';
import type { WorleyHit } from './lib/raster';
import { makeRand } from './lib/util';

const byId = new Map(BUILTIN_ASSETS.map((a) => [a.id, a]));

/** Required ids (§5.6) → param keys that must exist with exactly these names. */
const REQUIRED: Record<string, string[]> = {
  'paper-texture': ['tone', 'grain', 'fibers', 'seed'],
  'grunge-paper': ['seed'],
  'crumpled-paper': ['seed'],
  'fold-creases': ['folds', 'strength', 'seed'],
  'newspaper-clippings': ['columns', 'tone', 'density', 'rotation', 'seed'],
  concrete: ['seed'],
  cracks: ['seed'],
  'torn-paper-strip': ['seed'],
  'film-scratches': ['density', 'color', 'seed'],
  'dust-specks': ['seed'],
  'film-grain': ['seed'],
  'light-leak': ['seed'],
  'scanlines-overlay': [],
  'vignette-overlay': ['color', 'amount', 'softness'],
  'sunburst-rays': ['rays', 'center', 'color', 'thickness', 'fade'],
  'light-rays': [],
  'lens-flare': [],
  bokeh: ['seed'],
  'glow-orb': [],
  smoke: ['color', 'density', 'scale', 'turbulence', 'coverage', 'side', 'seed'],
  fog: ['seed'],
  clouds: ['seed'],
  'halftone-dots': ['size', 'angle', 'direction', 'color'],
  'speed-lines': [],
  'motion-lines': [],
  'comic-burst': [],
  'manga-screentone': [],
  'torn-border': ['color', 'thickness', 'roughness', 'seed'],
  'film-frame': [],
  'rounded-frame': [],
  'brush-border': [],
  polaroid: [],
  'swirl-tendrils': ['color', 'outlineColor', 'outlineWidth', 'count', 'thickness', 'side', 'seed'],
  thorns: ['seed'],
  chains: [],
  'barbed-wire': [],
  'ornate-corners': [],
  crosses: [],
  'ink-splatter': ['seed'],
  'paint-splatter': ['seed'],
  'brush-strokes': ['seed'],
  'ink-drips': ['seed'],
  'sparks-embers': ['seed'],
  'dust-particles': ['seed'],
  snow: ['seed'],
  rain: ['seed'],
  stars: ['seed'],
  petals: ['seed'],
  'gradient-backdrop': [],
  starfield: ['seed'],
  'brick-wall': [],
  'stone-wall': ['seed'],
  'grid-floor': [],
  'city-silhouette': [],
  'forest-silhouette': [],
  'roblox-studs': [],
  'baseplate-grid': [],
  'obby-checker': [],
};

function paramDefault(d: ParamDef): unknown {
  return d.default;
}

describe('built-in asset catalog', () => {
  it('has 55+ assets with unique ids', () => {
    expect(BUILTIN_ASSETS.length).toBeGreaterThanOrEqual(55);
    expect(byId.size).toBe(BUILTIN_ASSETS.length);
    // looks-templates registers its own 'billow-smoke'
    expect(byId.has('billow-smoke')).toBe(false);
  });

  it.each(Object.entries(REQUIRED))('provides %s with its contract params', (id, keys) => {
    const def = byId.get(id) as AssetDef;
    expect(def, id).toBeDefined();
    const have = new Set(def.params.map((p) => p.key));
    for (const k of keys) expect(have.has(k), `${id}.${k}`).toBe(true);
  });

  it('uses the exact contract defaults where the architecture names them', () => {
    const d = (id: string, key: string) => paramDefault(byId.get(id)!.params.find((p) => p.key === key)!);
    expect(d('paper-texture', 'tone')).toBe('#ece8df');
    expect(d('smoke', 'color')).toBe('#c4141c');
    expect(d('torn-border', 'color')).toBe('#0b0b0b');
    expect(d('swirl-tendrils', 'color')).toBe('#0b0b0b');
    expect(d('swirl-tendrils', 'outlineColor')).toBe('#6f63c9');
    const side = byId.get('smoke')!.params.find((p) => p.key === 'side');
    expect(side?.type).toBe('select');
    if (side?.type === 'select') for (const v of ['left', 'right', 'center', 'full']) expect(side.options.map((o) => o.value)).toContain(v);
    const tSide = byId.get('swirl-tendrils')!.params.find((p) => p.key === 'side');
    if (tSide?.type === 'select') expect(tSide.options.map((o) => o.value)).toEqual(expect.arrayContaining(['both', 'left', 'right']));
    const center = byId.get('sunburst-rays')!.params.find((p) => p.key === 'center');
    expect(center?.type).toBe('point');
  });

  it('every asset is well-formed', () => {
    for (const a of BUILTIN_ASSETS) {
      expect(CATEGORY_ORDER, a.id).toContain(a.category);
      expect(a.category).not.toBe(USER_CATEGORY);
      expect(a.name.length, a.id).toBeGreaterThan(1);
      expect(typeof a.generate).toBe('function');
      if (a.sizing !== 'document') {
        expect(a.sizing.width).toBeGreaterThan(0);
        expect(a.sizing.height).toBeGreaterThan(0);
      }
      if (a.defaultOpacity !== undefined) {
        expect(a.defaultOpacity).toBeGreaterThan(0);
        expect(a.defaultOpacity).toBeLessThanOrEqual(1);
      }
      const keys = new Set<string>();
      for (const p of a.params) {
        expect(keys.has(p.key), `${a.id}: duplicate param ${p.key}`).toBe(false);
        keys.add(p.key);
        if (p.type === 'number') {
          expect(p.default, `${a.id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
          expect(p.default, `${a.id}.${p.key}`).toBeLessThanOrEqual(p.max);
        }
        if (p.type === 'select') expect(p.options.map((o) => o.value), `${a.id}.${p.key}`).toContain(p.default);
        if (p.type === 'color') expect(p.default).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
      }
    }
  });

  it('texture overlays default to sensible blend modes', () => {
    expect(byId.get('paper-texture')!.defaultBlendMode).toBe('multiply');
    expect(['screen', 'overlay', 'lighten', 'linear-dodge']).toContain(byId.get('film-scratches')!.defaultBlendMode);
    expect(byId.get('film-grain')!.defaultBlendMode).toBe('overlay');
  });
});

describe('placement sizing', () => {
  const doc: Pick<AssetDef, 'sizing' | 'category'> = { sizing: 'document', category: 'Overlays' };
  const sticker: Pick<AssetDef, 'sizing' | 'category'> = { sizing: { width: 900, height: 700 }, category: 'Comic & Halftone' };
  const user: Pick<AssetDef, 'sizing' | 'category'> = { sizing: { width: 400, height: 600 }, category: USER_CATEGORY };
  it('fitSize keeps the aspect ratio', () => {
    expect(fitSize(400, 600, 1152, 648)).toEqual({ width: 432, height: 648 });
    expect(fitSize(1000, 10, 100, 100)).toEqual({ width: 100, height: 1 });
  });
  it('document assets cover the canvas, stickers stay within ~55%, user images fit 60%', () => {
    expect(assetLayerSize(doc as AssetDef, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    const s = assetLayerSize(sticker as AssetDef, 1920, 1080);
    expect(s.height).toBeLessThanOrEqual(Math.round(1080 * 0.55));
    expect(s.width / s.height).toBeCloseTo(900 / 700, 1);
    expect(assetLayerSize(sticker as AssetDef, 4000, 4000)).toEqual({ width: 900, height: 700 });
    expect(assetLayerSize(user as AssetDef, 1920, 1080)).toEqual({ width: 432, height: 648 });
    expect(assetLayerSize(sticker as AssetDef, 1920, 1080, { width: 300, height: 200 })).toEqual({ width: 300, height: 200 });
  });
  it('assetIdOfLayer reads only generated raster layers', () => {
    expect(assetIdOfLayer({ type: 'raster', generator: { kind: 'asset:smoke' } })).toBe('smoke');
    expect(assetIdOfLayer({ type: 'raster', generator: { kind: 'rig' } })).toBeNull();
    expect(assetIdOfLayer({ type: 'text' })).toBeNull();
    expect(assetIdOfLayer(null)).toBeNull();
  });
});

describe('library search', () => {
  const def = { id: 'torn-border', name: 'Torn Border', category: 'Borders & Frames' as const, tags: ['burnt', 'gothic'] };
  it('matches every term against name, id, category and tags', () => {
    expect(matchesQuery(def, '')).toBe(true);
    expect(matchesQuery(def, 'torn')).toBe(true);
    expect(matchesQuery(def, 'GOTHIC border')).toBe(true);
    expect(matchesQuery(def, 'frames burnt')).toBe(true);
    expect(matchesQuery(def, 'gothic smoke')).toBe(false);
  });
});

describe('generator layout helpers', () => {
  it('sideMask favours the requested placement', () => {
    expect(sideMask('right', 0.95, 0.6, 0.6, 0, 16 / 9)).toBeGreaterThan(sideMask('right', 0.05, 0.6, 0.6, 0, 16 / 9));
    expect(sideMask('left', 0.05, 0.6, 0.6, 0, 16 / 9)).toBeGreaterThan(sideMask('left', 0.95, 0.6, 0.6, 0, 16 / 9));
    expect(sideMask('center', 0.5, 0.56, 0.5, 0, 1)).toBeGreaterThan(sideMask('center', 0.02, 0.02, 0.5, 0, 1));
    expect(sideMask('full', 0.1, 0.1, 1, 0, 1)).toBeCloseTo(1);
  });
  it('borderDepth is 0 on the border, grows inwards and rounds the corners', () => {
    expect(borderDepth(0, 50, 200, 100, 10)).toBe(0);
    expect(borderDepth(30, 50, 200, 100, 10)).toBe(30);
    expect(borderDepth(100, 50, 200, 100, 10)).toBe(50);
    expect(borderDepth(0, 0, 200, 100, 10)).toBeLessThan(0);
    expect(borderDepth(10, 10, 200, 100, 10)).toBeCloseTo(10);
  });
  it('perimeterPoint walks the border clockwise with inward normals', () => {
    expect(perimeterPoint(0, 200, 100)).toEqual({ x: 0, y: 0, nx: 0, ny: 1 });
    const right = perimeterPoint(250 / 600, 200, 100);
    expect(right.x).toBe(200);
    expect(right.nx).toBe(-1);
    expect(perimeterPoint(1.25, 200, 100)).toEqual(perimeterPoint(0.25, 200, 100));
  });
  it('tendril curls spiral inwards and the ribbon tapers to a point', () => {
    const curl = { cx: 0, cy: 0, R: 100, dir: 1 as const, turns: 1.5, endRatio: 0.3, arrival: -Math.PI / 2 };
    const { pts, gaps } = curlPoints(curl, Math.PI / 12);
    const r0 = Math.hypot(pts[0].x, pts[0].y);
    const r1 = Math.hypot(pts[pts.length - 1].x, pts[pts.length - 1].y);
    expect(r0).toBeCloseTo(100);
    expect(r1).toBeCloseTo(30, 0);
    expect(gaps.every((g) => g > 0)).toBe(true);
    const geo = tendrilGeometry(
      { base: { x: -50, y: 400 }, baseDir: { x: 0.5, y: -0.8 }, curl: { ...curl, cx: 150, cy: 150 }, width: 30, angular: true },
      makeRand(1),
      1,
    );
    expect(geo.pts.length).toBe(geo.widths.length);
    expect(geo.widths[geo.widths.length - 1]).toBe(0);
    expect(Math.min(...geo.widths)).toBeGreaterThanOrEqual(0);
    expect(geo.widths[0]).toBeGreaterThan(geo.widths[geo.spiralStart + 2]);
  });
  it('the crumple height field is continuous (no cliffs at cell borders)', () => {
    const r = makeRand(4);
    const scales = [
      { grid: worleyGrid(300, 300, 80, r.fork(1)), amp: 0.5 },
      { grid: worleyGrid(300, 300, 30, r.fork(2)), amp: 0.3 },
    ];
    const hit: WorleyHit = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 };
    let maxStep = 0;
    for (let y = 20; y < 280; y += 7) {
      let prev = crumpleHeight(scales, 20, y, hit);
      for (let x = 20.5; x < 280; x += 0.5) {
        const h = crumpleHeight(scales, x, y, hit);
        maxStep = Math.max(maxStep, Math.abs(h - prev));
        prev = h;
      }
    }
    // slopes are bounded by the amplitudes (|∇(F2−F1)| ≤ 2): a half-pixel step can't jump more
    expect(maxStep).toBeLessThan(0.5 * 2 * (0.5 * 1.3 + 0.3 * 1.3) * 1.05);
  });
});
