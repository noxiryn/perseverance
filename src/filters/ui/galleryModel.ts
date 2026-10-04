/**
 * Filter Gallery / Filter menu model (pure): which filters are browsable, category order,
 * search matching.
 */
import type { FilterCategory, FilterDef } from '../../registry';

export const CATEGORY_ORDER: FilterCategory[] = [
  'Stylize',
  'Comic & Print',
  'Artistic',
  'Blur',
  'Sharpen',
  'Distort',
  'Noise & Grain',
  'Light',
  'Retro & Glitch',
  'Roblox',
  'Color',
  'Other',
  'Adjustments',
];

export function categoryRank(c: string): number {
  const i = CATEGORY_ORDER.indexOf(c as FilterCategory);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

/**
 * Filters shown in the Filter menu and gallery: everything except adjustment-only color
 * corrections (those live in Image ▸ Adjustments). Vignette is an adjustment too but a creative
 * Light filter, so it is kept.
 */
export function isBrowsableFilter(f: FilterDef): boolean {
  if (!f.adjustment) return true;
  return f.category !== 'Adjustments' && f.category !== 'Color';
}

export function sortFilters(list: FilterDef[]): FilterDef[] {
  return [...list].sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.name.localeCompare(b.name));
}

/** Case-insensitive match of every query word against name, id, category, keywords, description. */
export function matchesQuery(f: FilterDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [f.name, f.id, f.category, f.description ?? '', ...(f.keywords ?? [])].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** Categories present in a list, in display order, with counts. */
export function categoriesOf(list: FilterDef[]): { category: string; count: number }[] {
  const m = new Map<string, number>();
  for (const f of list) m.set(f.category, (m.get(f.category) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0])).map(([category, count]) => ({ category, count }));
}
