/**
 * Small fuzzy matcher for the command palette. Scores subsequence matches, rewarding
 * consecutive characters, word starts and prefix matches. Returns matched indices for
 * highlighting.
 */

export interface FuzzyResult {
  score: number;
  /** Indices into `text` of matched characters. */
  indices: number[];
}

const isWordStart = (text: string, i: number) => {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (/[\s\-_/.›:(]/.test(prev)) return true;
  // camelCase boundary
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
};

/**
 * Match `query` against `text`. Whitespace in the query separates terms that may match in any
 * order (each term must match as a subsequence). Returns null when it does not match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const terms = q.split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let total = 0;
  const all: number[] = [];
  for (const term of terms) {
    const r = matchTerm(term, text, lower);
    if (!r) return null;
    total += r.score;
    all.push(...r.indices);
  }
  // Exact / prefix bonuses on the whole query.
  if (lower === q) total += 60;
  else if (lower.startsWith(q)) total += 30;
  // Prefer shorter texts slightly.
  total -= Math.min(20, text.length * 0.15);
  return { score: total, indices: [...new Set(all)].sort((a, b) => a - b) };
}

function matchTerm(term: string, text: string, lower: string): FuzzyResult | null {
  // Fast path: contiguous substring (prefer one at a word start).
  let best: FuzzyResult | null = null;
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(term, from);
    if (idx < 0) break;
    const ws = isWordStart(text, idx);
    const score = term.length * 10 + (ws ? 25 : 0) + (idx === 0 ? 15 : 0);
    if (!best || score > best.score) best = { score, indices: Array.from({ length: term.length }, (_, k) => idx + k) };
    if (ws) break;
    from = idx + 1;
  }
  if (best) return best;

  // Subsequence match, greedy with preference for word starts.
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let last = -2;
  for (let qi = 0; qi < term.length; qi++) {
    const ch = term[qi];
    // Look ahead for a word-start occurrence first.
    let found = -1;
    for (let k = ti; k < lower.length; k++) {
      if (lower[k] === ch && isWordStart(text, k)) {
        found = k;
        break;
      }
    }
    const next = lower.indexOf(ch, ti);
    if (next < 0) return null;
    // Prefer consecutive char if available, else word start, else next occurrence.
    let pick = next;
    if (next !== last + 1 && found >= 0) pick = found;
    if (pick === last + 1) score += 8;
    else if (isWordStart(text, pick)) score += 6;
    else score += 1;
    indices.push(pick);
    last = pick;
    ti = pick + 1;
  }
  return { score, indices };
}
