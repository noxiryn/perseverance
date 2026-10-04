/**
 * Minimal font-file inspector: reads the family / style names, weight class and italic flag from
 * TrueType / OpenType / TTC / WOFF files (WOFF2 tables are brotli-compressed — for those we fall
 * back to the file name). Pure apart from the optional zlib inflater used for WOFF tables.
 */

export type FontFileFormat = 'ttf' | 'otf' | 'ttc' | 'woff' | 'woff2' | 'unknown';

export interface FontFileInfo {
  family: string;
  subfamily: string;
  fullName: string;
  weight: number;
  italic: boolean;
  format: FontFileFormat;
}

const tag = (dv: DataView, o: number) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

export function detectFormat(buf: ArrayBuffer): FontFileFormat {
  if (buf.byteLength < 12) return 'unknown';
  const dv = new DataView(buf);
  const sig = dv.getUint32(0);
  const t = tag(dv, 0);
  if (sig === 0x00010000 || t === 'true' || t === 'typ1') return 'ttf';
  if (t === 'OTTO') return 'otf';
  if (t === 'ttcf') return 'ttc';
  if (t === 'wOFF') return 'woff';
  if (t === 'wOF2') return 'woff2';
  return 'unknown';
}

/** Weight from a style name ("Bold Italic", "SemiBold", "Black"). */
export function weightFromStyleName(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]+/g, '');
  if (/(hairline|thin)/.test(s)) return 100;
  if (/(extralight|ultralight)/.test(s)) return 200;
  if (/(semibold|demibold|demi)/.test(s)) return 600;
  if (/(extrabold|ultrabold)/.test(s)) return 800;
  if (/(black|heavy|ultra)/.test(s)) return 900;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/bold/.test(s)) return 700;
  return 400;
}

const STYLE_WORDS =
  /^(regular|normal|book|roman|italic|oblique|thin|hairline|light|extralight|ultralight|medium|semi|extra|semibold|demibold|demi|bold|extrabold|ultrabold|black|heavy|ultra|condensed|variable|vf)$/i;

/** Guess family / weight / italic from a file name like "Roboto-BoldItalic.ttf". */
export function infoFromFileName(fileName: string): Omit<FontFileInfo, 'format'> {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(ttf|otf|ttc|woff2?|dfont)$/i, '');
  // Split CamelCase style suffixes: "BoldItalic" → "Bold Italic"
  const parts = base
    .split(/[-_\s]+/)
    .flatMap((p) => p.split(/(?<=[a-z])(?=[A-Z])/))
    .filter(Boolean);
  const famParts: string[] = [];
  const styleParts: string[] = [];
  for (const p of parts) {
    if (STYLE_WORDS.test(p) && famParts.length) styleParts.push(p);
    else if (!styleParts.length) famParts.push(p);
    else styleParts.push(p);
  }
  const subfamily = styleParts.join(' ') || 'Regular';
  // Re-join family words; keep original spacing of words like "Open Sans".
  const family = famParts.join(' ').trim() || base || 'Custom Font';
  return {
    family,
    subfamily,
    fullName: `${family} ${subfamily}`.trim(),
    weight: weightFromStyleName(subfamily),
    italic: /italic|oblique/i.test(subfamily),
  };
}

const WEIGHT_WORDS = /^(thin|hairline|extralight|ultralight|light|book|medium|semibold|demibold|semi|demi|bold|extrabold|ultrabold|extra|ultra|black|heavy)$/i;

/** "Playfair Display ExtraBold" → { family: "Playfair Display", weightName: "ExtraBold" }. */
export function splitWeightSuffix(name: string): { family: string; weightName: string } {
  const words = name.trim().split(/\s+/);
  const tail: string[] = [];
  while (words.length > 1 && WEIGHT_WORDS.test(words[words.length - 1])) tail.unshift(words.pop()!);
  return { family: words.join(' '), weightName: tail.join(' ') };
}

interface TableRef {
  offset: number;
  length: number;
  compLength: number;
}

function sfntTables(dv: DataView, base: number): Map<string, TableRef> {
  const n = dv.getUint16(base + 4);
  const out = new Map<string, TableRef>();
  for (let i = 0; i < n; i++) {
    const o = base + 12 + i * 16;
    if (o + 16 > dv.byteLength) break;
    const length = dv.getUint32(o + 12);
    out.set(tag(dv, o), { offset: dv.getUint32(o + 8), length, compLength: length });
  }
  return out;
}

function woffTables(dv: DataView): Map<string, TableRef> {
  const n = dv.getUint16(12);
  const out = new Map<string, TableRef>();
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 20;
    if (o + 20 > dv.byteLength) break;
    out.set(tag(dv, o), { offset: dv.getUint32(o + 4), compLength: dv.getUint32(o + 8), length: dv.getUint32(o + 12) });
  }
  return out;
}

function decodeUtf16BE(dv: DataView, o: number, len: number): string {
  let s = '';
  for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(dv.getUint16(o + i));
  return s;
}

