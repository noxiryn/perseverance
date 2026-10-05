/**
 * One-time canvas backend probe: does drawing part of an image (a crop, or the whole image through
 * a clip) give exactly the pixels of drawing it whole?
 *
 * Region updates during live painting rely on that: they blur / resample / fill only the changed
 * part of a layer and blit it into the cached render. Chrome's software canvas reproduces a whole
 * render exactly; accelerated (GPU) canvases do not — blurs are downsampled on a grid that follows
 * the surface, and resampling / gradient dithering of a clipped quad can differ by a few levels.
 * Work that is only exact on an exact backend is therefore marked approximate (and re-rendered
 * exactly once painting pauses) only when this probe finds the backend inexact.
 *
 * The probe uses canvases created like the renderer's (same size class, no willReadFrequently),
 * so it sees the same backend. Any failure counts as inexact (conservative).
 */
import { fresh } from './surface';

let result: boolean | null = null;
let scheduled = false;

/** Deterministic pseudo random generator. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function ctxOf(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const k = c.getContext('2d');
  if (!k) throw new Error('no 2d context');
  return k;
}

/** Busy test image: soft discs, translucent boxes, a hard diagonal and an alpha ramp. */
function testImage(n: number): HTMLCanvasElement {
  const c = fresh(n, n);
  const g = ctxOf(c);
  const R = rng(7);
  for (let i = 0; i < 14; i++) {
    const x = R() * n,
      y = R() * n,
      r = 10 + R() * n * 0.25;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `hsla(${Math.floor(R() * 360)},80%,55%,${0.5 + R() * 0.5})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
    g.fillStyle = `hsla(${Math.floor(R() * 360)},70%,45%,${0.3 + R() * 0.7})`;
    g.fillRect(R() * n, R() * n, 8 + R() * 60, 8 + R() * 60);
  }
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(0, n * 0.1);
  g.lineTo(n, n * 0.85);
  g.stroke();
  return c;
}

/** Read a canvas through a CPU copy (the probed canvas is left as it is). */
function pixels(c: HTMLCanvasElement, x: number, y: number, w: number, h: number): Uint8ClampedArray {
  const r = document.createElement('canvas');
  r.width = w;
  r.height = h;
  const k = r.getContext('2d', { willReadFrequently: true });
  if (!k) throw new Error('no 2d context');
  k.drawImage(c, -x, -y);
  return k.getImageData(0, 0, w, h).data;
}

function same(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function probe(): boolean {
  if (typeof document === 'undefined' || /jsdom/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent)) return false;
  const N = 320;
  const src = testImage(N);
  // 1) Blur of a crop vs of the whole surface (effects and feathered masks: ctx.filter blurs),
  //    a large sigma (downsampled on GPUs) and a small one; the crop is grid-aligned like the
  //    renderer's (see region.alignRect).
  for (const sigma of [9, 2.5]) {
    const whole = fresh(N, N);
    const wg = ctxOf(whole);
    wg.filter = `blur(${sigma}px)`;
    wg.drawImage(src, 0, 0);
    wg.filter = 'none';
    const o = 128,
      cw = 160,
      m = Math.ceil(sigma * 3) + 2;
    const crop = fresh(cw, cw);
    const cg = ctxOf(crop);
    cg.filter = `blur(${sigma}px)`;
    cg.drawImage(src, -o, -o);
    cg.filter = 'none';
    if (!same(pixels(whole, o + m, o + m, cw - 2 * m, cw - 2 * m), pixels(crop, m, m, cw - 2 * m, cw - 2 * m))) return false;
  }
  // 2) Resampled (rotated / scaled / minified) draws and gradient / pattern fills through a clip
  //    vs drawn whole (transformed layers, gradient fills, the viewport's pre-scaled copy).
  const draws: ((g: CanvasRenderingContext2D) => void)[] = [
    (g) => {
      g.setTransform(new DOMMatrix().translateSelf(40.3, 12.7).rotateSelf(21).scaleSelf(0.83, 1.17));
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0);
    },
    (g) => {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, N, N, 0, 0, N * 0.37, N * 0.37);
    },
    (g) => {
      const lin = g.createLinearGradient(10, 20, N - 30, N - 5);
      lin.addColorStop(0, '#203040');
      lin.addColorStop(0.5, 'rgba(250,120,30,0.7)');
      lin.addColorStop(1, '#c0a080');
      g.fillStyle = lin;
      g.fillRect(0, 0, N, N);
      const pat = g.createPattern(src, 'repeat');
      if (pat) {
        pat.setTransform(new DOMMatrix().scaleSelf(0.61, 0.61).rotateSelf(13));
        g.globalAlpha = 0.6;
        g.fillStyle = pat;
        g.fillRect(0, 0, N, N);
      }
    },
  ];
  const clip = { x: 101, y: 87, w: 133, h: 121 };
  for (const draw of draws) {
    const whole = fresh(N, N);
    draw(ctxOf(whole));
    const part = fresh(N, N);
    const pg = ctxOf(part);
    pg.save();
    pg.beginPath();
    pg.rect(clip.x, clip.y, clip.w, clip.h);
    pg.clip();
    draw(pg);
    pg.restore();
    if (!same(pixels(whole, clip.x, clip.y, clip.w, clip.h), pixels(part, clip.x, clip.y, clip.w, clip.h))) return false;
  }
  return true;
}

function runProbe(): boolean {
  try {
    result = probe();
  } catch {
    result = false;
  }
  return result;
}

/**
 * Probe the backend when the browser is idle (the first probe can take a while on a software-
 * emulated GPU: it warms up blur shaders). Called early by the viewport; idempotent.
 */
export function scheduleBackendProbe() {
  if (result !== null || scheduled || typeof window === 'undefined') return;
  scheduled = true;
  const run = () => {
    if (result === null) runProbe();
  };
  const ric = (window as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(run, { timeout: 4000 });
  else setTimeout(run, 300);
}

/**
 * Whether region work on crops / through clips reproduces whole-surface rendering exactly on this
 * canvas backend. Never blocks: until the (idle-time) probe has run, the answer is false — work
 * is treated as approximate, which is always correct, merely slower to settle.
 */
export function cropExactBackend(): boolean {
  if (result === null) scheduleBackendProbe();
  return result ?? false;
}

/** Run the probe now (tests, diagnostics) and return its result. */
export function probeBackendNow(): boolean {
  return runProbe();
}

/** @internal Tests / diagnostics: force a probe result (null = unknown, probed again at idle). */
export function setCropExactBackend(v: boolean | null) {
  result = v;
  scheduled = false;
}
