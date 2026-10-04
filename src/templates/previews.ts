/**
 * Template preview thumbnails: each template is built once at low bitmap resolution, rendered
 * with the compositor after its fonts load, cached as a data URL, and its bitmaps are freed.
 * Rendering runs in an idle queue; the dialog pauses it while a template is being opened and
 * cancels what's still queued when it closes (finished previews stay cached).
 */
import { useEffect, useState } from 'react';
import { templates } from '../registry';
import { renderDocument } from '../render/compositor';
import { docBitmapIds, docFonts, dropBitmaps, forgetLayers, IdleQueue, loadFonts } from '../looks/shared';
import { buildTemplate, hasTemplateSpec } from './define';

export const TEMPLATE_PREVIEW_SIZE = 320;

const cache = new Map<string, string>();
const pending = new Map<string, { promise: Promise<string | null>; resolve: (url: string | null) => void }>();
const listeners = new Set<() => void>();
const queue = new IdleQueue();

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
  let resolve!: (url: string | null) => void;
  const promise = new Promise<string | null>((r) => (resolve = r)).then((url) => {
    pending.delete(id);
    if (url) {
      cache.set(id, url);
      listeners.forEach((l) => l());
    }
    return url;
  });
  pending.set(id, { promise, resolve });
  queue.push(
    id,
    async () => {
      try {
        resolve(await renderTemplatePreview(id));
      } catch (e) {
        console.warn(`[templates] preview of ${id} failed`, e);
        resolve(null);
      }
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

/** Drop queued (not yet started) preview jobs; their promises resolve with null. */
export function cancelPendingTemplatePreviews() {
  for (const id of queue.clear()) pending.get(id)?.resolve(null);
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
    forgetLayers(Object.keys(doc.layers));
    dropBitmaps(docBitmapIds(doc));
  }
}

/** React hook: preview URL of a template, requested lazily when `visible` becomes true. */
export function useTemplatePreview(id: string, visible: boolean, priority = 0): string | null {
  const [url, setUrl] = useState<string | null>(() => getTemplatePreview(id));
  useEffect(() => {
    const sync = () => setUrl(getTemplatePreview(id));
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, [id]);
  useEffect(() => {
    if (!visible || getTemplatePreview(id)) return;
    void loadTemplatePreview(id, priority);
  }, [id, visible, priority]);
  return url;
}

/** Drop cached previews (e.g. after fonts finish loading). */
export function clearTemplatePreviews() {
  cache.clear();
  listeners.forEach((l) => l());
}
