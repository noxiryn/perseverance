import { describe, expect, it } from 'vitest';
import type { FontDef } from '../registry';
import { detectFormat, infoFromFileName, parseFontFile, readNameTable, weightFromStyleName } from './sfnt';
import { filterFonts, groupByCategory, previewScale, previewWeight, scoreFont, weightName, weightsHint } from './search';
import { groupLocalFonts } from './system';
import { anchoredScrollTop, findIndex } from './VirtualList';
import { CATALOG, guessCategory, POPULAR_FAMILIES } from './catalog';
import { BUNDLED_FAMILIES, LATIN_FACES } from './generated/faces';

/* ---------------- a tiny synthetic TrueType file ---------------- */

function utf16be(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out.push(c >> 8, c & 255);
  }
  return out;
}

function buildTtf(
  family: string,
  sub: string,
  weight: number,
  italic: boolean,
  os2Class?: { panose?: number[]; familyClass?: number },
): ArrayBuffer {
  // name table: format 0, records for nameID 1, 2, 4 (platform 3, enc 1, lang 0x409)
  const names: [number, string][] = [
    [1, family],
    [2, sub],
    [4, `${family} ${sub}`],
  ];
  const strings: number[] = [];
  const recs: number[][] = [];
  for (const [id, s] of names) {
    const bytes = utf16be(s);
    recs.push([3, 1, 0x409, id, bytes.length, strings.length]);
    strings.push(...bytes);
  }
  const nameHeader = 6 + recs.length * 12;
  const name = new Uint8Array(nameHeader + strings.length);
  const ndv = new DataView(name.buffer);
  ndv.setUint16(0, 0);
  ndv.setUint16(2, recs.length);
  ndv.setUint16(4, nameHeader);
  recs.forEach((r, i) => r.forEach((v, j) => ndv.setUint16(6 + i * 12 + j * 2, v)));
  name.set(strings, nameHeader);

  const os2 = new Uint8Array(78);
  const odv = new DataView(os2.buffer);
  odv.setUint16(4, weight);
  odv.setUint16(62, italic ? 1 : 0);
  if (os2Class?.familyClass) odv.setUint8(30, os2Class.familyClass);
  os2Class?.panose?.forEach((v, i) => odv.setUint8(32 + i, v));

  const tables: [string, Uint8Array][] = [
    ['OS/2', os2],
    ['name', name],
  ];
  const headerLen = 12 + tables.length * 16;
  let offset = headerLen;
  const total = headerLen + tables.reduce((s, [, d]) => s + d.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, tables.length);
  tables.forEach(([tag, data], i) => {
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[o + k] = tag.charCodeAt(k);
    dv.setUint32(o + 8, offset);
    dv.setUint32(o + 12, data.length);
    out.set(data, offset);
    offset += data.length;
  });
  return out.buffer;
}

