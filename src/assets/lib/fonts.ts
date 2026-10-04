/**
 * Fonts used by text-drawing generators (newspaper clippings, film frame edge print, polaroid
 * captions). Bundled via @fontsource so they work offline; loading starts at module init so the
 * faces are ready by the time a user places an asset. Every stack falls back to system faces.
 */
import '@fontsource/eb-garamond/latin-400.css';
import '@fontsource/eb-garamond/latin-700.css';
import '@fontsource/oswald/latin-600.css';
import '@fontsource/playfair-display/latin-900.css';
import '@fontsource/anton/latin-400.css';
import '@fontsource/roboto-condensed/latin-700.css';
import '@fontsource/caveat/latin-400.css';
import '@fontsource/bangers/latin-400.css';

export const FONT = {
  body: '"EB Garamond", "Libre Baskerville", "Times New Roman", serif',
  headSerif: '"Playfair Display", "Times New Roman", serif',
  headSans: '"Anton", "Oswald", Impact, "Arial Narrow", sans-serif',
  headCond: '"Oswald", "Roboto Condensed", "Arial Narrow", sans-serif',
  cond: '"Roboto Condensed", "Arial Narrow", sans-serif',
  hand: '"Caveat", "Segoe Print", cursive',
  comic: '"Bangers", "Luckiest Guy", Impact, sans-serif',
};

const FACES: [string, number][] = [
  ['EB Garamond', 400],
  ['EB Garamond', 700],
  ['Oswald', 600],
  ['Playfair Display', 900],
  ['Anton', 400],
  ['Roboto Condensed', 700],
  ['Caveat', 400],
  ['Bangers', 400],
];

let ready: Promise<void> | null = null;

/** Start (once) and await loading of the generator fonts. Never rejects. */
export function loadAssetFonts(): Promise<void> {
  if (ready) return ready;
  if (typeof document === 'undefined' || !document.fonts) return (ready = Promise.resolve());
  ready = Promise.all(FACES.map(([f, w]) => document.fonts.load(`${w} 24px "${f}"`).catch(() => undefined))).then(() => undefined);
  return ready;
}
