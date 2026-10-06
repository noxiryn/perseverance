/**
 * Asset thumbnails: small cached renders produced lazily during idle time so browsing the
 * library never janks. Components call `requestThumb` when their card scrolls into view.
 */
import type { ParamValues } from '../../core/types';
import type { AssetDef } from '../../registry';
import { assets } from '../../registry';
import { resolveParams } from '../../filters/engine';
import { assetMeta } from './params';
import type { PreviewBg } from './params';
import { assetFontsReady, loadAssetFonts } from './fonts';

/** Deterministic JSON-ish key for param objects (key order independent). Pure. */
export function stableKey(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${k}:${stableKey(o[k])}`)
    .join(',')}}`;
}

/** Render size for an asset preview whose longest side is `max` px. Pure. */
export function previewSize(def: Pick<AssetDef, 'sizing'>, max: number, docAspect = 4 / 3): { width: number; height: number } {
  const w = def.sizing === 'document' ? docAspect : def.sizing.width;
  const h = def.sizing === 'document' ? 1 : def.sizing.height;
  const s = max / Math.max(w, h);
  return { width: Math.max(8, Math.round(w * s)), height: Math.max(8, Math.round(h * s)) };
}

const BG_COLORS: Record<Exclude<PreviewBg, 'checker' | 'none'>, string> = {
  paper: '#e9e5dc',
  dark: '#121212',
  mid: '#6b6f78',
};

let checker: CanvasPattern | null = null;

/** Paint the preview backdrop for an asset (paper, dark, checkerboard…). */
export function paintBackdrop(ctx: CanvasRenderingContext2D, bg: PreviewBg, w: number, h: number) {
  if (bg === 'none') return;
  if (bg === 'checker') {
    if (!checker) {
      const t = document.createElement('canvas');
      t.width = t.height = 12;
      const c = t.getContext('2d')!;
      c.fillStyle = '#3a3a3a';
      c.fillRect(0, 0, 12, 12);
      c.fillStyle = '#2c2c2c';
      c.fillRect(0, 0, 6, 6);
      c.fillRect(6, 6, 6, 6);
      checker = ctx.createPattern(t, 'repeat');
    }
    ctx.fillStyle = checker ?? '#333';
  } else ctx.fillStyle = BG_COLORS[bg];
  ctx.fillRect(0, 0, w, h);
}

/**
 * Render a finished preview canvas (`max` px longest side, backdrop included). Assets are
 * generated at `oversample`× and downscaled so fine lines survive.
 */
export function renderPreview(def: AssetDef, params: ParamValues | undefined, max: number, oversample = 2, docAspect = 4 / 3): HTMLCanvasElement {
  const out = previewSize(def, max, docAspect);
  const gen = previewSize(def, max * oversample, docAspect);
  const c = document.createElement('canvas');
  c.width = out.width;
  c.height = out.height;
  const ctx = c.getContext('2d')!;
  paintBackdrop(ctx, assetMeta.get(def.id)?.bg ?? 'checker', out.width, out.height);
  try {
    const src = def.thumbnail && !params ? def.thumbnail(max * oversample) : def.generate(resolveParams(def, params), gen);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, out.width, out.height);
  } catch (err) {
    console.error(`[assets] preview of "${def.id}" failed`, err);
    ctx.fillStyle = '#5a2a2a';
    ctx.fillRect(0, 0, out.width, out.height);
  }
  return c;
}

/** Placeholder for a thumbnail that can't be rendered (same colour as a failed render). */
function failedThumb(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(1, Math.round(size));
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#5a2a2a';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

/* ------------------------------------------------------------------ */
/* Cache + idle queue                                                  */
/* ------------------------------------------------------------------ */

const THUMB = 128;
const cache = new Map<string, HTMLCanvasElement>();
const MAX_CACHE = 260;

interface Job {
  key: string;
  assetId: string;
  params?: ParamValues;
  size: number;
  cbs: ((c: HTMLCanvasElement) => void)[];
  priority: number;
}

const queue = new Map<string, Job>();
let scheduled = false;
let seq = 0;

function keyOf(assetId: string, params: ParamValues | undefined, size: number) {
  return `${assetId}|${size}|${params ? stableKey(params) : ''}`;
}

/** Cached thumbnail, if already rendered. */
export function getThumb(assetId: string, params?: ParamValues, size = THUMB): HTMLCanvasElement | null {
  return cache.get(keyOf(assetId, params, size)) ?? null;
}

function store(key: string, c: HTMLCanvasElement) {
  cache.set(key, c);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

type IdleCb = (deadline: { timeRemaining(): number; didTimeout: boolean }) => void;
const ric: (cb: IdleCb, opts?: { timeout: number }) => number =
  typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? (cb, opts) => (window as unknown as { requestIdleCallback: (c: IdleCb, o?: { timeout: number }) => number }).requestIdleCallback(cb, opts)
    : (cb) => window.setTimeout(() => cb({ timeRemaining: () => 8, didTimeout: true }), 16);

function schedule() {
  if (scheduled || !queue.size) return;
  scheduled = true;
  ric(run, { timeout: 400 });
}

/** Measured render cost per asset (ms, moving average) — used to fit jobs into idle slices. */
const cost = new Map<string, number>();
/** Assumed cost of an asset that was never rendered yet. */
const UNKNOWN_COST = 24;
/** A job up to this cost may overrun an idle slice (once per slice) — one frame at worst. */
const SMALL_OVERRUN = 24;
/** Heavier jobs run at most this often (ms) when they never fit an idle slice. */
const HEAVY_SPACING = 250;
/** Thumbnails are generated slightly above their display size (cards show them at ≤ 128 CSS px). */
const THUMB_OVERSAMPLE = 1.25;
const COST_KEY = 'perseverance.assets.thumbCost';

// costs measured in earlier sessions (a per-viewer convenience; safe to lose)
try {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(COST_KEY) : null;
  if (saved) for (const [k, v] of Object.entries(JSON.parse(saved) as Record<string, number>)) if (typeof v === 'number' && v >= 0) cost.set(k, v);
} catch {
  /* storage unavailable */
}
let saveTimer = 0;
function saveCosts() {
  if (saveTimer || typeof window === 'undefined') return;
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    try {
      localStorage.setItem(COST_KEY, JSON.stringify(Object.fromEntries([...cost].map(([k, v]) => [k, Math.round(v * 10) / 10]))));
    } catch {
      /* storage unavailable */
    }
  }, 3000);
}

