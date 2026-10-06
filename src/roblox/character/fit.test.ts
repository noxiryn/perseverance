/**
 * Replace Character with a bust / head / waist-up image (e2e-flows-1): the image is cut off at the
 * bottom, so it must not stand on the placeholder's (often off-canvas) bottom edge — its face has
 * to land inside the canvas, where the placeholder's head was.
 */
import { describe, expect, it } from 'vitest';
import type { Transform } from '../../core/types';
import { linearApply } from '../../panels/geometryMath';
import { CUT_MAX_WIDEN, centerLineOnCanvas, characterFitAlign, fitIntoBox, fitIntoBoxAtScale, isCutOffAtBottom } from './fit';
import { rendersCutOff } from '../studio/placement';

const T = (p: Partial<Transform> = {}): Transform => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, ...p });

/** Doc position of local point (u, v) of a w×h box (same math as transformMatrix). */
function toDoc(t: Transform, w: number, h: number, u: number, v: number) {
  const d = linearApply(t, u - w / 2, v - h / 2);
  return { x: t.x + w / 2 + d.x, y: t.y + h / 2 + d.y };
}

/** Bounding box of a fitted w×h box on the canvas. */
function bounds(t: Transform, w: number, h: number) {
  const pts = [toDoc(t, w, h, 0, 0), toDoc(t, w, h, w, 0), toDoc(t, w, h, 0, h), toDoc(t, w, h, w, h)];
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

// The gothic template's placeholder: 657×904 at (191, 328) on a 1024² canvas — its legs reach
// ~200 px past the bottom edge.
const GOTHIC = { t: T({ x: 191, y: 328 }), w: 657, h: 904, canvas: { width: 1024, height: 1024 } };
// The sunburst icon: 468×644 at (54, 130) on 512² — more than a third of the box is off the canvas.
const SUNBURST = { t: T({ x: 54, y: 130 }), w: 468, h: 644, canvas: { width: 512, height: 512 } };

describe('centerLineOnCanvas', () => {
  it('measures how much of the box center line is on the canvas', () => {
    const g = centerLineOnCanvas(GOTHIC.t, GOTHIC.w, GOTHIC.h, GOTHIC.canvas)!;
    expect(g.s0).toBeCloseTo(0);
    expect(g.s1).toBeCloseTo((1024 - 328) / 904);
    expect(centerLineOnCanvas(T({ x: 10, y: 10 }), 100, 100, { width: 500, height: 500 })).toEqual({ s0: 0, s1: 1 });
    expect(centerLineOnCanvas(T({ x: 10, y: 600 }), 100, 100, { width: 500, height: 500 })).toBeNull();
  });

  it('follows the box rotation (a box lying on its side, top to the right)', () => {
    // 100×400 box centered at (250, 250) rotated 90°: its center line runs horizontally.
    const t = T({ x: 200, y: 50, rotation: 90 });
    const r = centerLineOnCanvas(t, 100, 400, { width: 300, height: 500 })!;
    // Local top (v = 0) maps to x = 450, the bottom to x = 50 (or the reverse): 300 px wide canvas
    // keeps 250 of the 400 px.
    expect(r.s1 - r.s0).toBeCloseTo(250 / 400);
  });
});

describe("fitIntoBox 'cut' (busts, heads, waist-up renders)", () => {
  it('keeps a 420² bust inside a gothic placeholder that runs past the canvas', () => {
    const r = fitIntoBox(GOTHIC.t, GOTHIC.w, GOTHIC.h, 420, 420, 'cut', GOTHIC.canvas);
    const b = bounds(r.transform, r.width, r.height);
    // The head stays where the placeholder's head was, the cut lands on the canvas edge.
    expect(b.y0).toBeCloseTo(328, 0);
    expect(b.y1).toBeCloseTo(1024, 0);
    expect(r.height).toBe(696);
    // Centered on the placeholder, not wider than allowed.
    expect((b.x0 + b.x1) / 2).toBeCloseTo(191 + 657 / 2, 0);
    expect(r.width).toBeLessThanOrEqual(Math.round(657 * CUT_MAX_WIDEN));
    // The old behaviour this replaces: contain + feet planted put the bust's top at y ≈ 575 and
    // its lower third off the canvas.
    const old = fitIntoBox(GOTHIC.t, GOTHIC.w, GOTHIC.h, 420, 420, 'bottom');
    expect(bounds(old.transform, old.width, old.height).y1).toBeGreaterThan(1200);
  });

  it('puts the head band of a headshot inside the sunburst icon', () => {
    // 720² headshot whose head occupies rows 90..490.
    const r = fitIntoBox(SUNBURST.t, SUNBURST.w, SUNBURST.h, 720, 720, 'cut', SUNBURST.canvas);
    const k = r.height / 720;
    const b = bounds(r.transform, r.width, r.height);
    const headTop = b.y0 + 90 * k;
    const headBottom = b.y0 + 490 * k;
    expect(headTop).toBeGreaterThanOrEqual(130 - 0.5);
    expect(headBottom).toBeLessThanOrEqual(512);
    expect(b.y1).toBeCloseTo(512, 0);
  });

  it('limits a wide (T-pose) waist-up render to the allowed width and keeps its cut on the edge', () => {
    const r = fitIntoBox(GOTHIC.t, GOTHIC.w, GOTHIC.h, 600, 330, 'cut', GOTHIC.canvas);
    expect(r.width).toBe(Math.round(657 * CUT_MAX_WIDEN));
    const b = bounds(r.transform, r.width, r.height);
    expect(b.y1).toBeCloseTo(1024, 0);
    expect(b.y0).toBeGreaterThan(328);
    // Never wider than the canvas.
    const narrow = fitIntoBox(T({ x: 0, y: 100 }), 480, 600, 1000, 200, 'cut', { width: 500, height: 500 });
    expect(narrow.width).toBeLessThanOrEqual(500);
  });

  it('fills the whole box when it is on the canvas (cut edge on the box bottom)', () => {
    const t = T({ x: 100, y: 50 });
    const r = fitIntoBox(t, 300, 400, 300, 300, 'cut', { width: 1000, height: 1000 });
    const b = bounds(r.transform, r.width, r.height);
    expect(b.y1).toBeCloseTo(450, 0);
    expect(r.width).toBe(375); // may widen by CUT_MAX_WIDEN to use the box height
    expect(r.height).toBe(375);
  });

  it('keeps the flip; a rotated box gets its whole cut edge off the canvas', () => {
    const flipped = fitIntoBox(T({ ...GOTHIC.t, scaleX: -1 }), GOTHIC.w, GOTHIC.h, 420, 420, 'cut', GOTHIC.canvas);
    expect(flipped.transform.scaleX).toBe(-1);
    const t = T({ x: 191, y: 328, rotation: 12 });
    const r = fitIntoBox(t, GOTHIC.w, GOTHIC.h, 420, 420, 'cut', GOTHIC.canvas);
    expect(r.transform.rotation).toBe(12);
    const bl = toDoc(r.transform, r.width, r.height, 0, r.height);
    const br = toDoc(r.transform, r.width, r.height, r.width, r.height);
    expect(Math.min(bl.y, br.y)).toBeGreaterThanOrEqual(1024 - 0.5);
    // ...while the top of the head stays on the canvas.
    const tl = toDoc(r.transform, r.width, r.height, 0, 0);
    const tr = toDoc(r.transform, r.width, r.height, r.width, 0);
    expect(Math.max(tl.y, tr.y)).toBeLessThan(1024);
    expect(Math.min(tl.y, tr.y)).toBeGreaterThan(0);
  });

  it("falls back to 'bottom' without a canvas or when the box is (almost) off it", () => {
    const a = fitIntoBox(GOTHIC.t, GOTHIC.w, GOTHIC.h, 420, 420, 'cut');
    const b = fitIntoBox(GOTHIC.t, GOTHIC.w, GOTHIC.h, 420, 420, 'bottom');
    expect(a).toEqual(b);
    const off = T({ x: 0, y: 990 });
    expect(fitIntoBox(off, 300, 900, 420, 420, 'cut', { width: 1024, height: 1024 })).toEqual(fitIntoBox(off, 300, 900, 420, 420, 'bottom'));
  });

  it('fitIntoBoxAtScale places a full-resolution render in the same box', () => {
    const fit = fitIntoBox(SUNBURST.t, SUNBURST.w, SUNBURST.h, 512, 512, 'cut', SUNBURST.canvas);
    const t = fitIntoBoxAtScale(SUNBURST.t, SUNBURST.w, SUNBURST.h, 512, 512, 'cut', SUNBURST.canvas);
    const a = bounds(fit.transform, fit.width, fit.height);
    const b = bounds(t, 512, 512);
    expect(b.y0).toBeCloseTo(a.y0, 3);
    expect(b.y1).toBeCloseTo(a.y1, 3);
    expect(b.x0).toBeCloseTo(a.x0, 3);
  });
});

// The other flagship placeholders (doc 1920×1080): noir's tilted right-hand figure and crimson's
// mirrored one, plus anime-action's almost square box.
const NOIR = { t: T({ x: 1161, y: 328, rotation: -14 }), w: 738, h: 1003, canvas: { width: 1920, height: 1080 } };
const CRIMSON = { t: T({ x: 1024, y: 94, scaleX: -1 }), w: 773, h: 1064, canvas: { width: 1920, height: 1080 } };
const ANIME = { t: T({ x: 891, y: 158 }), w: 939, h: 944, canvas: { width: 1920, height: 1080 } };
const FLAGSHIPS = { GOTHIC, SUNBURST, NOIR, CRIMSON };

describe('characterFitAlign (which fit a character image gets)', () => {
  const align = (p: { t: Transform; w: number; h: number; canvas: { width: number; height: number } }, sw: number, sh: number, cutOff = false) =>
    characterFitAlign(p.t, p.w, p.h, sw, sh, p.canvas, cutOff);

  it('a detected / known cut-off image always gets the cut fit', () => {
    for (const p of Object.values(FLAGSHIPS)) expect(align(p, 308, 481, true)).toBe('cut');
  });

  it('a bust whose cut was not detected (faded bottom, transparent rows under it) still keeps its face on the canvas', () => {
    // bust-faded.png trims to 420×~400 (the fade's last rows are transparent), bust-margin.png to
    // 420×420 (the 3 padding rows go) — neither reaches its image's bottom edge fully opaque.
    for (const [name, p] of Object.entries(FLAGSHIPS)) {
      for (const [sw, sh] of [
        [420, 400],
        [420, 420],
      ]) {
        expect(align(p, sw, sh), `${name} ${sw}×${sh}`).toBe('cut');
        // With 'bottom' (the original bug) the top of the image landed far below the box top;
        // with 'cut' it is where the placeholder's head was.
        const r = fitIntoBox(p.t, p.w, p.h, sw, sh, 'cut', p.canvas);
        const b = bounds(r.transform, r.width, r.height);
        const box = bounds(p.t, p.w, p.h);
        expect(b.y0, name).toBeLessThan(box.y0 + 0.2 * (p.canvas.height - box.y0));
        expect(b.y0, name).toBeGreaterThanOrEqual(0);
      }
    }
    // The original repro numbers: on sunburst the faded bust's head sat at y 233–511 of 512.
    const bad = fitIntoBox(SUNBURST.t, SUNBURST.w, SUNBURST.h, 420, 400, 'bottom');
    expect(bounds(bad.transform, bad.width, bad.height).y0).toBeGreaterThan(300);
  });

  it('a whole figure (taller than the box is wide) keeps its feet planted on every flagship', () => {
    // A trimmed Pose Studio full-body render (308×481) and the synthetic full figures.
    for (const [name, p] of Object.entries(FLAGSHIPS)) {
      expect(align(p, 308, 481), name).toBe('bottom');
      expect(align(p, 300, 620), name).toBe('bottom');
      expect(align(p, 240, 560), name).toBe('bottom');
      // A little wider than the box: the top drops a few percent at most — still planted.
      expect(align(p, Math.round(p.w * 1.05), p.h), name).toBe('bottom');
    }
  });

  it('a wide pose whose top would sink far below the box top gets the cut fit', () => {
    // T-pose full body, 1.3 : 1.
    expect(align(GOTHIC, 650, 500)).toBe('cut');
    const r = fitIntoBox(GOTHIC.t, GOTHIC.w, GOTHIC.h, 650, 500, 'cut', GOTHIC.canvas);
    const b = bounds(r.transform, r.width, r.height);
    expect(b.y1).toBeCloseTo(1024, 0); // feet on the canvas edge, the whole figure shown
    expect(b.y0).toBeLessThan(500);
  });

  it("keeps 'bottom' when planting it costs nothing: box on the canvas, almost square box, or no canvas", () => {
    // The box ends on the canvas: planting a bust on its bottom shows it all.
    expect(characterFitAlign(T({ x: 100, y: 50 }), 300, 400, 420, 420, { width: 1000, height: 1000 }, false)).toBe('bottom');
    // anime-action's box is almost square: a 1:1 bust drops 5 px — its cut lands just off the canvas.
    expect(align(ANIME, 420, 420)).toBe('bottom');
    expect(characterFitAlign(GOTHIC.t, GOTHIC.w, GOTHIC.h, 420, 420, undefined, false)).toBe('bottom');
    // A box (almost) entirely off the canvas.
    expect(characterFitAlign(T({ x: 0, y: 990 }), 300, 900, 420, 420, { width: 1024, height: 1024 }, false)).toBe('bottom');
  });
});

/* ---------------- detecting an image cut off at the bottom ---------------- */

function img(w: number, h: number, paint: (set: (x: number, y: number, a?: number) => void) => void) {
  const data = new Uint8ClampedArray(w * h * 4);
  paint((x, y, a = 255) => {
    const i = (y * w + x) * 4;
    data[i] = 200;
    data[i + 3] = a;
  });
  return { data, width: w, height: h };
}
const rect = (set: (x: number, y: number, a?: number) => void, x0: number, y0: number, x1: number, y1: number, a = 255) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, a);
};

