/**
 * Pure text-index helpers for on-canvas editing (no DOM):
 *  - mapping between indices of the source content (what the textarea holds) and the displayed
 *    content (All Caps can change the length, e.g. "ß" → "SS"),
 *  - word / paragraph ranges for double/triple click selection.
 */

export interface CaseMap {
  /** Displayed (case-transformed) string. */
  display: string;
  /** srcToDisp[i] = display index of source index i (length = source.length + 1). */
  srcToDisp: Int32Array;
  /** dispToSrc[j] = source index of display index j (length = display.length + 1). */
  dispToSrc: Int32Array;
}

/** Index mapping for `uppercase` (identity when uppercase is off or lengths match). */
export function caseMap(source: string, uppercase: boolean): CaseMap {
  const n = source.length;
  if (!uppercase) {
    const id = new Int32Array(n + 1);
    for (let i = 0; i <= n; i++) id[i] = i;
    return { display: source, srcToDisp: id, dispToSrc: id };
  }
  const srcToDisp = new Int32Array(n + 1);
  const parts: string[] = [];
  const back: number[] = [];
  let d = 0;
  let i = 0;
  while (i < n) {
    const c = source.charCodeAt(i);
    const len = c >= 0xd800 && c <= 0xdbff && i + 1 < n ? 2 : 1;
    const ch = source.slice(i, i + len);
    const up = ch.toUpperCase();
    for (let k = 0; k < len; k++) srcToDisp[i + k] = d;
    // Every display unit produced by this source char maps back to its start.
    for (let k = 0; k < up.length; k++) back.push(i);
    parts.push(up);
    d += up.length;
    i += len;
  }
  srcToDisp[n] = d;
  back.push(n);
  return { display: parts.join(''), srcToDisp, dispToSrc: Int32Array.from(back) };
}

export function toDisplay(map: CaseMap, srcIndex: number): number {
  const i = Math.max(0, Math.min(map.srcToDisp.length - 1, Math.round(srcIndex)));
  return map.srcToDisp[i];
}

export function toSource(map: CaseMap, dispIndex: number): number {
  const j = Math.max(0, Math.min(map.dispToSrc.length - 1, Math.round(dispIndex)));
  return map.dispToSrc[j];
}

/* ---------------- word / paragraph ranges ---------------- */

type Segmenter = { segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };

let segmenter: Segmenter | null | undefined;
function wordSegmenter(): Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    const S = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter }).Segmenter;
    segmenter = S ? new S(undefined, { granularity: 'word' }) : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

const WORD_CHAR = /[\p{L}\p{N}_'’]/u;

/** [start, end) of the word (or run of whitespace / punctuation) at `index`. */
export function wordRangeAt(text: string, index: number): [number, number] {
  const n = text.length;
  if (!n) return [0, 0];
  let i = Math.max(0, Math.min(index, n));
  // Clicking right after the last char of a word selects that word.
  if (i === n || (i > 0 && text[i] === '\n')) i = Math.max(0, i - 1);
  const seg = wordSegmenter();
  if (seg) {
    for (const s of seg.segment(text)) {
      if (i >= s.index && i < s.index + s.segment.length) {
        if (s.segment === '\n' || s.segment === '\r\n') return [s.index, s.index];
        return [s.index, s.index + s.segment.length];
      }
    }
  }
  const kind = (c: string) => (c === '\n' ? 0 : /\s/.test(c) ? 1 : WORD_CHAR.test(c) ? 2 : 3);
  const k = kind(text[i]);
  if (k === 0) return [i, i];
  let a = i;
  let b = i + 1;
  while (a > 0 && kind(text[a - 1]) === k) a--;
  while (b < n && kind(text[b]) === k) b++;
  return [a, b];
}

/** [start, end) of the hard line (paragraph) containing `index` (newline excluded). */
export function paragraphRangeAt(text: string, index: number): [number, number] {
  const i = Math.max(0, Math.min(index, text.length));
  const a = text.lastIndexOf('\n', i - 1) + 1;
  let b = text.indexOf('\n', i);
  if (b < 0) b = text.length;
  return [a, b];
}

/** Normalize line endings and strip characters that cannot be typeset. */
export function sanitizeTypedText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
