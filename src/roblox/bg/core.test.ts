import { describe, expect, it } from 'vitest';
import { makeBuffer, type PixelBuffer } from '../pixels';
import {
  DEFAULT_BG_PARAMS,
  GREEN_PRESET,
  GREEN_SPILL_BAND,
  PARTIAL_INTERIOR_WARN,
  ENCLOSED_REMOVED_WARN,
  GRADIENT_RATE,
  GRADIENT_SLACK,
  GRADIENT_STEP,
  GRADIENT_WINDOW,
  GRADIENT_WINDOW_SLACK,
  analyzeBorder,
  applyMask,
  autoCutout,
  backgroundDistance,
  cutoutWarnings,
  floodBackground,
  keepMaskDetailed,
  colorDistance,
  computeKeepMask,
  cutoutStats,
  decontaminate,
  dropIslands,
  maskChangeBounds,
  paletteFor,
  removeBackground,
  removeSeams,
  sampleBorderPalette,
  subjectMask,
  unionRect,
  type BgParams,
} from './core';

type RGBA = [number, number, number, number];

/** Background color with a subject rect (and optional hole in the subject showing background). */
function scene(w: number, h: number, bg: RGBA, fg: RGBA, rect: [number, number, number, number], hole?: [number, number, number, number]): PixelBuffer {
  const img = makeBuffer(w, h, bg);
  const fill = (r: [number, number, number, number], c: RGBA) => {
    for (let y = r[1]; y < r[1] + r[3]; y++) for (let x = r[0]; x < r[0] + r[2]; x++) img.data.set(c, (y * w + x) * 4);
  };
  fill(rect, fg);
  if (hole) fill(hole, bg);
  return img;
}

const at = (mask: Uint8ClampedArray, w: number, x: number, y: number) => mask[y * w + x];
const noEdges: Partial<BgParams> = { feather: 0, shrink: 0, decontaminate: 0 };

describe('color distance', () => {
  it('is 0 for equal colors and ~100 for black vs white', () => {
    expect(colorDistance(10, 20, 30, 10, 20, 30)).toBe(0);
    expect(colorDistance(0, 0, 0, 255, 255, 255)).toBeGreaterThan(95);
    expect(colorDistance(0, 0, 0, 255, 255, 255)).toBeLessThanOrEqual(100);
  });
});

describe('border palette', () => {
  it('finds the dominant border color', () => {
    const img = scene(40, 30, [240, 240, 240, 255], [20, 20, 200, 255], [10, 8, 20, 14]);
    const pal = sampleBorderPalette(img);
    expect(pal.length).toBeGreaterThanOrEqual(1);
    expect(colorDistance(...pal[0], 240, 240, 240)).toBeLessThan(2);
  });

  it('returns two colors for a two-tone backdrop', () => {
    const img = makeBuffer(40, 40, [255, 255, 255, 255]);
    for (let y = 0; y < 40; y++) for (let x = 20; x < 40; x++) img.data.set([0, 0, 0, 255], (y * 40 + x) * 4);
    expect(sampleBorderPalette(img).length).toBe(2);
  });

  it('ignores transparent borders', () => {
    const img = scene(20, 20, [0, 0, 0, 0], [255, 0, 0, 255], [5, 5, 10, 10]);
    expect(sampleBorderPalette(img)).toEqual([]);
  });
});

