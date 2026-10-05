/**
 * Fonts used by text-drawing generators (newspaper clippings, film frame edge print, polaroid
 * captions, comic burst lettering). The faces themselves are declared (lazily) by the fonts
 * module from its bundled @fontsource files; here we only ask it to load the ones we draw with
 * via `ensureFont` before rendering. Every stack falls back to system faces, so a generator
 * called before the fonts are ready still produces a sensible image.
 */
import { ensureFont } from '../../fonts/loader';

export const FONT = {
  body: '"EB Garamond", "Libre Baskerville", "Times New Roman", serif',
  headSerif: '"Playfair Display", "Times New Roman", serif',
  headSans: '"Anton", "Oswald", Impact, "Arial Narrow", sans-serif',
  headCond: '"Oswald", "Roboto Condensed", "Arial Narrow", sans-serif',
  cond: '"Roboto Condensed", "Arial Narrow", sans-serif',
  hand: '"Caveat", "Segoe Print", cursive',
  comic: '"Bangers", "Luckiest Guy", Impact, sans-serif',
};

/** [family, weight, style] faces drawn by the generators. */
export const ASSET_FACES: readonly (readonly [string, number, 'normal' | 'italic'])[] = [
  ['EB Garamond', 400, 'normal'],
  ['EB Garamond', 400, 'italic'],
  ['EB Garamond', 700, 'normal'],
  ['Oswald', 600, 'normal'],
  ['Playfair Display', 900, 'normal'],
  ['Anton', 400, 'normal'],
  ['Roboto Condensed', 700, 'normal'],
  ['Caveat', 400, 'normal'],
  ['Bangers', 400, 'normal'],
];

let ready: Promise<void> | null = null;
let done = false;

/** True once the generator fonts finished loading (or failed and fell back). */
export function assetFontsReady(): boolean {
  return done;
}

/** Start (once) and await loading of the generator fonts. Never rejects. */
export function loadAssetFonts(): Promise<void> {
  if (ready) return ready;
  if (typeof document === 'undefined' || !document.fonts) {
    done = true;
    return (ready = Promise.resolve());
  }
  ready = Promise.all(ASSET_FACES.map(([family, weight, style]) => ensureFont(family, weight, style).catch(() => undefined))).then(() => {
    done = true;
  });
  return ready;
}
