/** Placeholder text for Type ▸ Paste Lorem Ipsum. */

export const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ' +
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ' +
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';

/** About `words` words of lorem ipsum (cycled), capitalized, ending with a period. */
export function loremWords(words: number): string {
  const src = LOREM.replace(/[.,]/g, '').toLowerCase().split(/\s+/);
  const n = Math.max(1, Math.round(words));
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(src[i % src.length]);
  const s = out.join(' ');
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

/** Placeholder sized for a paragraph box: roughly fills `area` px² at `fontSize`. */
export function loremForBox(boxWidth: number, fontSize: number, lines = 6): string {
  const charsPerLine = Math.max(8, boxWidth / Math.max(1, fontSize * 0.5));
  const words = Math.max(6, Math.round((charsPerLine * lines) / 6));
  return words >= 69 ? LOREM : loremWords(words);
}
