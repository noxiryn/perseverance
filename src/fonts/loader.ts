/**
 * Font loading contract. Canvas text only renders with a font once it is loaded, so the
 * compositor calls `ensureFont` and re-renders when the returned promise resolves.
 * The fonts module (src/fonts/*) registers bundled fonts (FontFace declarations for the
 * @fontsource files — nothing downloads until a face is used), system fonts and user fonts into
 * the `fonts` registry.
 *
 * Stable API: `ensureFont`, `isFontReady`, `ensureDocumentFonts`.
 * Extensions: `registerFontPreparer` (lazy face registration hook), `isFamilyInUse`,
 * `fontWeightFor` (nearest available weight), optional per-entry `text` in `ensureDocumentFonts`.
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

const fontSpec = (family: string, weight: number, style: string) =>
  `${style} ${weight} 32px "${family.replace(/"/g, '')}"`;

/** True when every face needed to draw `text` is already loaded (never throws). */
function facesReady(family: string, weight: number, style: string, text: string): boolean {
  try {
    return typeof document !== 'undefined' && !!document.fonts && document.fonts.check(fontSpec(family, weight, style), text);
  } catch {
    return false;
  }
}

/**
 * Ensure a font face is loaded. Resolves when ready (or on failure — the browser then falls back).
 * Triggers a re-render after a face finishes loading when an open document uses it.
 * `text` (optional) makes sure the unicode-range slices covering that text are loaded too.
 */
export function ensureFont(family: string, weight = 400, style = 'normal', text?: string): Promise<void> {
  const k = key(family, weight, style);
  // Already loaded: nothing to do unless `text` needs unicode-range slices that are not in yet.
  if (loaded.has(k) && (!text || facesReady(family, weight, style, text))) return Promise.resolve();
  const pk = text ? `${k}|${text}` : k;
  let p = pending.get(pk);
  if (!p) {
    installLoadingListener();
    p = prepare(family)
      .then(() =>
        typeof document !== 'undefined' && document.fonts
          ? document.fonts.load(fontSpec(family, weight, style), text || DEFAULT_SAMPLE)
          : [],
      )
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        const first = !loaded.has(k);
        loaded.add(k);
        pending.delete(pk);
        // Later slice loads are picked up by the 'loadingdone' listener (batched), so only the
        // first resolution of a face needs to refresh documents explicitly.
        if (first) refreshIfUsed([family]);
      });
    pending.set(pk, p);
  }
  return p;
}

/** Non-latin text of every open document's text layers that use `family` (for unicode slices). */
function documentTextFor(family: string): string | undefined {
  const n = normFamily(family);
  const chars = new Set<string>();
  for (const s of Object.values(useEditor.getState().sessions)) {
    for (const l of Object.values(s.doc.layers)) {
      if (l.type !== 'text' || normFamily(l.text.fontFamily || '') !== n) continue;
      for (const ch of l.text.content ?? '') if (ch.codePointAt(0)! > 0x24f) chars.add(ch);
    }
  }
  return chars.size ? [...chars].join('') : undefined;
}

/**
 * Load every face a document uses (call before export so text renders with the right fonts).
 * `text` (optional per entry) also loads the unicode-range slices it needs; when omitted, the
 * non-latin characters of open documents' text layers using that family are covered
 * automatically (e.g. kanji in a Japanese font).
 */
export async function ensureDocumentFonts(
  families: { family: string; weight: number; style: string; text?: string }[],
): Promise<void> {
  await Promise.all(
    families.map((f) => ensureFont(f.family, f.weight || 400, f.style || 'normal', f.text ?? documentTextFor(f.family))),
  );
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
