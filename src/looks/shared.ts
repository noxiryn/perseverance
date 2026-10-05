/**
 * Small helpers shared by the Looks and Templates modules: off-store preview rendering support
 * (bitmap cleanup, font readiness), and an idle work queue for lazy thumbnails.
 */
import type { Document, ID } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { ensureFont } from '../fonts/loader';

/** Every bitmap id referenced by a document (raster contents + masks + selection). */
export function docBitmapIds(doc: Document): Set<ID> {
  const out = new Set<ID>();
  for (const l of Object.values(doc.layers)) {
    if (l.type === 'raster') out.add(l.bitmapId);
    if (l.mask) out.add(l.mask.bitmapId);
  }
  if (doc.selection) out.add(doc.selection.bitmapId);
  return out;
}

/**
 * Remove specific bitmaps from the store right away (used for throw-away preview documents so
 * their full-size pixels don't linger until the next history GC). Only touches the given ids.
 */
export function dropBitmaps(ids: Iterable<ID>) {
  const drop = new Set(ids);
  if (!drop.size) return;
  const keep = new Set(bitmaps.ids().filter((id) => !drop.has(id)));
  bitmaps.retainOnly(keep, -1);
}

/** Font faces used by the text layers of a document (with the characters they need). */
export function docFonts(doc: Document): FontRequest[] {
  const seen = new Map<string, FontRequest>();
  for (const l of Object.values(doc.layers)) {
    if (l.type !== 'text') continue;
    const k = `${l.text.fontFamily}|${l.text.fontWeight}|${l.text.fontStyle}`;
    const prev = seen.get(k);
    const text = uniqueChars(`${prev?.text ?? ''}${l.text.content}`);
    seen.set(k, { family: l.text.fontFamily, weight: l.text.fontWeight, style: l.text.fontStyle, text });
  }
  return [...seen.values()];
}

export interface FontRequest {
  family: string;
  weight?: number;
  style?: string;
  /** Characters that must be renderable (loads the matching unicode-range slices, e.g. kanji). */
  text?: string;
}

function uniqueChars(s: string): string {
  return Array.from(new Set(Array.from(s.replace(/\s+/g, '')))).join('').slice(0, 200);
}

/** Load font faces, giving up after `timeoutMs` (the browser then falls back). */
export async function loadFonts(list: FontRequest[], timeoutMs = 3000): Promise<void> {
  if (!list.length) return;
  const all = Promise.all(
    list.map((f) => {
      // Non-latin text needs its own unicode-range slices; latin is covered by the default sample.
      const extra = f.text && /[^\u0000-\u024f]/.test(f.text) ? f.text : undefined;
      return ensureFont(f.family, f.weight ?? 400, f.style ?? 'normal', extra);
    }),
  );
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
}

/**
 * Resolve after the browser has had a chance to paint (e.g. a "Building…" state set right
 * before a long synchronous task). Falls back to a timer when frames aren't produced (hidden tab).
 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 120);
  });
}

/* ------------------------------------------------------------------ */
/* Pointer state (background work waits while the user drags/paints)   */
/* ------------------------------------------------------------------ */

let pointerDown = false;
let pointerTracking = false;

/** True while a mouse button / pen / finger is down anywhere in the window. */
export function isPointerDown(): boolean {
  if (!pointerTracking && typeof window !== 'undefined') {
    pointerTracking = true;
    const down = () => (pointerDown = true);
    const up = () => (pointerDown = false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
  }
  return pointerDown;
}

/* ------------------------------------------------------------------ */
/* Idle queue: run thumbnail jobs one at a time without blocking input  */
/* ------------------------------------------------------------------ */

type Job = { key: string; run: () => void | Promise<void>; priority: number };

const hasIdle = typeof window !== 'undefined' && 'requestIdleCallback' in window;

export interface IdleQueueOptions {
  /** requestIdleCallback timeout (ms): forces progress even when the page is never idle. Omit to wait for real idle time. */
  idleTimeout?: number;
  /** Jobs wait while this returns false (re-checked every 250 ms). */
  canRun?: () => boolean;
}

export class IdleQueue {
  private jobs: Job[] = [];
  private running = false;
  private paused = false;

  constructor(private readonly opts: IdleQueueOptions = {}) {}

  /** Hold queued jobs (e.g. while a heavy foreground task runs); the running job finishes. */
  pause() {
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pump();
  }

  /** Queue a job (replaces a pending job with the same key). Lower priority runs first. */
  push(key: string, run: Job['run'], priority = 0) {
    this.jobs = this.jobs.filter((j) => j.key !== key);
    this.jobs.push({ key, run, priority });
    this.jobs.sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  cancel(key: string) {
    this.jobs = this.jobs.filter((j) => j.key !== key);
  }

  has(key: string) {
    return this.jobs.some((j) => j.key === key);
  }

  /** Drop all queued jobs; returns their keys. */
  clear(): string[] {
    const keys = this.jobs.map((j) => j.key);
    this.jobs = [];
    return keys;
  }

  get pending() {
    return this.jobs.length;
  }

  private pump() {
    if (this.running || this.paused || !this.jobs.length) return;
    this.running = true;
    const next = () => {
      if (this.opts.canRun && !this.opts.canRun()) {
        window.setTimeout(() => this.schedule(next), 250);
        return;
      }
      const job = this.paused ? undefined : this.jobs.shift();
      if (!job) {
        this.running = false;
        return;
      }
      Promise.resolve()
        .then(job.run)
        .catch((e) => console.warn(`[preview] ${job.key} failed`, e))
        .finally(() => {
          if (!this.jobs.length || this.paused) {
            this.running = false;
            return;
          }
          this.schedule(next);
        });
    };
    this.schedule(next);
  }

  private schedule(fn: () => void) {
    if (hasIdle) {
      const w = window as Window & typeof globalThis;
      if (this.opts.idleTimeout !== undefined) w.requestIdleCallback(() => fn(), { timeout: this.opts.idleTimeout });
      else w.requestIdleCallback(() => fn());
    } else setTimeout(fn, 16);
  }
}