describe('keep mask', () => {
  it('auto mode removes the backdrop and keeps the subject', () => {
    const w = 40,
      h = 30;
    const img = scene(w, h, [235, 235, 235, 255], [30, 60, 160, 255], [10, 8, 20, 14]);
    const mask = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges });
    expect(at(mask, w, 0, 0)).toBe(0);
    expect(at(mask, w, 39, 29)).toBe(0);
    expect(at(mask, w, 20, 15)).toBe(255);
  });

  it('auto mode keeps enclosed background-colored holes (flood fill from the edges)', () => {
    const w = 40,
      h = 40;
    const img = scene(w, h, [250, 250, 250, 255], [10, 10, 10, 255], [8, 8, 24, 24], [16, 16, 8, 8]);
    const mask = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges });
    expect(at(mask, w, 20, 20)).toBe(255); // hole is not connected to the border
    expect(at(mask, w, 2, 2)).toBe(0);
  });

  it('color key without contiguity removes enclosed holes too', () => {
    const w = 40,
      h = 40;
    const img = scene(w, h, [0, 177, 64, 255], [200, 30, 30, 255], [8, 8, 24, 24], [16, 16, 8, 8]);
    const params: BgParams = { ...DEFAULT_BG_PARAMS, ...noEdges, mode: 'color', keyColor: '#00b140', contiguous: false };
    const mask = computeKeepMask(img, params);
    expect(at(mask, w, 20, 20)).toBe(0);
    expect(at(mask, w, 10, 10)).toBe(255);
    const contiguous = computeKeepMask(img, { ...params, contiguous: true });
    expect(at(contiguous, w, 20, 20)).toBe(255);
  });

  it('green screen mode keys green and keeps skin tones', () => {
    const w = 30,
      h = 30;
    const img = scene(w, h, [40, 200, 60, 255], [224, 172, 120, 255], [8, 8, 14, 14]);
    const mask = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...GREEN_PRESET, ...noEdges });
    expect(at(mask, w, 1, 1)).toBe(0);
    expect(at(mask, w, 15, 15)).toBe(255);
  });

  it('softness produces partial alpha between tolerance and tolerance+softness', () => {
    const w = 3,
      h = 1;
    const img = makeBuffer(w, h);
    img.data.set([0, 0, 0, 255], 0);
    img.data.set([40, 40, 40, 255], 4);
    img.data.set([255, 255, 255, 255], 8);
    const params: BgParams = { ...DEFAULT_BG_PARAMS, ...noEdges, mode: 'color', keyColor: '#000000', contiguous: false, tolerance: 5, softness: 20 };
    const mask = computeKeepMask(img, params);
    expect(mask[0]).toBe(0);
    expect(mask[1]).toBeGreaterThan(0);
    expect(mask[1]).toBeLessThan(255);
    expect(mask[2]).toBe(255);
  });

  it('shrink erodes the kept area', () => {
    const w = 40,
      h = 40;
    const img = scene(w, h, [250, 250, 250, 255], [10, 10, 10, 255], [10, 10, 20, 20]);
    const sharp = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges });
    const shrunk = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges, shrink: 3 });
    expect(at(sharp, w, 10, 20)).toBe(255);
    expect(at(shrunk, w, 10, 20)).toBe(0);
    expect(at(shrunk, w, 20, 20)).toBe(255);
  });

  it('feather softens the edge', () => {
    const w = 40,
      h = 40;
    const img = scene(w, h, [250, 250, 250, 255], [10, 10, 10, 255], [10, 10, 20, 20]);
    const soft = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges, feather: 3 });
    const edge = at(soft, w, 10, 20);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });
});

