/**
 * Font loading contract. Canvas text only renders with a font once it is loaded, so the
 * compositor calls `ensureFont` and re-renders when the returned promise resolves.
 * The fonts module (src/fonts/*) registers bundled fonts (FontFace declarations for the
 * @fontsource files — nothing downloads until a face is used), system fonts and user fonts into
 * the `fonts` registry.
 *
 * Stable API: `ensureFont`, `isFontReady`, `ensureDocumentFonts`.
 * Extensions: `registerFontPreparer` (lazy face registration hook), `isFamilyInUse`,
 * `fontWeightFor` (nearest available weight).
 */
import { invalidateRenderCache } from '../render/compositor';
import { viewport } from '../editor/viewport';
import { useEditor } from '../state/editor';

const loaded = new Set<string>();
const pending = new Map<string, Promise<void>>();

const key = (family: string, weight: number, style: string) => `${normFamily(family)}|${weight}|${style}`;

function normFamily(f: string): string {
  return f.replace(/["']/g, '').trim().toLowerCase();
}

/**
 * Hook run before a family is loaded. The fonts module uses it to register faces that are
 * declared lazily (e.g. the Japanese unicode-range manifests). Must never reject.
 */
export type FontPreparer = (family: string) => Promise<void> | void;
const preparers: FontPreparer[] = [];

export function registerFontPreparer(fn: FontPreparer) {
  preparers.push(fn);
}

function prepare(family: string): Promise<void> {
  if (!preparers.length) return Promise.resolve();
  return Promise.all(
    preparers.map((p) => {
      try {
        return Promise.resolve(p(family)).catch(() => undefined);
      } catch {
        return undefined;
      }
    }),
  ).then(() => undefined);
}

/** True when any open document has a text layer using this family. */
export function isFamilyInUse(family: string): boolean {
  const n = normFamily(family);
  const { sessions } = useEditor.getState();
  for (const s of Object.values(sessions)) {
    for (const l of Object.values(s.doc.layers)) {
      if (l.type === 'text' && normFamily(l.text.fontFamily || '') === n) return true;
    }
  }
  return false;
}

/** Re-render the canvas after a face that documents use has finished loading. */
function refreshIfUsed(families: Iterable<string>) {
  for (const f of families) {
    if (isFamilyInUse(f)) {
      invalidateRenderCache();
      viewport.requestRender();
      return;
    }
  }
}

/** Whether a face is ready for canvas rendering. */
export function isFontReady(family: string, weight = 400, style = 'normal'): boolean {
  return loaded.has(key(family, weight, style));
}

/** Text used to trigger loading (covers latin + the most common kana/kanji slices). */
const DEFAULT_SAMPLE = 'AaBb0あア漢字';

/**
 * Ensure a font face is loaded. Resolves when ready (or on failure — the browser then falls back).
 * Triggers a re-render after a face finishes loading when an open document uses it.
 * `text` (optional) makes sure the unicode-range slices covering that text are loaded too.
 */
export function ensureFont(family: string, weight = 400, style = 'normal', text?: string): Promise<void> {
  const k = key(family, weight, style);
  if (loaded.has(k) && !text) return Promise.resolve();
  const pk = text ? `${k}|${text}` : k;
  let p = pending.get(pk);
  if (!p) {
    installLoadingListener();
    p = prepare(family)
      .then(() =>
        typeof document !== 'undefined' && document.fonts
          ? document.fonts.load(`${style} ${weight} 32px "${family.replace(/"/g, '')}"`, text || DEFAULT_SAMPLE)
          : [],
      )
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        loaded.add(k);
        pending.delete(pk);
        refreshIfUsed([family]);
      });
    pending.set(pk, p);
  }
  return p;
}

/** Load every face a document uses (call before export so text renders with the right fonts). */
export async function ensureDocumentFonts(families: { family: string; weight: number; style: string }[]): Promise<void> {
  await Promise.all(families.map((f) => ensureFont(f.family, f.weight, f.style)));
}

/** Nearest available weight of a family (`weights` from its FontDef). */
export function fontWeightFor(weights: number[] | undefined, wanted: number): number {
  if (!weights?.length) return wanted;
  return weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), weights[0]);
}

/* ------------------------------------------------------------------ */
/* Faces loaded implicitly (DOM previews, canvas text, unicode slices)  */
/* ------------------------------------------------------------------ */

let listening = false;

function installLoadingListener() {
  if (listening || typeof document === 'undefined' || !document.fonts?.addEventListener) return;
  listening = true;
  let queued = new Set<string>();
  let timer = 0;
  document.fonts.addEventListener('loadingdone', (e: Event) => {
    const faces = (e as FontFaceSetLoadEvent).fontfaces ?? [];
    for (const f of faces) {
      const fam = f.family.replace(/["']/g, '');
      const w = parseInt(String(f.weight), 10) || 400;
      loaded.add(key(fam, w, f.style === 'italic' ? 'italic' : 'normal'));
      queued.add(fam);
    }
    if (timer) return;
    // Batch bursts (unicode-range slices arrive in groups).
    timer = window.setTimeout(() => {
      timer = 0;
      const fams = queued;
      queued = new Set();
      refreshIfUsed(fams);
    }, 40);
  });
}

if (typeof document !== 'undefined') installLoadingListener();