describe('sfnt parsing', () => {
  it('detects formats', () => {
    const mk = (t: string) => {
      const b = new Uint8Array(16);
      for (let i = 0; i < 4; i++) b[i] = t.charCodeAt(i);
      return b.buffer;
    };
    expect(detectFormat(mk('OTTO'))).toBe('otf');
    expect(detectFormat(mk('wOFF'))).toBe('woff');
    expect(detectFormat(mk('wOF2'))).toBe('woff2');
    expect(detectFormat(mk('ttcf'))).toBe('ttc');
    expect(detectFormat(buildTtf('A', 'Regular', 400, false))).toBe('ttf');
    expect(detectFormat(new ArrayBuffer(4))).toBe('unknown');
  });

  it('reads family, style, weight and italic from a TrueType file', async () => {
    const info = await parseFontFile(buildTtf('Gothic Grand', 'Bold Italic', 700, true), 'whatever.ttf');
    expect(info).toMatchObject({ family: 'Gothic Grand', subfamily: 'Bold Italic', weight: 700, italic: true, format: 'ttf' });
  });

  it('reads name records', () => {
    const buf = buildTtf('Fam', 'Light', 300, false);
    const dv = new DataView(buf);
    // second table is 'name'
    const off = dv.getUint32(12 + 16 + 8);
    const len = dv.getUint32(12 + 16 + 12);
    const names = readNameTable(new DataView(buf, off, len));
    expect(names.get(1)).toBe('Fam');
    expect(names.get(2)).toBe('Light');
  });

  it('falls back to the file name for woff2 / garbage', async () => {
    const b = new Uint8Array(32);
    'wOF2'.split('').forEach((c, i) => (b[i] = c.charCodeAt(0)));
    const info = await parseFontFile(b.buffer, 'OpenSans-SemiBoldItalic.woff2');
    expect(info).toMatchObject({ family: 'Open Sans', weight: 600, italic: true, format: 'woff2' });
    const junk = await parseFontFile(new Uint8Array(64).buffer, 'My_Cool_Font.ttf');
    expect(junk.family).toBe('My Cool Font');
  });

  it('strips legacy weight suffixes from family names', async () => {
    const info = await parseFontFile(buildTtf('Playfair Display ExtraBold', 'Italic', 800, true), 'x.ttf');
    expect(info).toMatchObject({ family: 'Playfair Display', subfamily: 'ExtraBold Italic', weight: 800, italic: true });
    const reg = await parseFontFile(buildTtf('Roboto Condensed', 'Regular', 400, false), 'x.ttf');
    expect(reg).toMatchObject({ family: 'Roboto Condensed', subfamily: 'Regular', weight: 400 });
  });

  it('reads the design class from PANOSE / sFamilyClass', async () => {
    const sans = await parseFontFile(buildTtf('Plain', 'Regular', 400, false, { panose: [2, 11, 5, 3] }), 'x.ttf');
    expect(sans.classHint).toBe('sans');
    const mono = await parseFontFile(buildTtf('Term', 'Regular', 400, false, { panose: [2, 11, 5, 9] }), 'x.ttf');
    expect(mono.classHint).toBe('mono');
    const serif = await parseFontFile(buildTtf('Book', 'Regular', 400, false, { panose: [2, 2, 5, 3] }), 'x.ttf');
    expect(serif.classHint).toBe('serif');
    const script = await parseFontFile(buildTtf('Signy', 'Regular', 400, false, { panose: [3, 0, 0, 0] }), 'x.ttf');
    expect(script.classHint).toBe('script');
    // No PANOSE → sFamilyClass (10 = scripts, 5 = slab serifs).
    expect((await parseFontFile(buildTtf('A', 'Regular', 400, false, { familyClass: 10 }), 'x.ttf')).classHint).toBe('script');
    expect((await parseFontFile(buildTtf('A', 'Regular', 400, false, { familyClass: 5 }), 'x.ttf')).classHint).toBe('slab');
    expect((await parseFontFile(buildTtf('A', 'Regular', 400, false), 'x.ttf')).classHint).toBeUndefined();
  });

  it('weights from style names', () => {
    expect(weightFromStyleName('Thin')).toBe(100);
    expect(weightFromStyleName('ExtraLight Italic')).toBe(200);
    expect(weightFromStyleName('Light')).toBe(300);
    expect(weightFromStyleName('Regular')).toBe(400);
    expect(weightFromStyleName('Medium')).toBe(500);
    expect(weightFromStyleName('Semi Bold')).toBe(600);
    expect(weightFromStyleName('Bold')).toBe(700);
    expect(weightFromStyleName('ExtraBold')).toBe(800);
    expect(weightFromStyleName('Black')).toBe(900);
    expect(infoFromFileName('Roboto-BoldItalic.ttf')).toMatchObject({ family: 'Roboto', weight: 700, italic: true });
  });
});

/* ---------------- search ---------------- */

const def = (family: string, category: FontDef['category'], tags: string[] = [], weights = [400]): FontDef => ({
  id: family,
  family,
  category,
  weights,
  source: 'bundled',
  tags,
});

const LIST: FontDef[] = [
  def('UnifrakturMaguntia', 'Blackletter', ['gothic title', 'blackletter']),
  def('Anton', 'Condensed', ['newspaper headline']),
  def('Mrs Saint Delafield', 'Script', ['signature', 'elegant script']),
  def('Cinzel', 'Serif', ['roman numeral'], [400, 500, 600, 700, 800, 900]),
  def('Bangers', 'Cartoon', ['comic']),
];