describe('pipeline', () => {
  it('applyMask multiplies alpha', () => {
    const img = makeBuffer(2, 1, [10, 10, 10, 200]);
    applyMask(img, new Uint8ClampedArray([0, 255]));
    expect(img.data[3]).toBe(0);
    expect(img.data[7]).toBe(200);
  });

  it('decontaminates green spill only along the cut', () => {
    // 16×1 row: pixel 0 removed, the rest kept and all green-tinted.
    const w = 16;
    const img = makeBuffer(w, 1, [120, 200, 110, 255]);
    const mask = new Uint8ClampedArray(w).fill(255);
    mask[0] = 0;
    const params = { ...DEFAULT_BG_PARAMS, ...GREEN_PRESET, decontaminate: 1 };
    const res = decontaminate(img, mask, params, paletteFor(img, params));
    expect(res.changed).toBe(true);
    // Next to the cut: spill removed.
    expect(img.data[4 + 1]).toBeLessThanOrEqual(Math.max(img.data[4], img.data[4 + 2]) + 1);
    // Far from the cut (interior): untouched — green clothing keeps its color.
    expect([...img.data.slice(15 * 4, 15 * 4 + 3)]).toEqual([120, 200, 110]);
    expect(res.rect).toMatchObject({ y: 0, height: 1 });
    expect(res.rect!.x).toBeGreaterThanOrEqual(1);
    expect(res.rect!.x + res.rect!.width).toBeLessThanOrEqual(GREEN_SPILL_BAND + 2);
  });

  it('does not decontaminate when nothing is removed or the amount is 0', () => {
    const img = makeBuffer(4, 1, [120, 200, 110, 255]);
    const params = { ...DEFAULT_BG_PARAMS, ...GREEN_PRESET, decontaminate: 1 };
    expect(decontaminate(img, new Uint8ClampedArray(4).fill(255), params, []).changed).toBe(false);
    const mask = new Uint8ClampedArray([0, 255, 255, 255]);
    expect(decontaminate(img, mask, { ...params, decontaminate: 0 }, []).changed).toBe(false);
    expect([...img.data.slice(4, 7)]).toEqual([120, 200, 110]);
  });

  it('bounds the pixels a delete changes', () => {
    const mask = new Uint8ClampedArray(5 * 4).fill(255);
    mask[1 * 5 + 2] = 0;
    mask[3 * 5 + 3] = 128;
    expect(maskChangeBounds(mask, 5, 4)).toEqual({ x: 2, y: 1, width: 2, height: 3 });
    expect(maskChangeBounds(new Uint8ClampedArray(4).fill(255), 2, 2)).toBeNull();
    expect(unionRect({ x: 0, y: 0, width: 2, height: 2 }, { x: 3, y: 1, width: 1, height: 4 })).toEqual({ x: 0, y: 0, width: 4, height: 5 });
  });

  it('removeBackground returns a mask and the palette used', () => {
    const img = scene(20, 20, [255, 255, 255, 255], [0, 0, 0, 255], [5, 5, 10, 10]);
    const { mask, palette } = removeBackground(img, { ...DEFAULT_BG_PARAMS, ...noEdges });
    expect(mask.length).toBe(400);
    expect(palette.length).toBe(1);
  });

  it('subjectMask uses existing transparency', () => {
    const w = 20,
      h = 20;
    const img = scene(w, h, [0, 0, 0, 0], [255, 255, 255, 255], [5, 5, 10, 10]);
    const m = subjectMask(img);
    expect(at(m, w, 1, 1)).toBe(0);
    expect(at(m, w, 10, 10)).toBeGreaterThan(200);
  });
});

/**
 * Synthetic Roblox Studio screenshot: sky gradient (top) over a green baseplate (bottom) with an
 * antialiased 1px horizon row, and a character (brown shirt close to the baseplate green in
 * redmean distance, dark pants, a thin sword blade over the sky).
 */
function studioShot(w = 160, h = 120) {
  const img = makeBuffer(w, h, [0, 0, 0, 255]);
  const horizon = Math.round(h * 0.6);
  const set = (x: number, y: number, c: [number, number, number]) => img.data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  const sky = (y: number): [number, number, number] => {
    const t = y / horizon;
    return [Math.round(110 + 110 * t), Math.round(170 + 60 * t), 245];
  };
  const ground: [number, number, number] = [92, 140, 70];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (y < horizon) set(x, y, sky(y));
      else if (y === horizon) {
        const s = sky(horizon - 1);
        set(x, y, [Math.round((s[0] + ground[0]) / 2), Math.round((s[1] + ground[1]) / 2), Math.round((s[2] + ground[2]) / 2)]);
      } else set(x, y, ground);
    }
  }
  const shirt: [number, number, number] = [150, 95, 60]; // ≈17 from the baseplate green
  const pants: [number, number, number] = [30, 34, 60];
  const box = { x: 60, y: 30, w: 40, h: 70 };
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) set(x, y, y < box.y + 40 ? shirt : pants);
  }
  // Thin (2px) steel sword blade sticking out over the sky.
  for (let x = box.x + box.w; x < box.x + box.w + 30; x++) for (let y = 40; y < 42; y++) set(x, y, [125, 128, 140]);
  return { img, w, h, horizon, box };
}

