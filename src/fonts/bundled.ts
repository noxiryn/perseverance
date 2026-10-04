/**
 * Bundled fonts: declares a FontFace for every shipped @fontsource file (woff2 only) and registers
 * one FontDef per family. FontFace objects start "unloaded" — a file is only fetched when the face
 * is used (DOM text, canvas text or `ensureFont`). Japanese families are split into ~120
 * unicode-range slices each; their manifest is a separate lazy chunk registered on first use or
 * when the app is idle.
 */
import { fonts, type FontDef } from '../registry';
import { registerFontPreparer } from './loader';
import { CATALOG, fallbackCategory } from './catalog';
import { BUNDLED_FAMILIES, LATIN_FACES, LATIN_RANGE } from './generated/faces';

const JAPANESE = new Set(BUNDLED_FAMILIES.filter((f) => f.japanese).map((f) => f.family.toLowerCase()));

function canUseFontFace(): boolean {
  return typeof document !== 'undefined' && !!document.fonts && typeof FontFace !== 'undefined';
}

function declareFace(family: string, url: string, weight: number, style: 'normal' | 'italic', unicodeRange: string) {
  try {
    const face = new FontFace(family, `url("${url}") format("woff2")`, {
      weight: String(weight),
      style,
      unicodeRange,
      display: 'swap',
    });
    document.fonts.add(face);
  } catch (err) {
    console.warn(`[fonts] could not declare ${family} ${weight} ${style}`, err);
  }
}

let jpPromise: Promise<void> | null = null;

/** Register the Japanese unicode-range faces (once). */
export function loadJapaneseFaces(): Promise<void> {
  if (!canUseFontFace()) return Promise.resolve();
  if (!jpPromise) {
    jpPromise = import('./generated/facesJp')
      .then(({ JP_FACES, JP_RANGES }) => {
        for (const [family, weight, range, url] of JP_FACES) declareFace(family, url, weight, 'normal', JP_RANGES[range]);
      })
      .catch((err) => {
        console.warn('[fonts] Japanese font manifest failed to load', err);
        jpPromise = null;
      });
  }
  return jpPromise;
}

export function isJapaneseFamily(family: string): boolean {
  return JAPANESE.has(family.replace(/["']/g, '').trim().toLowerCase());
}

function toDef(f: (typeof BUNDLED_FAMILIES)[number]): FontDef {
  const meta = CATALOG[f.family];
  return {
    id: f.family,
    family: f.family,
    category: meta?.category ?? fallbackCategory(undefined),
    weights: f.weights,
    italic: f.italic || undefined,
    source: 'bundled',
    tags: meta?.tags ?? [],
    sample: meta?.sample,
  };
}

let registered = false;

/** Declare all latin faces + register FontDefs. Idempotent. */
export function registerBundledFonts() {
  if (registered) return;
  registered = true;
  if (canUseFontFace()) {
    for (const [family, weight, italic, url] of LATIN_FACES) {
      declareFace(family, url, weight, italic ? 'italic' : 'normal', LATIN_RANGE);
    }
    registerFontPreparer((family) => (isJapaneseFamily(family) ? loadJapaneseFaces() : undefined));
    // Declare the Japanese faces once the app is idle so DOM previews can use them; nothing is
    // downloaded until a glyph is actually rendered.
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (idle) idle(() => void loadJapaneseFaces(), { timeout: 6000 });
    else window.setTimeout(() => void loadJapaneseFaces(), 3000);
  }
  fonts.registerMany(BUNDLED_FAMILIES.map(toDef));
}

/** Total number of bundled families (for UI counts). */
export const BUNDLED_FAMILY_COUNT = BUNDLED_FAMILIES.length;