describe('font search', () => {
  it('ranks family name matches above tag matches', () => {
    expect(scoreFont(LIST[1], 'anton')).toBeGreaterThan(scoreFont(LIST[0], 'gothic'));
    expect(scoreFont(LIST[1], 'xyz')).toBe(0);
  });
  it('finds fonts by vibe tags and category', () => {
    expect(filterFonts(LIST, 'signature', 'all', { favorites: [], recents: [] }).map((f) => f.family)).toEqual(['Mrs Saint Delafield']);
    expect(filterFonts(LIST, 'gothic', 'all', { favorites: [], recents: [] })[0].family).toBe('UnifrakturMaguntia');
    expect(filterFonts(LIST, 'cartoon', 'all', { favorites: [], recents: [] })[0].family).toBe('Bangers');
  });
  it('requires every word to match', () => {
    expect(filterFonts(LIST, 'roman numeral', 'all', { favorites: [], recents: [] }).map((f) => f.family)).toEqual(['Cinzel']);
    expect(filterFonts(LIST, 'roman comic', 'all', { favorites: [], recents: [] })).toEqual([]);
  });
  it('filters favorites / recents keeping their order', () => {
    const ctx = { favorites: ['Cinzel', 'Anton'], recents: ['Bangers', 'Cinzel'] };
    expect(filterFonts(LIST, '', 'favorites', ctx).map((f) => f.family)).toEqual(['Cinzel', 'Anton']);
    expect(filterFonts(LIST, '', 'recent', ctx).map((f) => f.family)).toEqual(['Bangers', 'Cinzel']);
    expect(filterFonts(LIST, '', 'Script', ctx).map((f) => f.family)).toEqual(['Mrs Saint Delafield']);
  });
  it('groups by canonical category order', () => {
    const g = groupByCategory(filterFonts(LIST, '', 'all', { favorites: [], recents: [] }));
    expect(g.map((x) => x.category)).toEqual(['Blackletter', 'Condensed', 'Serif', 'Script', 'Cartoon']);
  });
  it('weight helpers', () => {
    expect(weightsHint(LIST[3])).toBe('400–900 · 6');
    expect(previewWeight(def('X', 'Japanese', [], [700]))).toBe(700);
    expect(previewWeight(LIST[3])).toBe(400);
  });
});

describe('user font categories', () => {
  it('uses distinctive names first, then the declared class, then generic words', () => {
    expect(guessCategory('Old London Fraktur')).toBe('Blackletter');
    expect(guessCategory('Cloister Gothic')).toBe('Blackletter');
    expect(guessCategory('Century Gothic')).toBe('Sans');
    expect(guessCategory('League Gothic')).toBe('Condensed');
    expect(guessCategory('Yu Gothic')).toBe('Japanese');
    expect(guessCategory('Noto Sans JP')).toBe('Japanese');
    expect(guessCategory('Bloody Halloween')).toBe('Grunge & Horror');
    expect(guessCategory('Fira Code')).toBe('Typewriter & Mono');
    expect(guessCategory('Arsenal SC', 'sans')).toBe('Sans');
    expect(guessCategory('Lovely Lady', 'script')).toBe('Script');
    expect(guessCategory('Gentium Book', 'serif')).toBe('Serif');
    expect(guessCategory('Roboto Slab', 'slab')).toBe('Serif');
    expect(guessCategory('Mystery Face')).toBe('Display');
    expect(guessCategory('Source Serif')).toBe('Serif');
  });
});

describe('weight helpers', () => {
  it('names weights and scales thin scripts up in previews', () => {
    expect(weightName(700)).toBe('Bold');
    expect(weightName(600)).toBe('SemiBold');
    expect(weightName(450)).toBe('Medium');
    expect(previewScale('Script')).toBeGreaterThan(previewScale('Condensed'));
    expect(previewScale('Condensed')).toBe(1);
  });
});

describe('system font grouping', () => {
  it('groups faces per family, derives weights and skips hidden/bundled families', () => {
    const defs = groupLocalFonts(
      [
        { family: 'Arial', fullName: 'Arial', postscriptName: 'ArialMT', style: 'Regular' },
        { family: 'Arial', fullName: 'Arial Bold', postscriptName: 'Arial-BoldMT', style: 'Bold' },
        { family: 'Arial', fullName: 'Arial Italic', postscriptName: 'Arial-ItalicMT', style: 'Italic' },
        { family: '.SF NS', fullName: '.SF NS', postscriptName: 'x', style: 'Regular' },
        { family: 'Anton', fullName: 'Anton', postscriptName: 'Anton', style: 'Regular' },
        { family: 'Consolas', fullName: 'Consolas', postscriptName: 'Consolas', style: 'Regular' },
      ],
      (f) => f === 'Anton',
    );
    expect(defs.map((d) => d.family)).toEqual(['Arial', 'Consolas']);
    expect(defs[0]).toMatchObject({ weights: [400, 700], italic: true, source: 'system', category: 'System' });
    expect(defs[1].tags).toContain('mono');
  });
});

