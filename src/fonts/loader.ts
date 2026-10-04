/**
 * Font loading contract. Canvas text only renders with a font once it is loaded, so the
 * compositor calls `ensureFont` and re-renders when the returned promise resolves.
 * The fonts module (src/fonts/*) registers bundled fonts (CSS @font-face via @fontsource) and
 * system fonts into the `fonts` registry.
 */
import { invalidateRenderCache } from '../render/compositor';
import { viewport } from '../editor/viewport';

const loaded = new Set<string>();
const pending = new Map<string, Promise<void>>();

const key = (family: string, weight: number, style: string) => `${family}|${weight}|${style}`;

/** Whether a face is ready for canvas rendering. */
export function isFontReady(family: string, weight = 400, style = 'normal'): boolean {
  return loaded.has(key(family, weight, style));
}

/**
 * Ensure a font face is loaded. Resolves when ready (or on failure — the browser then falls back).
 * Triggers a re-render after a face finishes loading.
 */
export function ensureFont(family: string, weight = 400, style = 'normal'): Promise<void> {
  const k = key(family, weight, style);
  if (loaded.has(k)) return Promise.resolve();
  let p = pending.get(k);
  if (!p) {
    p = document.fonts
      .load(`${style} ${weight} 32px "${family}"`, 'AaBb漢字')
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        loaded.add(k);
        pending.delete(k);
        invalidateRenderCache();
        viewport.requestRender();
      });
    pending.set(k, p);
  }
  return p;
}

/** Load every face a document uses (call before export so text renders with the right fonts). */
export async function ensureDocumentFonts(families: { family: string; weight: number; style: string }[]): Promise<void> {
  await Promise.all(families.map((f) => ensureFont(f.family, f.weight, f.style)));
}
