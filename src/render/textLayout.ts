/**
 * Pure text layout (no canvas): line breaking, alignment and caret math.
 *
 * The compositor (text.ts) injects a `measure` function backed by a canvas context. Keeping the
 * algorithm pure makes measureText() and rendering share exactly the same layout, and lets us
 * unit-test wrapping with a fake measure function.
 */

/** Width of a string in layout px (glyph advances + letter spacing between glyphs, × scaleX). */
export type Measure = (s: string) => number;

export interface LayoutLine {
  /** Text drawn for this line (trailing whitespace of soft-wrapped lines trimmed). */
  text: string;
  /** Range of this line in the (case-transformed) content string: [start, end). */
  start: number;
  end: number;
  /** Left edge of the line inside the layout box. */
  x: number;
  /** Top of the line box. */
  y: number;
  /** Visual width of `text`. */
  width: number;
  /** Baseline y inside the layout box. */
  baseline: number;
  /** True when the line ends with a hard break ("\n") or is the last line of a paragraph. */
  hard: boolean;
}

export interface LayoutInput {
  content: string;
  /** Paragraph wrap width (layout px) or null for point text. */
  boxWidth: number | null;
  align: 'left' | 'center' | 'right';
  /** Distance between baselines (layout px). */
  lineHeight: number;
  /** Font ascent/descent (layout px) used to center glyphs vertically in their line box. */
  ascent: number;
  descent: number;
}

export interface LayoutResult {
  lines: LayoutLine[];
  /** Layout box size (ceil'ed, ≥ 1). */
  width: number;
  height: number;
  /** Baseline offset of the first line from the top of the box. */
  ascent: number;
}

interface RawLine {
  start: number;
  end: number;
  text: string;
  hard: boolean;
}

const WS = /\s/;

function trimEndIndex(s: string, start: number, end: number): number {
  let e = end;
  while (e > start && WS.test(s[e - 1])) e--;
  return e;
}

/** Split a string into code points (keeps surrogate pairs together) with their string offsets. */
function codePointOffsets(s: string, start: number, end: number): number[] {
  const out: number[] = [];
  let i = start;
  while (i < end) {
    out.push(i);
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < end ? 2 : 1;
  }
  out.push(end);
  return out;
}

/**
 * Greedy word wrap of one paragraph (no "\n" inside) of `src` between [from, to).
 * Whitespace that triggers a break stays at the end of the previous line (so line ranges are
 * contiguous); words wider than maxWidth are broken between characters.
 */
export function wrapParagraph(src: string, from: number, to: number, maxWidth: number | null, measure: Measure): RawLine[] {
  if (maxWidth === null || from === to) return [{ start: from, end: to, text: src.slice(from, to), hard: true }];
  const lines: RawLine[] = [];
  const tokenRe = /\S+|\s+/g;
  const para = src.slice(from, to);
  let lineStart = from;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(para))) {
    if (WS.test(m[0][0])) continue; // whitespace never forces a break by itself
    const tStart = from + m.index;
    const tEnd = tStart + m[0].length;
    if (measure(src.slice(lineStart, tEnd)) <= maxWidth) continue;
    // Doesn't fit: break before the word if the line already has content.
    if (trimEndIndex(src, lineStart, tStart) > lineStart) {
      lines.push({ start: lineStart, end: tStart, text: src.slice(lineStart, trimEndIndex(src, lineStart, tStart)), hard: false });
      lineStart = tStart;
    }
    // A word wider than the box is broken between characters (binary search for the longest fitting prefix).
    while (measure(src.slice(lineStart, tEnd)) > maxWidth) {
      const offs = codePointOffsets(src, lineStart, tEnd);
      let lo = 1;
      let hi = offs.length - 2; // at least one code point per line, never the whole remainder
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measure(src.slice(lineStart, offs[mid])) <= maxWidth) lo = mid;
        else hi = mid - 1;
      }
      const cut = offs[Math.max(1, lo)];
      if (cut >= tEnd) break;
      lines.push({ start: lineStart, end: cut, text: src.slice(lineStart, cut), hard: false });
      lineStart = cut;
    }
  }
  lines.push({ start: lineStart, end: to, text: src.slice(lineStart, trimEndIndex(src, lineStart, to)), hard: true });
  return lines;
}

/** Full layout: hard breaks, wrapping, alignment and vertical metrics. */
export function layoutText(input: LayoutInput, measure: Measure): LayoutResult {
  const { content, boxWidth, align, lineHeight, ascent, descent } = input;
  const raw: RawLine[] = [];
  let pStart = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === '\n') {
      const end = i > pStart && content[i - 1] === '\r' ? i - 1 : i;
      raw.push(...wrapParagraph(content, pStart, end, boxWidth !== null ? Math.max(1, boxWidth) : null, measure));
      pStart = i + 1;
    }
  }
  if (!raw.length) raw.push({ start: 0, end: 0, text: '', hard: true });
  // Point text keeps trailing spaces visible in the measured width (so the caret can sit after them).
  const widths = raw.map((l) => (boxWidth === null ? measure(content.slice(l.start, l.end)) : measure(l.text)));
  const maxW = widths.reduce((a, b) => Math.max(a, b), 0);
  const boxW = boxWidth !== null ? Math.max(1, boxWidth) : maxW;
  const inLine = (lineHeight - (ascent + descent)) / 2 + ascent;
  const lines: LayoutLine[] = raw.map((l, i) => {
    const w = widths[i];
    const x = align === 'center' ? (boxW - w) / 2 : align === 'right' ? boxW - w : 0;
    const y = i * lineHeight;
    return { text: boxWidth === null ? content.slice(l.start, l.end) : l.text, start: l.start, end: l.end, x, y, width: w, baseline: y + inLine, hard: l.hard };
  });
  return {
    lines,
    width: Math.max(1, Math.ceil(boxW - 1e-6)),
    height: Math.max(1, Math.ceil(lines.length * lineHeight - 1e-6)),
    ascent: inLine,
  };
}

/** Index of the line that holds caret position `index` (a position at a soft-wrap boundary belongs to the next line). */
export function lineIndexForCaret(lines: { start: number; end: number; hard: boolean }[], index: number): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (index < l.start) return Math.max(0, i - 1);
    if (index < l.end) return i;
    if (index === l.end && (l.hard || i === lines.length - 1)) return i;
  }
  return lines.length - 1;
}
