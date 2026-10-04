import { describe, expect, it } from 'vitest';
import { layoutText, lineIndexForCaret, wrapParagraph, type Measure } from './textLayout';
import { diamondQuadrants, diamondT, gradientGeometry, normalizedStops, reflectedStops } from './gradientMath';
import { isWarpActive, warpPoint } from './warpMath';
import { edgeDistance, signedEdgeDistance } from './distance';
import { bevelMaps, bevelProfile, longShadowFade, shadeSplit, strokeCoverage } from './effects/math';
import { fitToBox, linePolygon, polygonPoints, roundedPolygonOps, starPoints } from './shapeGeometry';
import { PixelLRU, SlotCache, objId } from './cache';
import { maskLUT, maskValue } from './mask';
import { alignedOrigin } from './text';
import { coverRect, expandRect, intersectRect, unionRect } from './surface';
import { buildGrid, warpImage } from './meshWarp';

describe('mesh warp', () => {
  /** Opaque w×h image whose red channel encodes x and green encodes y. */
  function ramp(w: number, h: number): Uint8ClampedArray {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        d[o] = x * 8;
        d[o + 1] = y * 8;
        d[o + 3] = 255;
      }
    return d;
  }

  it('identity mesh reproduces the image exactly', () => {
    const w = 24,
      h = 16;
    const src = ramp(w, h);
    const dst = new Uint8ClampedArray(src.length);
    warpImage(src, w, h, dst, w, h, buildGrid(w, h, 5, 3, (x, y) => [x, y]));
    expect(Array.from(dst)).toEqual(Array.from(src));
  });

  it('a strongly non-linear warp leaves no uncovered pixels (seamless)', () => {
    const w = 64,
      h = 32;
    const src = new Uint8ClampedArray(w * h * 4).fill(255);
    const dw = 90,
      dh = 70;
    const grid = buildGrid(w, h, 9, 5, (x, y) => [x + 12 + 6 * Math.sin(y / 5), y + 18 + 14 * Math.sin(x / 9)]);
    const dst = new Uint8ClampedArray(dw * dh * 4);
    warpImage(src, w, h, dst, dw, dh, grid);
    // Every destination pixel whose center lies well inside the warped image must be opaque.
    let holes = 0;
    for (let y = 0; y < dh; y++)
      for (let x = 0; x < dw; x++) {
        const sx = x + 0.5 - 12;
        if (sx < 8 || sx > w - 8) continue; // x shift is at most ±6
        const top = 18 + 14 * Math.sin(sx / 9);
        if (y + 0.5 < top + 11 || y + 0.5 > top + h - 11) continue; // y offset varies ≤ 9.4 over ±6 px
        if (dst[(y * dw + x) * 4 + 3] < 250) holes++;
      }
    expect(holes).toBe(0);
  });

  it('translation shifts the content and samples bilinearly in premultiplied space', () => {
    const w = 4,
      h = 1;
    const src = new Uint8ClampedArray(w * h * 4);
    // one opaque red pixel next to a transparent (black) one
    src.set([255, 0, 0, 255], 0);
    const dst = new Uint8ClampedArray(src.length);
    warpImage(src, w, h, dst, w, h, buildGrid(w, h, 2, 1, (x, y) => [x + 0.5, y]));
    // half-pixel shift: pixel 0 = 50% of red at (0) and nothing on the left; colour stays pure red
    expect(dst[0]).toBe(255);
    expect(dst[3]).toBeGreaterThan(120);
    expect(dst[3]).toBeLessThan(135);
    expect(dst[4]).toBe(255); // pixel 1: half red, half transparent → still pure red, never darkened
    expect(dst[5]).toBe(0);
  });
});

/** Monospace fake measure: every code unit is 10px wide. */
const mono: Measure = (s) => s.length * 10;

