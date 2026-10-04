import { describe, expect, it } from 'vitest';
import { makeBuffer, type PixelBuffer } from '../pixels';
import {
  DEFAULT_BG_PARAMS,
  GREEN_PRESET,
  applyMask,
  colorDistance,
  computeKeepMask,
  decontaminate,
  paletteFor,
  removeBackground,
  sampleBorderPalette,
  subjectMask,
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

  it('decontaminates green spill on kept pixels', () => {
    const img = makeBuffer(1, 1, [120, 200, 110, 255]);
    decontaminate(img, new Uint8ClampedArray([255]), { ...DEFAULT_BG_PARAMS, ...GREEN_PRESET, decontaminate: 1 }, paletteFor(img, { ...DEFAULT_BG_PARAMS, ...GREEN_PRESET }));
    expect(img.data[1]).toBeLessThanOrEqual(Math.max(img.data[0], img.data[2]) + 1);
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