describe('auto mode on a Roblox Studio screenshot', () => {
  it('keeps the whole subject opaque (the softness band cannot leak into it)', () => {
    const { img, w, box } = studioShot();
    const mask = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges });
    // Shirt interior, pants, sword blade: fully kept.
    expect(at(mask, w, box.x + 20, box.y + 20)).toBe(255);
    expect(at(mask, w, box.x + 20, box.y + 60)).toBe(255);
    expect(at(mask, w, box.x + box.w + 10, 40)).toBe(255);
  });

  it('even generous settings only soften the edge band, not the interior', () => {
    const { img, w, box } = studioShot();
    const mask = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges, tolerance: 14, softness: 30 });
    expect(at(mask, w, box.x + 20, box.y + 20)).toBe(255);
    expect(cutoutStats(img, mask).partialInterior).toBeLessThan(PARTIAL_INTERIOR_WARN);
  });

  it('removes the sky gradient, the baseplate and the antialiased horizon line', () => {
    const { img, w, h, horizon } = studioShot();
    const mask = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges });
    expect(at(mask, w, 5, 5)).toBe(0);
    expect(at(mask, w, 30, horizon - 3)).toBe(0);
    expect(at(mask, w, 5, h - 3)).toBe(0);
    // The horizon row away from the character.
    let worst = 0;
    for (let x = 0; x < 50; x++) worst = Math.max(worst, at(mask, w, x, horizon));
    for (let x = 135; x < w; x++) worst = Math.max(worst, at(mask, w, x, horizon));
    expect(worst).toBe(0);
  });

  it('reports a clean cut-out in the stats', () => {
    const { img } = studioShot();
    const mask = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges });
    const stats = cutoutStats(img, mask);
    expect(stats.removed).toBeGreaterThan(0.6);
    expect(stats.partialInterior).toBe(0);
  });
});

describe('cleanup helpers', () => {
  it('removeSeams marks blended runs between background but keeps thin subject parts', () => {
    // Column: sky, blended seam, ground — and a second column with a dark 1px line between sky.
    const img = makeBuffer(2, 3);
    img.data.set([120, 180, 250, 255], 0);
    img.data.set([105, 160, 160, 255], 8); // blend of sky (row 0) and ground (row 2)
    img.data.set([90, 140, 70, 255], 16);
    img.data.set([120, 180, 250, 255], 4);
    img.data.set([20, 20, 20, 255], 12); // dark line: not a blend
    img.data.set([120, 180, 250, 255], 20);
    const reach = new Uint8Array([1, 1, 0, 0, 1, 1]);
    expect(removeSeams(img, reach, 8)).toBe(1);
    expect([...reach]).toEqual([1, 1, 1, 0, 1, 1]);
  });

  it('dropIslands removes specks but keeps a second large subject', () => {
    const w = 60,
      h = 20;
    const m = new Float32Array(w * h);
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
    };
    fill(2, 2, 20, 18); // character A
    fill(30, 2, 46, 18); // character B
    fill(55, 5, 56, 6); // speck
    expect(dropIslands(m, w, h)).toBe(1);
    expect(m[10 * w + 10]).toBe(1);
    expect(m[10 * w + 40]).toBe(1);
    expect(m[5 * w + 55]).toBe(0);
  });

  it('auto mode drops background clutter the flood cannot reach', () => {
    const w = 60,
      h = 60;
    const img = scene(w, h, [240, 240, 240, 255], [20, 40, 160, 255], [15, 10, 30, 45]);
    img.data.set([60, 60, 60, 255], (3 * w + 52) * 4); // a 1px dark speck in the backdrop
    const mask = computeKeepMask(img, { ...DEFAULT_BG_PARAMS, ...noEdges });
    expect(at(mask, w, 52, 3)).toBe(0);
    expect(at(mask, w, 30, 30)).toBe(255);
  });

  it('cutoutStats flags a semi-transparent interior', () => {
    const w = 30,
      h = 30;
    const img = makeBuffer(w, h, [100, 100, 100, 255]);
    const mask = new Uint8ClampedArray(w * h);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) mask[y * w + x] = 128;
    expect(cutoutStats(img, mask).partialInterior).toBeGreaterThan(PARTIAL_INTERIOR_WARN);
  });
});

