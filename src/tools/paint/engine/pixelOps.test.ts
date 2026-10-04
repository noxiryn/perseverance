import { describe, expect, it } from 'vitest';
import {
  blurSharpenDab,
  boxBlurRegion,
  createSmudgeState,
  dabRect,
  primeSmudge,
  rangeWeight,
  smudgeDab,
  toneDab,
  toneRGB,
  type DabArea,
  type PixelBuf,
} from './pixelOps';

function buf(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): PixelBuf {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = fn(x, y);
      data.set(v, (y * w + x) * 4);
    }
  return { data, width: w, height: h };
}

const area = (cx: number, cy: number, radius: number, extra: Partial<DabArea> = {}): DabArea => ({
  cx,
  cy,
  radius,
  hardness: 1,
  sel: null,
  lockAlpha: false,
  ...extra,
});

describe('dabRect', () => {
  it('clips to the buffer', () => {
    expect(dabRect({ width: 10, height: 10 }, 0, 0, 3)).toEqual({ x: 0, y: 0, width: 3, height: 3 });
    expect(dabRect({ width: 10, height: 10 }, -20, -20, 3)).toBeNull();
  });
});

describe('boxBlurRegion', () => {
  it('keeps a flat image flat', () => {
    const b = buf(8, 8, () => [100, 150, 200, 255]);
    const out = boxBlurRegion(b, 0, 0, 8, 8, 2);
    for (let i = 0; i < out.length; i += 4) {
      expect(out[i]).toBeCloseTo(100);
      expect(out[i + 3]).toBeCloseTo(255);
    }
  });
});

describe('blur / sharpen', () => {
  it('blur reduces contrast across an edge', () => {
    const b = buf(20, 20, (x) => (x < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    blurSharpenDab(b, area(10, 10, 8), 1, false);
    const left = b.data[(10 * 20 + 9) * 4];
    const right = b.data[(10 * 20 + 10) * 4];
    expect(left).toBeGreaterThan(0);
    expect(right).toBeLessThan(255);
  });

  it('sharpen increases contrast across an edge', () => {
    const b = buf(20, 20, (x) => (x < 10 ? [80, 80, 80, 255] : [160, 160, 160, 255]));
    blurSharpenDab(b, area(10, 10, 8), 1, true);
    expect(b.data[(10 * 20 + 9) * 4]).toBeLessThan(80);
    expect(b.data[(10 * 20 + 10) * 4]).toBeGreaterThan(160);
  });

  it('respects lock alpha and selection', () => {
    const b = buf(20, 20, (x) => (x < 10 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    blurSharpenDab(b, area(10, 10, 8, { lockAlpha: true }), 1, false);
    expect(b.data[(10 * 20 + 12) * 4 + 3]).toBe(0);
    expect(b.data[(10 * 20 + 8) * 4 + 3]).toBe(255);

    const c = buf(20, 20, (x) => (x < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const sel = new Uint8Array(400); // nothing selected
    blurSharpenDab(c, area(10, 10, 8, { sel }), 1, false);
    expect(c.data[(10 * 20 + 9) * 4]).toBe(0);
  });
});

describe('smudge', () => {
  it('drags color in the direction of travel', () => {
    const b = buf(40, 10, (x) => (x < 10 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const st = createSmudgeState(4);
    primeSmudge(st, b, 6, 5, 4);
    for (let x = 6; x <= 20; x += 1) smudgeDab(b, st, area(x, 5, 4, { hardness: 0.5 }), 0.8);
    // Red has been pushed into the blue region.
    expect(b.data[(5 * 40 + 15) * 4]).toBeGreaterThan(60);
  });

  it('finger painting starts with the given color', () => {
    const b = buf(20, 20, () => [0, 0, 0, 255]);
    const st = createSmudgeState(5);
    primeSmudge(st, b, 10, 10, 5, [255, 255, 255]);
    smudgeDab(b, st, area(10, 10, 5), 1);
    expect(b.data[(10 * 20 + 10) * 4]).toBeGreaterThan(200);
  });
});

describe('tone tools', () => {
  it('dodge lightens, burn darkens, ranges weight correctly', () => {
    const out = [0, 0, 0];
    toneRGB(100, 100, 100, 1, { kind: 'dodge', range: 'midtones', exposure: 0.5, protect: false }, out, 0);
    expect(out[0]).toBeGreaterThan(100);
    toneRGB(100, 100, 100, 1, { kind: 'burn', range: 'midtones', exposure: 0.5, protect: true }, out, 0);
    expect(out[0]).toBeLessThan(100);
    expect(rangeWeight(0.1, 'shadows')).toBeGreaterThan(rangeWeight(0.1, 'highlights'));
    expect(rangeWeight(0.9, 'highlights')).toBeGreaterThan(rangeWeight(0.9, 'shadows'));
    expect(rangeWeight(0.5, 'midtones')).toBeCloseTo(1);
  });

  it('dodge with protect tones keeps hue ordering', () => {
    const out = [0, 0, 0];
    toneRGB(200, 100, 50, 1, { kind: 'dodge', range: 'midtones', exposure: 1, protect: true }, out, 0);
    expect(out[0]).toBeGreaterThanOrEqual(out[1]);
    expect(out[1]).toBeGreaterThanOrEqual(out[2]);
  });

  it('sponge saturates and desaturates', () => {
    const out = [0, 0, 0];
    toneRGB(180, 100, 100, 1, { kind: 'sponge', mode: 'desaturate', flow: 1, vibrance: false }, out, 0);
    expect(Math.abs(out[0] - out[1])).toBeLessThan(2);
    toneRGB(150, 100, 100, 1, { kind: 'sponge', mode: 'saturate', flow: 1, vibrance: false }, out, 0);
    expect(out[0] - out[1]).toBeGreaterThan(50);
  });

  it('coverage caps the effect per stroke', () => {
    const b = buf(10, 10, () => [100, 100, 100, 255]);
    const orig = b.data.slice();
    const cov = new Float32Array(100);
    const op = { kind: 'burn' as const, range: 'midtones' as const, exposure: 0.5, protect: true };
    for (let i = 0; i < 50; i++) toneDab(b, orig, cov, area(5, 5, 4), 0.4, op);
    const capped = b.data[(5 * 10 + 5) * 4];
    const out = [0, 0, 0];
    toneRGB(100, 100, 100, 1, op, out, 0);
    expect(capped).toBeCloseTo(out[0], 0);
  });
});
