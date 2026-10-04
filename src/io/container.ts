/**
 * .pgfx binary container (pure — no DOM, unit-tested).
 *
 * Layout (all integers little-endian):
 *   0   4 bytes   magic "PGFX"
 *   4   uint16    container version
 *   6   uint32    header JSON byte length (N)
 *   10  N bytes   header JSON (UTF-8): { version, app, document, bitmaps: [{ id, width, height, offset, length }], ... }
 *   10+N …        concatenated PNG blobs; each bitmap's `offset` is relative to the start of this data section.
 */

export const PGFX_MAGIC = 'PGFX';
export const PGFX_VERSION = 1;
const PREAMBLE = 4 + 2 + 4;

export interface ContainerBitmapEntry {
  id: string;
  width: number;
  height: number;
  /** Byte offset of the PNG data relative to the start of the data section. */
  offset: number;
  /** Byte length of the PNG data. */
  length: number;
}

export interface ContainerHeader {
  version: number;
  app: string;
  /** The Document JSON. Kept as unknown here; validated by the project loader. */
  document: unknown;
  bitmaps: ContainerBitmapEntry[];
  [extra: string]: unknown;
}

export interface ContainerBlob {
  id: string;
  width: number;
  height: number;
  data: ArrayBuffer | Uint8Array;
}

export interface UnpackedContainer {
  version: number;
  header: ContainerHeader;
  blobs: { id: string; width: number; height: number; data: Uint8Array }[];
}

function toBytes(d: ArrayBuffer | Uint8Array): Uint8Array {
  return d instanceof Uint8Array ? d : new Uint8Array(d);
}

/** Build a .pgfx container. `header.bitmaps` is generated from `blobs` (any value passed is replaced). */
export function packContainer(header: Omit<ContainerHeader, 'bitmaps'> & { bitmaps?: unknown }, blobs: ContainerBlob[]): ArrayBuffer {
  const entries: ContainerBitmapEntry[] = [];
  let offset = 0;
  const parts = blobs.map((b) => {
    const bytes = toBytes(b.data);
    entries.push({ id: b.id, width: b.width, height: b.height, offset, length: bytes.byteLength });
    offset += bytes.byteLength;
    return bytes;
  });
  const json = new TextEncoder().encode(JSON.stringify({ ...header, bitmaps: entries }));
  const out = new Uint8Array(PREAMBLE + json.byteLength + offset);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = PGFX_MAGIC.charCodeAt(i);
  view.setUint16(4, PGFX_VERSION, true);
  view.setUint32(6, json.byteLength, true);
  out.set(json, PREAMBLE);
  let p = PREAMBLE + json.byteLength;
  for (const bytes of parts) {
    out.set(bytes, p);
    p += bytes.byteLength;
  }
  return out.buffer;
}

/** True if the buffer starts with the PGFX magic. */
export function isPgfx(buf: ArrayBuffer | Uint8Array): boolean {
  const b = toBytes(buf);
  if (b.byteLength < PREAMBLE) return false;
  for (let i = 0; i < 4; i++) if (b[i] !== PGFX_MAGIC.charCodeAt(i)) return false;
  return true;
}

/** Parse a .pgfx container. Throws a descriptive Error for invalid/corrupt files. */
export function unpackContainer(buf: ArrayBuffer | Uint8Array): UnpackedContainer {
  const bytes = toBytes(buf);
  if (!isPgfx(bytes)) throw new Error('Not a Perseverance project (missing PGFX signature)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version > PGFX_VERSION) throw new Error(`This project was saved by a newer version of Perseverance (format v${version})`);
  const headerLen = view.getUint32(6, true);
  if (PREAMBLE + headerLen > bytes.byteLength) throw new Error('Project file is truncated (header)');
  let header: ContainerHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(PREAMBLE, PREAMBLE + headerLen))) as ContainerHeader;
  } catch {
    throw new Error('Project file is corrupt (invalid header)');
  }
  if (!header || typeof header !== 'object' || !header.document) throw new Error('Project file is corrupt (no document)');
  const entries = Array.isArray(header.bitmaps) ? header.bitmaps : [];
  const dataStart = PREAMBLE + headerLen;
  const blobs = entries.map((e) => {
    const start = dataStart + (e.offset | 0);
    const end = start + (e.length | 0);
    if (e.offset < 0 || e.length < 0 || end > bytes.byteLength) throw new Error(`Project file is truncated (bitmap ${e.id})`);
    return { id: String(e.id), width: e.width | 0, height: e.height | 0, data: bytes.subarray(start, end) };
  });
  return { version, header: { ...header, bitmaps: entries }, blobs };
}