describe('text layout', () => {
  it('lays out point text by hard breaks only', () => {
    const r = layoutText({ content: 'Hello\nWorld!!', boxWidth: null, align: 'left', lineHeight: 20, ascent: 14, descent: 4 }, mono);
    expect(r.lines.map((l) => l.text)).toEqual(['Hello', 'World!!']);
    expect(r.width).toBe(70);
    expect(r.height).toBe(40);
    expect(r.lines[1].y).toBe(20);
    // ascent centered in the line box: (20 - 18) / 2 + 14 = 15
    expect(r.lines[0].baseline).toBe(15);
    expect(r.ascent).toBe(15);
  });

  it('wraps paragraph text at word boundaries', () => {
    const r = layoutText({ content: 'the quick brown fox', boxWidth: 100, align: 'left', lineHeight: 10, ascent: 8, descent: 2 }, mono);
    expect(r.lines.map((l) => l.text)).toEqual(['the quick', 'brown fox']);
    expect(r.width).toBe(100);
    // contiguous ranges (the breaking space stays with the first line)
    expect(r.lines[0].start).toBe(0);
    expect(r.lines[0].end).toBe(10);
    expect(r.lines[1].start).toBe(10);
    expect(r.lines[1].end).toBe(19);
  });

  it('breaks words longer than the box between characters', () => {
    const lines = wrapParagraph('abcdefghij', 0, 10, 40, mono);
    expect(lines.map((l) => l.text)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('aligns lines inside the box', () => {
    const center = layoutText({ content: 'ab\nabcd', boxWidth: null, align: 'center', lineHeight: 10, ascent: 8, descent: 2 }, mono);
    expect(center.lines[0].x).toBe(10);
    expect(center.lines[1].x).toBe(0);
    const right = layoutText({ content: 'ab', boxWidth: 100, align: 'right', lineHeight: 10, ascent: 8, descent: 2 }, mono);
    expect(right.lines[0].x).toBe(80);
  });

  it('keeps empty lines and trailing newlines', () => {
    const r = layoutText({ content: 'a\n\nb\n', boxWidth: null, align: 'left', lineHeight: 10, ascent: 8, descent: 2 }, mono);
    expect(r.lines.map((l) => l.text)).toEqual(['a', '', 'b', '']);
    expect(r.height).toBe(40);
  });

  it('maps caret indices to lines (soft-wrap boundary belongs to the next line)', () => {
    const r = layoutText({ content: 'the quick brown fox', boxWidth: 100, align: 'left', lineHeight: 10, ascent: 8, descent: 2 }, mono);
    expect(lineIndexForCaret(r.lines, 0)).toBe(0);
    expect(lineIndexForCaret(r.lines, 9)).toBe(0);
    expect(lineIndexForCaret(r.lines, 10)).toBe(1);
    expect(lineIndexForCaret(r.lines, 19)).toBe(1);
    const p = layoutText({ content: 'ab\ncd', boxWidth: null, align: 'left', lineHeight: 10, ascent: 8, descent: 2 }, mono);
    expect(lineIndexForCaret(p.lines, 2)).toBe(0);
    expect(lineIndexForCaret(p.lines, 3)).toBe(1);
  });

  it('aligned origins put canvas pixel 0 on an integer device pixel', () => {
    for (const f of [0, 0.25, 0.5, 0.9]) {
      for (const k of [1, 2, 0.5]) {
        const ox = alignedOrigin(-7, k, f);
        expect(ox).toBeLessThanOrEqual(-7 + 1e-9);
        const dev = k * ox + f;
        expect(Math.abs(dev - Math.round(dev))).toBeLessThan(1e-9);
      }
    }
  });
});

describe('gradient math', () => {
  const box = { x: 0, y: 0, width: 200, height: 100 };
  it('linear gradient spans the box along its angle', () => {
    const g = gradientGeometry({ kind: 'linear', angle: 0, scale: 1, stops: [] }, box);
    expect(g).toMatchObject({ kind: 'linear', x0: 0, y0: 50, x1: 200, y1: 50 });
    const v = gradientGeometry({ kind: 'linear', angle: 90, scale: 0.5, stops: [] }, box);
    if (v.kind !== 'linear') throw new Error('kind');
    expect(v.y0).toBeCloseTo(25);
    expect(v.y1).toBeCloseTo(75);
  });

  it('offsets move the center by fractions of the half size', () => {
    const g = gradientGeometry({ kind: 'radial', angle: 0, scale: 1, stops: [], offsetX: 1, offsetY: -1 }, box);
    expect(g).toMatchObject({ kind: 'radial', cx: 200, cy: 0 });
  });

  it('normalizes, reverses and mirrors stops', () => {
    const stops = normalizedStops({ stops: [{ offset: 1, color: '#fff' }, { offset: 0.2, color: '#000' }], reverse: true });
    expect(stops.map((s) => s.offset)).toEqual([0, 0.8]);
    expect(stops[0].color).toBe('#fff');
    const r = reflectedStops([{ offset: 0, color: 'a' }, { offset: 1, color: 'b' }]);
    expect(r.map((s) => [s.offset, s.color])).toEqual([
      [0, 'b'],
      [0.5, 'a'],
      [0.5, 'a'],
      [1, 'b'],
    ]);
  });

  it('diamond quadrants reproduce t = (|u| + |v|) / r', () => {
    const geom = { cx: 50, cy: 40, r: 30, theta: 0.4 };
    const quads = diamondQuadrants(geom, 500);
    const pts = [
      [60, 45],
      [30, 20],
      [80, 70],
      [45, 70],
    ];
    for (const [x, y] of pts) {
      const t = diamondT(geom, x, y);
      // the quadrant whose linear gradient yields the max t is the one containing the point
      const ts = quads.map((q) => {
        const dx = q.x1 - q.x0;
        const dy = q.y1 - q.y0;
        return ((x - q.x0) * dx + (y - q.y0) * dy) / (dx * dx + dy * dy);
      });
      expect(Math.max(...ts)).toBeCloseTo(t, 6);
    }
  });
});

describe('warp', () => {
  const w = (style: 'arc' | 'flag' | 'bulge' | 'none', bend: number) => ({ style, bend, horizontal: 0, vertical: 0 });
  it('is inactive for none / zero amounts', () => {
    expect(isWarpActive(w('none', 50))).toBe(false);
    expect(isWarpActive(w('arc', 0))).toBe(false);
    expect(isWarpActive(w('arc', 30))).toBe(true);
  });
  it('arc keeps the center fixed and lifts the ends for positive bend', () => {
    const c = warpPoint(w('arc', 50), 0, 0, 100, 20);
    expect(c[0]).toBeCloseTo(0);
    expect(c[1]).toBeCloseTo(0);
    const end = warpPoint(w('arc', 50), 100, 0, 100, 20);
    expect(end[1]).toBeGreaterThan(5); // ends drop below the center (arc bulges up)
    const sym = warpPoint(w('arc', 50), -100, 0, 100, 20);
    expect(sym[0]).toBeCloseTo(-end[0]);
    expect(sym[1]).toBeCloseTo(end[1]);
  });
  it('bulge grows the middle and leaves the ends', () => {
    expect(warpPoint(w('bulge', 50), 0, 10, 100, 20)[1]).toBeGreaterThan(10);
    expect(warpPoint(w('bulge', 50), 100, 10, 100, 20)[1]).toBeCloseTo(10);
  });
});

/** A disc of radius R centered in a w×h coverage map (binary). */
function disc(w: number, h: number, R: number): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) <= R ? 255 : 0;
  return a;
}

describe('distance transform & strokes', () => {
  it('measures distance to a straight edge', () => {
    const w = 20,
      h = 5;
    const a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < 10; x++) a[y * w + x] = 255;
    const d = edgeDistance(a, w, h, 'outside');
    // pixel 10's center is 0.5 px from the edge at x = 10
    expect(d[2 * w + 10]).toBeCloseTo(0.5, 5);
    expect(d[2 * w + 14]).toBeCloseTo(4.5, 5);
    expect(d[2 * w + 5]).toBe(0);
    const sd = signedEdgeDistance(a, w, h);
    expect(sd[2 * w + 8]).toBeCloseTo(-1.5, 5);
  });

  it('outside stroke dilates by its size (round)', () => {
    const w = 64,
      h = 64;
    const a = disc(w, h, 10);
    const cov = strokeCoverage(a, w, h, 6, 'outside');
    const at = (r: number) => cov[(h / 2) * w + Math.floor(w / 2 + r)];
    expect(at(0)).toBe(255);
    expect(at(14)).toBe(255);
    expect(at(19)).toBe(0);
    // diagonal reach matches the horizontal one (round joins)
    const d = Math.floor(14 / Math.SQRT2);
    expect(cov[(h / 2 + d) * w + (w / 2 + d)]).toBe(255);
  });

  it('inside and center strokes are bands', () => {
    const w = 64,
      h = 64;
    const a = disc(w, h, 20);
    const inside = strokeCoverage(a, w, h, 4, 'inside');
    const row = (h / 2) * w;
    expect(inside[row + w / 2]).toBe(0); // center untouched
    expect(inside[row + w / 2 + 18]).toBe(255); // within 4px of the edge
    const center = strokeCoverage(a, w, h, 6, 'center');
    expect(center[row + w / 2 + 21]).toBe(255);
    expect(center[row + w / 2 + 25]).toBe(0);
    expect(center[row + w / 2]).toBe(0);
  });

  it('long shadow fades linearly over its length', () => {
    const w = 60,
      h = 3;
    const a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) a[y * w] = 255;
    const v = longShadowFade(a, w, h, 1, 0, 40);
    expect(v[w + 0]).toBe(255);
    expect(v[w + 20]).toBeGreaterThan(120);
    expect(v[w + 20]).toBeLessThan(135);
    expect(v[w + 45]).toBe(0);
  });

  it('bevel lights edges facing the light and shades the opposite ones', () => {
    const w = 64,
      h = 64;
    const a = disc(w, h, 24);
    const { hi, sh } = bevelMaps(a, w, h, { size: 8, depth: 1, angle: 120, altitude: 30, style: 'inner', soften: 0 });
    const tl = (h / 2 - 15) * w + (w / 2 - 15); // top-left rim
    const br = (h / 2 + 15) * w + (w / 2 + 15); // bottom-right rim
    expect(hi[tl]).toBeGreaterThan(100);
    expect(sh[tl]).toBe(0);
    expect(sh[br]).toBeGreaterThan(100);
    expect(hi[(h / 2) * w + w / 2]).toBe(0); // flat top
    expect(bevelProfile(0)).toBe(0);
    expect(bevelProfile(1)).toBe(1);
    const [hv, sv] = shadeSplit(0, 0, 0, 0, 0.5);
    expect(hv).toBe(0);
    expect(sv).toBe(0);
  });
});

