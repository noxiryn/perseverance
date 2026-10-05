import { describe, expect, it } from 'vitest';
import { isPgfx, packContainer, PGFX_VERSION, unpackContainer } from './container';

const fakePng = (n: number, seed: number) => {
  const a = new Uint8Array(n);
  a.set([0x89, 0x50, 0x4e, 0x47].slice(0, n));
  for (let i = 4; i < n; i++) a[i] = (i * 31 + seed) & 255;
  return a;
};

describe('pgfx container', () => {
  it('round-trips header and blobs', () => {
    const doc = { id: 'doc_1', name: 'Test ünïcødé 漢字', width: 10, height: 20, layers: {}, rootIds: [] };
    const blobs = [
      { id: 'bmp_a', width: 10, height: 20, data: fakePng(37, 1) },
      { id: 'bmp_b', width: 3, height: 4, data: fakePng(5, 9).buffer as ArrayBuffer },
      { id: 'bmp_c', width: 1, height: 1, data: new Uint8Array(0) },
    ];
    const buf = packContainer({ version: PGFX_VERSION, app: 'Perseverance test', document: doc }, blobs);
    expect(isPgfx(buf)).toBe(true);
    const out = unpackContainer(buf);
    expect(out.version).toBe(PGFX_VERSION);
    expect(out.header.document).toEqual(doc);
    expect(out.header.app).toBe('Perseverance test');
    expect(out.header.bitmaps.map((b) => [b.id, b.width, b.height, b.length])).toEqual([
      ['bmp_a', 10, 20, 37],
      ['bmp_b', 3, 4, 5],
      ['bmp_c', 1, 1, 0],
    ]);
    expect([...out.blobs[0].data]).toEqual([...(blobs[0].data as Uint8Array)]);
    expect([...out.blobs[1].data]).toEqual([...fakePng(5, 9)]);
    expect(out.blobs[2].data.byteLength).toBe(0);
  });

  it('writes the documented preamble', () => {
    const buf = packContainer({ version: 1, app: 'x', document: { a: 1 } }, []);
    const b = new Uint8Array(buf);
    expect(String.fromCharCode(b[0], b[1], b[2], b[3])).toBe('PGFX');
    const v = new DataView(buf);
    expect(v.getUint16(4, true)).toBe(PGFX_VERSION);
    const len = v.getUint32(6, true);
    expect(10 + len).toBe(b.byteLength);
    expect(JSON.parse(new TextDecoder().decode(b.subarray(10)))).toMatchObject({ document: { a: 1 }, bitmaps: [] });
  });

  it('accepts a Uint8Array view with a byte offset', () => {
    const buf = packContainer({ version: 1, app: 'x', document: { ok: true } }, [{ id: 'q', width: 2, height: 2, data: fakePng(8, 3) }]);
    const padded = new Uint8Array(buf.byteLength + 7);
    padded.set(new Uint8Array(buf), 7);
    const out = unpackContainer(padded.subarray(7));
    expect(out.header.document).toEqual({ ok: true });
    expect([...out.blobs[0].data]).toEqual([...fakePng(8, 3)]);
  });

  it('rejects invalid input', () => {
    expect(() => unpackContainer(new Uint8Array([1, 2, 3]))).toThrow(/signature/);
    const buf = new Uint8Array(
      packContainer({ version: 1, app: 'x', document: {} }, [{ id: 'z', width: 1, height: 1, data: fakePng(16, 0) }]),
    );
    expect(() => unpackContainer(buf.subarray(0, buf.byteLength - 4))).toThrow(/truncated/);
    const future = new Uint8Array(buf);
    new DataView(future.buffer).setUint16(4, 999, true);
    expect(() => unpackContainer(future)).toThrow(/newer version/);
  });
});
