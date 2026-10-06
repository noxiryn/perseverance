/**
 * Fonts that exist on this machine only for the current session — embedded in a friend's project, or
 * added while font storage was unavailable — are carried by autosave entries and My Templates, so a
 * crash or a restart doesn't silently swap them for a fallback and the next Save doesn't drop them from
 * the project (app-logic-diff-4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, insertLayerDraft, makeTextLayer } from '../core/document';
import { registerEmbeddedFonts, userFontFiles } from '../fonts/userFonts';
import { unpackContainer } from './container';
import { encodeProject } from './project';

const g = globalThis as unknown as { FontFace?: unknown };
let restore: () => void = () => {};

beforeAll(() => {
  // jsdom has no font loading: a FontFace that always loads and a document.fonts that accepts it.
  const hadFontFace = 'FontFace' in g;
  const prevFontFace = g.FontFace;
  g.FontFace = class {
    constructor(
      public family: string,
      public source: ArrayBuffer,
    ) {}
    load() {
      return Promise.resolve(this);
    }
  };
  const prevFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add() {}, delete() {}, check: () => true, load: async () => [] } });
  restore = () => {
    if (hadFontFace) g.FontFace = prevFontFace;
    else delete g.FontFace;
    if (prevFonts) Object.defineProperty(document, 'fonts', prevFonts);
    else delete (document as unknown as { fonts?: unknown }).fonts;
  };
});

afterAll(() => restore());

const fontBytes = (n: number) => new Uint8Array(n).map((_, i) => (i * 7) & 255).buffer;

function docWithText(family: string) {
  const doc = createDocument({ name: 'Friend Poster', width: 50, height: 20, background: null });
  const l = makeTextLayer({ text: { content: 'Hi' } });
  l.text.fontFamily = family;
  insertLayerDraft(doc, l, {});
  return doc;
}

describe('session-only fonts in background encodes', () => {
  it('a font embedded in an opened project is listed as session-only', async () => {
    const added = await registerEmbeddedFonts([{ family: 'FriendFont', weight: 400, style: 'normal', fileName: 'friend.woff2', format: 'woff2', data: fontBytes(64) }], () => false);
    expect(added).toEqual(['FriendFont']);
    const files = await userFontFiles(['FriendFont'], { sessionOnly: true });
    expect(files.map((f) => f.family)).toEqual(['FriendFont']);
  });

  it('autosave entries carry it (they used to carry no fonts at all)', async () => {
    const data = await encodeProject(docWithText('FriendFont'), { background: true });
    const { fonts } = unpackContainer(data);
    expect(fonts.map((f) => `${f.family}/${f.weight}/${f.style}`)).toEqual(['FriendFont/400/normal']);
    expect(fonts[0].data.byteLength).toBe(64);
  });

  it('templates embed every user font; ordinary saves too', async () => {
    for (const opts of [{ background: true, fonts: 'all' as const }, {}]) {
      const { fonts } = unpackContainer(await encodeProject(docWithText('FriendFont'), opts));
      expect(fonts.map((f) => f.family)).toEqual(['FriendFont']);
    }
  });

  it('documents without user fonts embed nothing', async () => {
    const { fonts } = unpackContainer(await encodeProject(docWithText('sans-serif'), { background: true }));
    expect(fonts).toEqual([]);
  });
});