function decodeLatin1(dv: DataView, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(o + i));
  return s;
}

/** Read name records from a 'name' table. Returns nameID → best string. */
export function readNameTable(dv: DataView): Map<number, string> {
  const count = dv.getUint16(2);
  const strOff = dv.getUint16(4);
  const best = new Map<number, { score: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > dv.byteLength) break;
    const platform = dv.getUint16(r);
    const encoding = dv.getUint16(r + 2);
    const language = dv.getUint16(r + 4);
    const nameId = dv.getUint16(r + 6);
    const len = dv.getUint16(r + 8);
    const off = strOff + dv.getUint16(r + 10);
    if (off + len > dv.byteLength) continue;
    let score = 0;
    let value = '';
    if (platform === 3 && (encoding === 1 || encoding === 10 || encoding === 0)) {
      score = language === 0x409 ? 40 : 30;
      value = decodeUtf16BE(dv, off, len);
    } else if (platform === 0) {
      score = 25;
      value = decodeUtf16BE(dv, off, len);
    } else if (platform === 1 && encoding === 0) {
      score = language === 0 ? 20 : 10;
      value = decodeLatin1(dv, off, len);
    } else continue;
    value = value.replace(/\0/g, '').trim();
    if (!value) continue;
    const prev = best.get(nameId);
    if (!prev || score > prev.score) best.set(nameId, { score, value });
  }
  return new Map([...best.entries()].map(([k, v]) => [k, v.value]));
}

export type Inflater = (data: Uint8Array) => Promise<Uint8Array>;

/** zlib inflate via the platform DecompressionStream ('deflate' = zlib-wrapped). */
export const platformInflate: Inflater = async (data) => {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> })
    .DecompressionStream;
  if (!DS) throw new Error('DecompressionStream unavailable');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

async function tableView(buf: ArrayBuffer, t: TableRef | undefined, woff: boolean, inflate: Inflater): Promise<DataView | null> {
  if (!t || t.offset + t.compLength > buf.byteLength) return null;
  if (woff && t.compLength < t.length) {
    try {
      const out = await inflate(new Uint8Array(buf, t.offset, t.compLength));
      return new DataView(out.buffer, out.byteOffset, out.byteLength);
    } catch {
      return null;
    }
  }
  return new DataView(buf, t.offset, t.length);
}

/**
 * Inspect a font file. Never throws: unknown/unsupported data falls back to the file name.
 */
export async function parseFontFile(buf: ArrayBuffer, fileName = 'Custom Font', inflate: Inflater = platformInflate): Promise<FontFileInfo> {
  const format = detectFormat(buf);
  const fallback = { ...infoFromFileName(fileName), format };
  if (format === 'unknown' || format === 'woff2') return fallback;
  try {
    const dv = new DataView(buf);
    let tables: Map<string, TableRef>;
    if (format === 'woff') tables = woffTables(dv);
    else if (format === 'ttc') tables = sfntTables(dv, dv.getUint32(12));
    else tables = sfntTables(dv, 0);
    const woff = format === 'woff';
    const nameDv = await tableView(buf, tables.get('name'), woff, inflate);
    const os2 = await tableView(buf, tables.get('OS/2'), woff, inflate);
    const head = await tableView(buf, tables.get('head'), woff, inflate);
    const names = nameDv ? readNameTable(nameDv) : new Map<number, string>();
    // Legacy name IDs 1/2 put non-RIBBI weights into the family ("Foo ExtraBold" + "Italic");
    // without typographic names (16/17) strip that suffix so weights group under one family.
    let family = names.get(16) || '';
    let subfamily = names.get(17) || '';
    if (!family) {
      const split = splitWeightSuffix(names.get(1) || fallback.family);
      family = split.family;
      subfamily = [split.weightName, names.get(2) && !/^regular$/i.test(names.get(2)!) ? names.get(2) : '']
        .filter(Boolean)
        .join(' ');
      if (!subfamily) subfamily = names.get(2) || fallback.subfamily;
    }
    if (!subfamily) subfamily = names.get(2) || fallback.subfamily;
    let weight = os2 && os2.byteLength >= 6 ? os2.getUint16(4) : 0;
    if (weight < 1 || weight > 1000) weight = weightFromStyleName(subfamily);
    // Some old fonts use 1..9 weight classes.
    if (weight < 10) weight *= 100;
    let italic = /italic|oblique/i.test(subfamily);
    if (os2 && os2.byteLength >= 64) italic = italic || (os2.getUint16(62) & 0x201) !== 0;
    if (head && head.byteLength >= 46) italic = italic || (head.getUint16(44) & 0x2) !== 0;
    return {
      family: family.trim(),
      subfamily: subfamily.trim(),
      fullName: (names.get(4) || `${family} ${subfamily}`).trim(),
      weight: Math.round(weight / 100) * 100 || 400,
      italic,
      format,
    };
  } catch {
    return fallback;
  }
}