/**
 * Roblox Studio screenshot whose character is cut off by the bottom edge of the frame (a dropped
 * 1080p screenshot, an avatar render cropped at the knees): sky gradient, green baseplate with
 * stripes, a black-outlined character with dark pants down to the bottom edge, black hair and a
 * flat brown shirt. Proportions follow the frame, so any resolution shows the same picture.
 */
function cutOffShot(w: number, h: number) {
  const img = makeBuffer(w, h, [0, 0, 0, 255]);
  const d = img.data;
  const horizon = Math.round(h * 0.72);
  const set = (x: number, y: number, c: readonly number[]) => {
    const q = (y * w + x) * 4;
    d[q] = c[0];
    d[q + 1] = c[1];
    d[q + 2] = c[2];
    d[q + 3] = 255;
  };
  const stripe = Math.max(8, Math.round(w / 32));
  const seam = [100, 134, 72],
    grass = [110, 145, 80];
  for (let y = 0; y < h; y++) {
    const t = y / horizon;
    const sky = [Math.round(92 + 120 * t), Math.round(160 + 70 * t), Math.round(230 + 18 * t)];
    for (let x = 0; x < w; x++) set(x, y, y < horizon ? sky : x % stripe < 2 ? seam : grass);
  }
  const box = (x0: number, y0: number, x1: number, y1: number, c: readonly number[]) => {
    for (let y = Math.max(0, Math.round(y0 * h)); y < Math.min(h, Math.round(y1 * h)); y++) for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) set(x, y, c);
  };
  const outline = Math.max(2, Math.round(w / 400));
  const o = outline / w,
    oy = outline / h;
  const black = [12, 12, 12];
  // pants (two legs, 16% of the width) down to the bottom edge, shirt, head, hair
  box(0.42 - o, 0.62 - oy, 0.58 + o, 1, black);
  box(0.42, 0.62, 0.58, 1, [38, 39, 38]);
  box(0.4 - o, 0.3 - oy, 0.6 + o, 0.62, black);
  box(0.4, 0.3, 0.6, 0.62, [122, 58, 32]);
  box(0.45 - o, 0.14 - oy, 0.55 + o, 0.3, black);
  box(0.45, 0.2, 0.55, 0.3, [234, 190, 150]);
  box(0.45, 0.14, 0.55, 0.2, [24, 24, 24]);
  const at = (fx: number, fy: number) => Math.min(h - 1, Math.round(fy * h)) * w + Math.round(fx * w);
  return { img, w, h, pants: at(0.5, 0.95), pantsEdge: at(0.43, 0.999), hair: at(0.5, 0.17), shirt: at(0.5, 0.45), face: at(0.5, 0.25), outline: at(0.4 - o / 2, 0.45), sky: at(0.1, 0.1), lowSky: at(0.2, 0.7), ground: at(0.1, 0.9) };
}