describe('virtual list index', () => {
  it('binary-searches offsets', () => {
    const offsets = [0, 30, 60, 84, 114];
    expect(findIndex(offsets, 0)).toBe(0);
    expect(findIndex(offsets, 29)).toBe(0);
    expect(findIndex(offsets, 30)).toBe(1);
    expect(findIndex(offsets, 100)).toBe(3);
    expect(findIndex(offsets, 999)).toBe(3);
  });
});

describe('virtual list scroll anchoring', () => {
  const offsetsOf = (heights: number[]) => {
    const o = [0];
    for (const h of heights) o.push(o[o.length - 1] + h);
    return o;
  };
  const rows = (keys: string[], h = 30) => ({ keys, offsets: offsetsOf(keys.map((k) => (k.startsWith('h:') ? 24 : h))) });

  it('keeps the first visible row in place when rows are inserted above', () => {
    const before = rows(['h:Display', 'a:Anton', 'a:Bangers', 'h:Serif', 'a:Cinzel', 'a:IM Fell English', 'a:Playfair']);
    // Starring "IM Fell English" inserts a Favorites section at the top.
    const after = rows(['h:fav', 'f:IM Fell English', ...before.keys]);
    const st = before.offsets[4]; // Cinzel at the top of the viewport
    const next = anchoredScrollTop((i) => before.keys[i], before.offsets, after.keys, after.offsets, st, 90);
    expect(next).toBe(st + 24 + 30);
    expect(after.offsets[after.keys.indexOf('a:Cinzel')]).toBe(next);
  });

  it('keeps a partially scrolled row at the same screen offset', () => {
    const before = rows(['a', 'b', 'c', 'd', 'e']);
    const after = rows(['x', 'a', 'b', 'c', 'd', 'e']);
    const next = anchoredScrollTop((i) => before.keys[i], before.offsets, after.keys, after.offsets, 45, 60);
    expect(next).toBe(75);
  });

  it('skips rows that disappeared and anchors on the next visible survivor', () => {
    const before = rows(['f:Anton', 'a:Bangers', 'a:Cinzel', 'a:Oswald']);
    const after = rows(['a:Bangers', 'a:Cinzel', 'a:Oswald']); // un-starred: favorites row removed
    const next = anchoredScrollTop((i) => before.keys[i], before.offsets, after.keys, after.offsets, 10, 60);
    expect(next).toBe(0); // Bangers was at 30 (20px below the top) → stays 20px below
  });

  it('stays at the top and gives up when nothing survives', () => {
    const before = rows(['a', 'b', 'c']);
    expect(anchoredScrollTop((i) => before.keys[i], before.offsets, ['z', 'a'], offsetsOf([30, 30]), 0, 60)).toBeNull();
    expect(anchoredScrollTop((i) => before.keys[i], before.offsets, ['x', 'y'], offsetsOf([30, 30]), 20, 60)).toBeNull();
    expect(anchoredScrollTop((i) => before.keys[i], before.offsets, [], [0], 20, 60)).toBeNull();
  });

  it('follows row height changes (preview size slider)', () => {
    const keys = ['a', 'b', 'c', 'd'];
    const small = offsetsOf([40, 40, 40, 40]);
    const big = offsetsOf([80, 80, 80, 80]);
    expect(anchoredScrollTop((i) => keys[i], small, keys, big, 80, 60)).toBe(160);
  });
});

describe('bundled catalog', () => {
  it('every bundled family has catalog metadata and faces', () => {
    expect(BUNDLED_FAMILIES.length).toBeGreaterThanOrEqual(80);
    const withFaces = new Set(LATIN_FACES.map((f) => f[0]));
    for (const f of BUNDLED_FAMILIES) {
      expect(CATALOG[f.family], f.family).toBeDefined();
      if (!f.japanese) expect(withFaces.has(f.family), f.family).toBe(true);
      else expect(CATALOG[f.family].sample, f.family).toBeTruthy();
    }
  });
  it('popular collection only references bundled families', () => {
    const fams = new Set(BUNDLED_FAMILIES.map((f) => f.family));
    for (const p of POPULAR_FAMILIES) expect(fams.has(p), p).toBe(true);
  });
});
