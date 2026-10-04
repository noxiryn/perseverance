/**
 * Font list filtering / ranking shared by the FontSelect popover and the Fonts panel (pure).
 */
import type { FontCategory, FontDef } from '../registry';
import { CATEGORY_ORDER, POPULAR_FAMILIES } from './catalog';

/** Filter chips: special collections + categories. */
export type FontFilter = 'all' | 'favorites' | 'recent' | 'popular' | 'user' | FontCategory;

export const SPECIAL_FILTERS: { value: FontFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'popular', label: 'Popular' },
  { value: 'favorites', label: '★ Favorites' },
  { value: 'recent', label: 'Recent' },
];

export interface FontFilterContext {
  favorites: string[];
  recents: string[];
}

/** Lower-cased words of a string (letters/digits). */
function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9぀-ヿ一-鿿]+/).filter(Boolean);
}

/**
 * Relevance of a font for a query (0 = no match). Family-name matches beat tag matches, prefix
 * matches beat substring matches; every query word must match something.
 */
export function scoreFont(f: FontDef, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const fam = f.family.toLowerCase();
  if (fam === q) return 1000;
  let score = 0;
  if (fam.startsWith(q)) score += 600;
  else if (fam.includes(q)) score += 400;
  const famWords = words(f.family);
  const tags = (f.tags ?? []).map((t) => t.toLowerCase());
  const cat = f.category.toLowerCase();
  for (const w of words(q)) {
    let best = 0;
    if (famWords.some((fw) => fw.startsWith(w))) best = 120;
    else if (fam.includes(w)) best = 80;
    else if (tags.some((t) => t === w || t.startsWith(w) || t.split(' ').some((tw) => tw.startsWith(w)))) best = 60;
    else if (cat.includes(w)) best = 40;
    else if (f.source.startsWith(w)) best = 20;
    else if (tags.some((t) => t.includes(w))) best = 15;
    if (!best) return 0;
    score += best;
  }
  return score;
}

/** Does a font belong to a filter chip? */
export function matchesFilter(f: FontDef, filter: FontFilter, ctx: FontFilterContext): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'favorites':
      return ctx.favorites.includes(f.family);
    case 'recent':
      return ctx.recents.includes(f.family);
    case 'popular':
      return POPULAR_FAMILIES.includes(f.family);
    case 'user':
      return f.source === 'user';
    default:
      return f.category === filter;
  }
}

function categoryRank(c: FontCategory): number {
  const i = CATEGORY_ORDER.indexOf(c);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

/** Sort for a filter: popular/recent keep their curated/temporal order; others alphabetical. */
export function sortFonts(list: FontDef[], filter: FontFilter, ctx: FontFilterContext): FontDef[] {
  const out = [...list];
  if (filter === 'popular') {
    out.sort((a, b) => POPULAR_FAMILIES.indexOf(a.family) - POPULAR_FAMILIES.indexOf(b.family));
  } else if (filter === 'recent') {
    out.sort((a, b) => ctx.recents.indexOf(a.family) - ctx.recents.indexOf(b.family));
  } else if (filter === 'favorites') {
    out.sort((a, b) => ctx.favorites.indexOf(a.family) - ctx.favorites.indexOf(b.family));
  } else {
    out.sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.family.localeCompare(b.family));
  }
  return out;
}

/** Filter + rank. With a query, results are ordered by relevance. */
export function filterFonts(list: FontDef[], query: string, filter: FontFilter, ctx: FontFilterContext): FontDef[] {
  const inFilter = list.filter((f) => matchesFilter(f, filter, ctx));
  if (!query.trim()) return sortFonts(inFilter, filter, ctx);
  return inFilter
    .map((f) => ({ f, s: scoreFont(f, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.f.family.localeCompare(b.f.family))
    .map((x) => x.f);
}

/** Group a sorted list by category (in canonical order) — used for the "All" view. */
export function groupByCategory(list: FontDef[]): { category: FontCategory; fonts: FontDef[] }[] {
  const map = new Map<FontCategory, FontDef[]>();
  for (const f of list) {
    const arr = map.get(f.category);
    if (arr) arr.push(f);
    else map.set(f.category, [f]);
  }
  return [...map.entries()]
    .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]))
    .map(([category, fonts]) => ({ category, fonts }));
}

/** Human weights hint: "400", "400–900 · 6", "+ italic". */
export function weightsHint(f: FontDef): string {
  const w = [...(f.weights ?? [400])].sort((a, b) => a - b);
  const base = w.length <= 1 ? String(w[0] ?? 400) : `${w[0]}–${w[w.length - 1]}`;
  return `${base}${w.length > 2 ? ` · ${w.length}` : ''}${f.italic ? ' · i' : ''}`;
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

/** "Bold", "SemiBold"… (falls back to the number for unusual weights). */
export function weightName(w: number): string {
  return WEIGHT_NAMES[Math.round(w / 100) * 100] ?? String(w);
}

/**
 * Optical size multiplier for previews: thin signature scripts read much smaller than a
 * condensed headline at the same px size, so lists scale them up a little.
 */
export function previewScale(category: FontCategory): number {
  switch (category) {
    case 'Script':
      return 1.3;
    case 'Handwritten':
      return 1.12;
    case 'Blackletter':
      return 1.06;
    default:
      return 1;
  }
}

/** Default weight to preview/apply a family with (400 when available). */
export function previewWeight(f: FontDef | undefined): number {
  const w = f?.weights?.length ? f.weights : [400];
  return w.reduce((best, x) => (Math.abs(x - 400) < Math.abs(best - 400) ? x : best), w[0]);
}

/** Categories present in a list, in canonical order. */
export function presentCategories(list: FontDef[]): FontCategory[] {
  const set = new Set(list.map((f) => f.category));
  return [...set].sort((a, b) => categoryRank(a) - categoryRank(b));
}