/** Since when (performance.now) jobs have been waiting without any render; 0 = not starving. */
let starvedSince = 0;

/**
 * Whether a job of estimated cost `est` may start now. Pure (exported for tests).
 * - it fits the rest of the idle period, or
 * - nothing ran in this slice yet and it is small (a single short overrun), or
 * - nothing ran in this slice and the queue has been starving (or the idle callback timed out).
 */
export function mayRun(est: number, left: number, renderedInSlice: number, starving: boolean): boolean {
  if (est <= left + 2) return true;
  if (renderedInSlice > 0) return false;
  return est <= SMALL_OVERRUN || starving;
}

function run(deadline: { timeRemaining(): number; didTimeout: boolean }) {
  scheduled = false;
  // most recently requested first (what the user is looking at)
  const jobs = [...queue.values()].sort((a, b) => b.priority - a.priority);
  let rendered = 0;
  let waitingForFonts = false;
  for (const job of jobs) {
    if (queue.get(job.key) !== job) continue; // cancelled or superseded meanwhile
    const def = assets.get(job.assetId);
    if (!def) {
      // Unregistered (e.g. a user asset deleted meanwhile): answer with the failure placeholder (not
      // cached) so no card waits — and shimmers — forever.
      queue.delete(job.key);
      const c = failedThumb(job.size);
      for (const cb of job.cbs) cb(c);
      continue;
    }
    // text-drawing assets wait for their fonts (loaded off this slice, then re-scheduled)
    if (assetMeta.get(def.id)?.fonts && !assetFontsReady()) {
      waitingForFonts = true;
      continue;
    }
    const hit = cache.get(job.key);
    if (hit) {
      queue.delete(job.key);
      for (const cb of job.cbs) cb(hit);
      continue;
    }
    const est = cost.get(def.id) ?? UNKNOWN_COST;
    const starving = deadline.didTimeout || (starvedSince > 0 && performance.now() - starvedSince > HEAVY_SPACING);
    if (!mayRun(est, deadline.timeRemaining(), rendered, starving)) {
      if (!starvedSince && !rendered) starvedSince = performance.now();
      continue;
    }
    queue.delete(job.key);
    const t0 = performance.now();
    const c = renderPreview(def, job.params, job.size, THUMB_OVERSAMPLE);
    const dt = performance.now() - t0;
    cost.set(def.id, cost.has(def.id) ? cost.get(def.id)! * 0.5 + dt * 0.5 : dt);
    saveCosts();
    store(job.key, c);
    for (const cb of job.cbs) cb(c);
    rendered++;
    starvedSince = 0;
    if (deadline.timeRemaining() <= 1) break;
  }
  // heavy jobs left over: they become due HEAVY_SPACING ms after this point
  if (rendered && queue.size) starvedSince = performance.now();
  if (waitingForFonts && !assetFontsReady()) void loadAssetFonts().then(schedule);
  schedule();
}

/**
 * Ask for a thumbnail; `cb` is called (possibly synchronously) with the canvas. Returns a
 * cancel function (drops the callback if the card scrolled away before rendering).
 */
export function requestThumb(assetId: string, cb: (c: HTMLCanvasElement) => void, params?: ParamValues, size = THUMB): () => void {
  const key = keyOf(assetId, params, size);
  const hit = cache.get(key);
  if (hit) {
    cb(hit);
    return () => undefined;
  }
  let job = queue.get(key);
  if (!job) {
    job = { key, assetId, params, size, cbs: [], priority: ++seq };
    queue.set(key, job);
  } else job.priority = ++seq;
  job.cbs.push(cb);
  schedule();
  const j = job;
  return () => {
    j.cbs = j.cbs.filter((f) => f !== cb);
    // only drop the job this closure belongs to (a newer job may own the key by now)
    if (!j.cbs.length && queue.get(key) === j) queue.delete(key);
  };
}

/** Drop cached thumbnails of an asset (e.g. a user asset was deleted/renamed). */
export function invalidateThumbs(assetId: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${assetId}|`)) cache.delete(k);
}
