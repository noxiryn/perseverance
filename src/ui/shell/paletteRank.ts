/** Pure ranking/grouping for the command palette. */
import { fuzzyMatch, wordsMatch } from './fuzzy';

export interface RankableItem {
  key: string;
  kind: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  disabled?: boolean;
  /** Listed only when its kind is selected (it duplicates another entry in the "All" scope). */
  onlyInKind?: boolean;
}

export interface RankedItem<T> {
  item: T;
  score: number;
  /** Matched character indices in the title (for highlighting). */
  indices: number[];
}

export interface RankedGroup<T> {
  kind: string;
  items: RankedItem<T>[];
}

/** Label without a trailing ellipsis, lower-cased (for duplicate detection). */
export const bareLabel = (s: string): string =>
  s
    .replace(/(…|\.\.\.)\s*$/, '')
    .trim()
    .toLowerCase();

/** Menus whose commands open the same filter dialog as a palette "filter" item. */
const FILTER_MENU = /^(Filter(\/|$)|Image\/Adjustments(\/|$))/;

/**
 * Names (bareLabel) of filters that a Filter / Image ▸ Adjustments menu command already exposes;
 * their palette filter items would be exact duplicates in the "All" scope.
 */
export function filterNamesCoveredByCommands(list: readonly { label: string; menu?: string }[]): Set<string> {
  const out = new Set<string>();
  for (const c of list) if (c.menu && FILTER_MENU.test(c.menu)) out.add(bareLabel(c.label));
  return out;
}

/**
 * Rank items for a query and group them by kind. Groups are ordered by their best score
 * (ties broken by `kindOrder`). `caps` limits items per kind (ignored when `onlyKind` is set).
 */
export function rankItems<T extends RankableItem>(
  items: readonly T[],
  query: string,
  opts: {
    kindOrder: readonly string[];
    boost?: Readonly<Record<string, number>>;
    caps?: Readonly<Record<string, number>>;
    onlyKind?: string | null;
    limit?: number;
  },
): RankedGroup<T>[] {
  const q = query.trim();
  const byKind = new Map<string, RankedItem<T>[]>();
  for (const it of items) {
    if (opts.onlyKind ? it.kind !== opts.onlyKind : it.onlyInKind) continue;
    const t = fuzzyMatch(q, it.title);
    let score: number;
    let indices: number[] = [];
    if (t) {
      score = t.score + 20;
      indices = t.indices;
    } else {
      // Secondary text (menu path, category, keywords) must contain every term verbatim.
      const extra = `${it.title} ${it.subtitle ?? ''} ${it.keywords ?? ''}`;
      const k = wordsMatch(q, extra);
      if (k === null) continue;
      score = k * 0.5;
    }
    score += opts.boost?.[it.kind] ?? 0;
    // Disabled items cannot run right now: rank them below comparable enabled matches.
    if (it.disabled) score -= 40;
    const list = byKind.get(it.kind);
    const entry = { item: it, score, indices };
    if (list) list.push(entry);
    else byKind.set(it.kind, [entry]);
  }
  const groups: RankedGroup<T>[] = [];
  for (const [kind, list] of byKind) {
    list.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
    const cap = opts.onlyKind ? (opts.limit ?? 200) : (opts.caps?.[kind] ?? 8);
    groups.push({ kind, items: list.slice(0, cap) });
  }
  const orderIdx = (k: string) => {
    const i = opts.kindOrder.indexOf(k);
    return i < 0 ? 999 : i;
  };
  if (q) groups.sort((a, b) => b.items[0].score - a.items[0].score || orderIdx(a.kind) - orderIdx(b.kind));
  else groups.sort((a, b) => orderIdx(a.kind) - orderIdx(b.kind));
  return groups;
}