describe('isCutOffAtBottom', () => {
  it('a bust / waist-up image reaches the bottom edge with a straight, wide cut', () => {
    const bust = img(60, 60, (s) => {
      rect(s, 20, 5, 40, 30); // head
      rect(s, 5, 30, 55, 60); // torso, cut by the edge
    });
    expect(isCutOffAtBottom(bust)).toBe(true);
    // T-pose waist-up: arms are the widest part, the cut torso is a third of it.
    const tpose = img(90, 50, (s) => {
      rect(s, 38, 0, 52, 14);
      rect(s, 0, 14, 90, 22);
      rect(s, 30, 14, 60, 50);
    });
    expect(isCutOffAtBottom(tpose)).toBe(true);
    // An opaque photo (background kept) counts as cut off.
    expect(isCutOffAtBottom(img(20, 20, (s) => rect(s, 0, 0, 20, 20)))).toBe(true);
  });

  it('a whole figure with margin below, or with feet that only touch the edge, is not', () => {
    const margin = img(40, 100, (s) => {
      rect(s, 15, 0, 25, 10);
      rect(s, 5, 10, 35, 50);
      rect(s, 12, 50, 28, 95);
    });
    expect(isCutOffAtBottom(margin)).toBe(false);
    // Two narrow feet on the edge (each < 20 % of the figure's width).
    const feet = img(100, 100, (s) => {
      rect(s, 10, 0, 90, 60);
      rect(s, 30, 60, 42, 100);
      rect(s, 58, 60, 70, 100);
    });
    expect(isCutOffAtBottom(feet)).toBe(false);
    // Legs reaching the edge with a soft (anti-aliased / perspective) sole.
    const soft = img(40, 100, (s) => {
      rect(s, 5, 0, 35, 50);
      rect(s, 12, 50, 28, 97);
      rect(s, 12, 97, 28, 100, 120);
    });
    expect(isCutOffAtBottom(soft)).toBe(false);
    expect(isCutOffAtBottom(img(10, 10, () => {}))).toBe(false);
  });
});

describe('Pose Studio renders', () => {
  it('a render whose pixels reach the frame bottom is cut off (Head / Waist-up framing)', () => {
    expect(rendersCutOff({ y: 40, height: 472 }, 512)).toBe(true);
    expect(rendersCutOff({ y: 40, height: 471 }, 512)).toBe(true);
    expect(rendersCutOff({ y: 40, height: 400 }, 512)).toBe(false);
  });
});