describe('shape geometry', () => {
  it('fits polygons and stars to the box', () => {
    for (const pts of [polygonPoints(6, 120, 80), starPoints(5, 0.4, 100, 100)]) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      expect(Math.min(...xs)).toBeCloseTo(0);
      expect(Math.min(...ys)).toBeCloseTo(0);
    }
    expect(polygonPoints(6, 120, 80).length).toBe(6);
    expect(starPoints(5, 0.4, 100, 100).length).toBe(10);
    const f = fitToBox([{ x: -1, y: -1 }, { x: 1, y: 3 }], 10, 20);
    expect(f[1]).toEqual({ x: 10, y: 20 });
  });
  it('line polygon has the requested thickness', () => {
    const p = linePolygon(100, 0, 8);
    expect(Math.abs(p[0].y - p[3].y)).toBeCloseTo(8);
  });
  it('rounded polygon clamps corner radii', () => {
    const ops = roundedPolygonOps([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], 100);
    const arcs = ops.filter((o) => o.op === 'A') as { r: number }[];
    expect(arcs.length).toBe(4);
    for (const a of arcs) expect(a.r).toBeCloseTo(5);
  });
});

describe('caches & masks & rects', () => {
  it('slot cache keeps a few versions per key and evicts by budget', () => {
    const c = new SlotCache(100, 2);
    c.set('a', '1', 'A1', 10);
    c.set('a', '2', 'A2', 10);
    c.set('a', '3', 'A3', 10);
    expect(c.get('a', '1')).toBeUndefined();
    expect(c.get('a', '2')).toBe('A2');
    expect(c.get('a', '3')).toBe('A3');
    c.set('b', 'x', 'B', 90);
    expect(c.pixels).toBeLessThanOrEqual(100);
    expect(c.get('b', 'x')).toBe('B');
    c.set('l', 's', 'L', 1, { layerId: 'ly1' });
    c.set('d', 's', 'D', 1, { composite: true });
    c.clear('ly1');
    expect(c.get('l', 's')).toBeUndefined();
    expect(c.get('d', 's')).toBeUndefined();
    expect(c.get('b', 'x')).toBe('B');
  });
  it('pixel LRU evicts oldest entries', () => {
    const l = new PixelLRU(100);
    l.set('a', 1, 60);
    l.set('b', 2, 60);
    expect(l.has('a')).toBe(false);
    expect(l.get('b')).toBe(2);
  });
  it('object ids are stable per identity', () => {
    const o = {};
    expect(objId(o)).toBe(objId(o));
    expect(objId({})).not.toBe(objId(o));
  });
  it('mask transfer honors invert and density', () => {
    expect(maskValue(0, false, 1)).toBe(0);
    expect(maskValue(0, true, 1)).toBe(255);
    expect(maskValue(0, false, 0)).toBe(255);
    expect(maskValue(0, false, 0.5)).toBeCloseTo(127.5);
    expect(maskLUT(false, 1)[200]).toBe(200);
  });
  it('rect helpers', () => {
    expect(coverRect(0.5, 0.5, 1, 1)).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(expandRect({ x: 0, y: 0, w: 2, h: 2 }, 1.2)).toEqual({ x: -2, y: -2, w: 6, h: 6 });
    expect(intersectRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 3, y: 0, w: 2, h: 2 })).toBeNull();
    expect(unionRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 3, y: 1, w: 2, h: 2 })).toEqual({ x: 0, y: 0, w: 5, h: 3 });
  });
});