describe('auto mode with a subject cut off by the frame', () => {
  for (const [w, h] of [
    [1280, 720],
    [1728, 972],
    [1920, 1080],
    [3840, 2160],
  ] as const) {
    it(`keeps the pants, hair, outline and shirt at ${w}×${h}`, () => {
      const s = cutOffShot(w, h);
      const border = analyzeBorder(s.img);
      expect(border.confident).toBe(true);
      // The pants run on the bottom edge is not a background color.
      for (const p of border.palette) expect(colorDistance(p[0], p[1], p[2], 38, 39, 38)).toBeGreaterThan(20);
      expect(border.excluded).toBeGreaterThan(0.03);
      const res = keepMaskDetailed(s.img, { ...DEFAULT_BG_PARAMS, ...noEdges });
      for (const k of ['pants', 'pantsEdge', 'hair', 'shirt', 'face', 'outline'] as const) expect([k, res.mask[s[k]]]).toEqual([k, 255]);
      for (const k of ['sky', 'lowSky', 'ground'] as const) expect([k, res.mask[s[k]]]).toEqual([k, 0]);
      expect(res.enclosedRemoved).toBeLessThan(ENCLOSED_REMOVED_WARN);
    }, 60000);
  }

  it('the automatic cut-out removes the background of a clean screenshot', () => {
    const s = cutOffShot(640, 360);
    const res = autoCutout(s.img);
    expect(res).toEqual({ outcome: 'removed', warnings: [] });
    expect(s.img.data[s.sky * 4 + 3]).toBe(0);
    expect(s.img.data[s.pants * 4 + 3]).toBe(255);
  });
});

