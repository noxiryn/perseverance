/**
 * Deterministic word-like gibberish for fake newspaper columns (reads like English at a glance,
 * says nothing). Pure — unit tested.
 */
import type { Rand } from './util';

const SHORT = ['a', 'of', 'the', 'and', 'to', 'in', 'is', 'it', 'on', 'by', 'as', 'at', 'for', 'was', 'his', 'her', 'but', 'not', 'all', 'new', 'one', 'had', 'has', 'from', 'with', 'that', 'were', 'this', 'they', 'will', 'said'];
const ONSET = ['b', 'br', 'c', 'ch', 'cl', 'cr', 'd', 'dr', 'f', 'fl', 'fr', 'g', 'gr', 'h', 'j', 'l', 'm', 'n', 'p', 'pl', 'pr', 'r', 's', 'sh', 'sl', 'sp', 'st', 'str', 't', 'th', 'tr', 'v', 'w', 'wh', ''];
const VOWEL = ['a', 'e', 'i', 'o', 'u', 'ea', 'ou', 'ai', 'ie', 'o', 'e', 'a'];
const CODA = ['', '', 'n', 'r', 'l', 's', 't', 'nd', 'nt', 'st', 'rd', 'ck', 'm', 'ng', 'rt', 'ss'];
const SUFFIX = ['', '', '', 'ing', 'ed', 'er', 'ly', 'tion', 'ment', 'ous', 'al', 'es', 'ness', 'ity', 'ive', 'ance'];

export function fakeWord(r: Rand): string {
  if (r() < 0.32) return r.pick(SHORT);
  const syl = r() < 0.55 ? 1 : r() < 0.75 ? 2 : 3;
  let w = '';
  for (let i = 0; i < syl; i++) w += r.pick(ONSET) + r.pick(VOWEL) + (i === syl - 1 ? r.pick(CODA) : '');
  if (syl < 3 && r() < 0.4) w += r.pick(SUFFIX);
  return w.length > 13 ? w.slice(0, 13) : w;
}

export function capitalize(w: string): string {
  return w ? w[0].toUpperCase() + w.slice(1) : w;
}

/** A sentence-ish run of `n` words with capitalization and punctuation. */
export function fakeSentence(r: Rand, n: number): string[] {
  const out: string[] = [];
  let start = true;
  for (let i = 0; i < n; i++) {
    let w = fakeWord(r);
    if (start) {
      w = capitalize(w);
      start = false;
    } else if (r() < 0.06) w = capitalize(w);
    const end = i === n - 1 || r() < 0.08;
    if (end) {
      w += r() < 0.85 ? '.' : r() < 0.5 ? '?' : '!';
      start = true;
    } else if (r() < 0.07) w += ',';
    out.push(w);
  }
  return out;
}

/** Headline: 1–5 longer words. */
export function fakeHeadline(r: Rand, words = r.int(2, 4)): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    let w = fakeWord(r);
    let guard = 0;
    while (w.length < 3 && guard++ < 6) w = fakeWord(r);
    out.push(w);
  }
  return out.join(' ');
}
