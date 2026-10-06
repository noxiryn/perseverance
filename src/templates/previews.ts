/**
 * Template preview thumbnails: each template is built once at low bitmap resolution, rendered
 * with the compositor after its fonts load, cached as a data URL, and its bitmaps are freed.
 * Rendering runs in an idle queue; the dialog pauses it while a template is being opened and
 * cancels what's still queued when it closes (finished previews stay cached).
 */
import { useEffect, useState } from 'react';
import { templates } from '../registry';
import { renderDocument } from '../render/compositor';
import { docBitmapIds, docFonts, dropBitmaps, IdleQueue, loadFonts } from '../looks/shared';
import { buildTemplate, hasTemplateSpec } from './define';

export const TEMPLATE_PREVIEW_SIZE = 320;

const cache = new Map<string, string>();
const pending = new Map<string, { promise: Promise<string | null>; resolve: (url: string | null) => void }>();
/** Templates whose preview could not be rendered: not retried automatically (a cancelled one is). */
const failed = new Set<string>();
const listeners = new Set<() => void>();
// The dialog is modal (no editing underneath), so make steady progress even if never idle.
const queue = new IdleQueue({ idleTimeout: 250 });

/** Cached preview (data URL) or null if not rendered yet. */
export function getTemplatePreview(id: string): string | null {
  return cache.get(id) ?? null;
}

/** Render (once) and cache the preview of a template. Resolves with a data URL (or null on failure/cancel). */
export function loadTemplatePreview(id: string, priority = 0): Promise<string | null> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  const existing = pending.get(id);
  if (existing) return existing.promise;
  failed.delete(id);
  let resolve!: (url: string | null) => void;
  const promise: Promise<string | null> = new Promise<string | null>((r) => (resolve = r)).then((url) => {
    // A cancel already dropped this entry, and a new request may have replaced it since: only
    // remove our own (otherwise the new request would be orphaned and its card never updated).
    if (pending.get(id)?.promise === promise) pending.delete(id);
    if (url) cache.set(id, url);
    // also on failure / cancel: cards stop showing "loading"
    listeners.forEach((l) => l());
    return url;
  });
  pending.set(id, { promise, resolve });
  listeners.forEach((l) => l());
  queue.push(
    id,
    async () => {
      let url: string | null = null;
      try {
        url = await renderTemplatePreview(id);
      } catch (e) {
        console.warn(`[templates] preview of ${id} failed`, e);
      }
      if (!url) failed.add(id);
      resolve(url);
    },
    priority,
  );
  return promise;
}

/** Pause/resume preview rendering (the job in progress finishes). */
export function pauseTemplatePreviews(paused: boolean) {
  if (paused) queue.pause();
  else queue.resume();
}

/**
 * Drop queued (not yet started) preview jobs; their promises resolve with null. Their entries are
 * removed right away, so a card that asks again in the same commit (the start screen's, when the
 * New from Template dialog closes and cancels everything still queued) gets a fresh job instead
 * of the cancelled promise.
 */
export function cancelPendingTemplatePreviews() {
  for (const id of queue.clear()) {
    const entry = pending.get(id);
    pending.delete(id);
    entry?.resolve(null);
  }
}

async function renderTemplatePreview(id: string): Promise<string | null> {
  const def = templates.get(id);
  if (!def) return null;
  const scale = Math.min(1, TEMPLATE_PREVIEW_SIZE / Math.max(def.width, def.height));
  // Build with bitmaps at ~2× the preview resolution (assets scale with the document size).
  const { doc } = hasTemplateSpec(id) ? await buildTemplate(id, { preview: Math.min(1, scale * 2) }) : { doc: await def.build() };
  try {
    await loadFonts(docFonts(doc), 3000);
    const canvas = renderDocument(doc, { scale });
    return canvas.toDataURL('image/png');
  } finally {
    // Render-cache slots of this throw-away document are never hit again; the LRU evicts them
    // (invalidating would also drop the open document's composites).
    dropBitmaps(docBitmapIds(doc));
  }
}

export interface TemplatePreviewState {
  /** Cached preview (data URL), or null. */
  url: string | null;
  /**
   * The preview is queued or rendering. Cards animate their placeholder only then: one that is
   * off screen, cancelled or failed shows a still placeholder (an idle screen runs no animation).
   */
  loading: boolean;
}

function previewState(id: string): TemplatePreviewState {
  const url = getTemplatePreview(id);
  return { url, loading: !url && pending.has(id) };
}

/** React hook: preview of a template and whether it is being produced, requested lazily when `visible` becomes true. */
export function useTemplatePreviewState(id: string, visible: boolean, priority = 0): TemplatePreviewState {
  const [state, setState] = useState<TemplatePreviewState>(() => previewState(id));
  useEffect(() => {
    const sync = () =>
      setState((prev) => {
        const next = previewState(id);
        return prev.url === next.url && prev.loading === next.loading ? prev : next;
      });
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, [id]);
  // Request when the card becomes visible, and again if a request ended without a preview while
  // it still is (cancelled by someone else, or the cache was cleared) — but not after a failure,
  // which would otherwise retry forever.
  const idle = !state.url && !state.loading;
  useEffect(() => {
    if (!visible || !idle || getTemplatePreview(id) || failed.has(id)) return;
    void loadTemplatePreview(id, priority);
  }, [id, visible, priority, idle]);
  return state;
}

/** React hook: preview URL of a template, requested lazily when `visible` becomes true. */
export function useTemplatePreview(id: string, visible: boolean, priority = 0): string | null {
  return useTemplatePreviewState(id, visible, priority).url;
}

/** Drop cached previews (e.g. after fonts finish loading). */
export function clearTemplatePreviews() {
  cache.clear();
  failed.clear();
  listeners.forEach((l) => l());
}