describe('border analysis', () => {
  it('a uniform border is one confident color', () => {
    const a = analyzeBorder(makeBuffer(80, 60, [200, 40, 40, 255]));
    expect(a.palette).toHaveLength(1);
    expect(a.confident).toBe(true);
    expect(a.excluded).toBe(0);
  });

  it('keeps a smooth gradient in one run and samples its shades', () => {
    const w = 300,
      h = 200;
    const img = makeBuffer(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set([60 + y, 120 + y / 2, 240, 255], (y * w + x) * 4);
    const a = analyzeBorder(img);
    expect(a.confident).toBe(true);
    expect(a.excluded).toBe(0);
    // dark top and light bottom shades are both background colors
    expect(Math.min(...a.palette.map((p) => colorDistance(p[0], p[1], p[2], 60, 120, 240)))).toBeLessThan(6);
    expect(Math.min(...a.palette.map((p) => colorDistance(p[0], p[1], p[2], 259, 219.5, 240)))).toBeLessThan(6);
  });

  it('a run turning a corner is background even when short; one in the middle of a side is not', () => {
    const w = 200,
      h = 100;
    const img = makeBuffer(w, h, [230, 230, 230, 255]);
    // red patch in the bottom-left corner (turns the corner), blue patch mid-top (one side)
    for (let y = 85; y < h; y++) for (let x = 0; x < 20; x++) img.data.set([200, 30, 30, 255], (y * w + x) * 4);
    for (let y = 0; y < 15; y++) for (let x = 80; x < 120; x++) img.data.set([30, 30, 200, 255], (y * w + x) * 4);
    const a = analyzeBorder(img);
    const has = (r: number, g: number, b: number) => a.palette.some((p) => colorDistance(p[0], p[1], p[2], r, g, b) < 5);
    expect(has(230, 230, 230)).toBe(true);
    expect(has(200, 30, 30)).toBe(true);
    expect(has(30, 30, 200)).toBe(false);
  });

  it('a cluttered border is not confident', () => {
    const w = 120,
      h = 90;
    const img = makeBuffer(w, h);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 255;
    for (let i = 0; i < w * h; i++) img.data.set([rnd(), rnd(), rnd(), 255], i * 4);
    expect(analyzeBorder(img).confident).toBe(false);
    expect(autoCutout(img).outcome).toBe('unsure');
  });
});

describe('gradient following', () => {
  /** A color at background distance `dist` from `bg` (bisection along a fixed direction). */
  function colorAt(bg: [number, number, number], dist: number): [number, number, number] {
    const dir = [-1, -0.55, -0.15];
    let lo = 0,
      hi = 200;
    for (let k = 0; k < 40; k++) {
      const t = (lo + hi) / 2;
      const c = bg.map((v, i) => v + dir[i] * t);
      if (colorDistance(c[0], c[1], c[2], ...bg) < dist) lo = t;
      else hi = t;
    }
    return bg.map((v, i) => v + dir[i] * lo) as [number, number, number];
  }

  /**
   * Flat backdrop; inside it a gentle fog gradient (just above the tolerance, legit background)
   * that reaches a flat "shirt" (within the gradient cap) through a short ramp far from the
   * plainly flooded background — where the distance-based allowance alone would let it in.
   */
  function fogAndShirt() {
    const w = 480,
      h = 360;
    const bg: [number, number, number] = [163, 205, 240];
    const img = makeBuffer(w, h, [...bg, 255]);
    const put = (x: number, y: number, dist: number) => {
      const c = colorAt(bg, dist);
      img.data.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], (y * w + x) * 4);
    };
    for (let y = 40; y < 330; y++) {
      for (let x = 40; x < 440; x++) {
        const inShirt = x >= 260 && x < 420 && y >= 120 && y < 300;
        if (!inShirt) put(x, y, Math.min(11.5, 9 + ((x - 40) / 160) * 2.5));
        else put(x, y, x < 266 ? 11.5 + ((x - 259) / 7) * 6.5 : 18);
      }
    }
    return { img, w, h, fog: 200 * w + 230, shirt: 210 * w + 340 };
  }

  it('follows a gentle fog but does not enter a flat area through a short ramp', () => {
    const { img, w, shirt, fog } = fogAndShirt();
    const params = { ...DEFAULT_BG_PARAMS, ...noEdges };
    const D = backgroundDistance(img, params, [[163, 205, 240]]);
    const tol = params.tolerance;
    const base = { step: GRADIENT_STEP, cap: tol + params.softness + 8, rate: GRADIENT_RATE, slack: GRADIENT_SLACK };
    // Without the local check the distance allowance lets the flood into the shirt…
    expect(floodBackground(img, D, tol, base)[shirt]).toBe(2);
    // …with it, the fog is still followed and the shirt stays.
    const R = floodBackground(img, D, tol, { ...base, window: GRADIENT_WINDOW, windowSlack: GRADIENT_WINDOW_SLACK });
    expect(R[fog]).toBe(2);
    expect(R[shirt]).toBe(0);
    const mask = computeKeepMask(img, params);
    expect(at(mask, w, shirt % w, Math.floor(shirt / w))).toBe(255);
    expect(at(mask, w, fog % w, Math.floor(fog / w))).toBe(0);
  });
});

describe('cut-out warnings', () => {
  it('feather and shrink alone never make the subject look semi-transparent', () => {
    const { img } = studioShot();
    for (const feather of [3, 6, 10]) {
      const res = keepMaskDetailed(img, { ...DEFAULT_BG_PARAMS, feather, shrink: 2, decontaminate: 0 });
      expect(cutoutStats(img, res.mask, res.raw).partialInterior).toBe(0);
    }
  });

  it('lists what makes a cut-out unreliable', () => {
    expect(cutoutWarnings({ partialInterior: 0 }, 0, { confident: true })).toEqual([]);
    expect(cutoutWarnings({ partialInterior: PARTIAL_INTERIOR_WARN + 0.01 }, ENCLOSED_REMOVED_WARN + 0.01, { confident: false })).toEqual(['cluttered-border', 'subject-removed', 'semi-transparent']);
    expect(cutoutWarnings({ partialInterior: 0 }, 0, null)).toEqual([]);
  });
});
