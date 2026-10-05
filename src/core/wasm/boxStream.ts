/**
 * WebAssembly version of the streaming box blur of src/filters/stylize/util.ts (`runBoxPasses` /
 * `BoxStream`): pass p is a horizontal box H_p followed by a vertical box V_p, chained row by row
 * through small ring buffers. The row orchestration below is the same as BoxStream's (same row
 * order, same ring indexing); the per-row arithmetic runs in the generated kernels (hrowN, vrow,
 * vrowext, addrow), which perform exactly the JavaScript float operations — so the output is
 * bit-identical to the JavaScript path. All state lives in WebAssembly memory (addressed by byte
 * offsets, see runtime.ts for the allocation rules).
 */
import { wasm, wasmAlloc, wasmHeap, wasmMark, wasmRelease } from './runtime';

/** Where rows come from / go to (always in place: input row y is consumed before output row y is written). */
export type BoxIO =
  /** a JavaScript float buffer of `w·ch` floats per row */
  | { kind: 'f32'; buf: Float32Array }
  /** floats already in WebAssembly memory at byte address `ptr` */
  | { kind: 'ptr'; ptr: number }
  /** RGBA bytes, blurred as premultiplied floats (ch = 4) and written back un-premultiplied */
  | { kind: 'premul'; data: Uint8ClampedArray }
  /** the RGB of RGBA bytes (ch = 3; alpha untouched) */
  | { kind: 'rgb'; data: Uint8ClampedArray };

/**
 * Run the box passes (radius R[p], end-tap weight A[p]; only passes that do something, at least
 * one) over a w×h image of `ch` interleaved channels. Returns false — having touched nothing —
 * when WebAssembly isn't available or its memory can't be had; the caller then runs JavaScript.
 */
export function wasmBoxPasses(io: BoxIO, w: number, h: number, ch: number, R: Int32Array, A: Float64Array): boolean {
  const X = wasm();
  if (!X || w < 1 || h < 1 || ch < 1 || !R.length) return false;
  if ((io.kind === 'premul' && ch !== 4) || (io.kind === 'rgb' && ch !== 3)) return false;
  if ((io.kind === 'premul' || io.kind === 'rgb') && io.data.length < w * h * 4) return false;
  if (io.kind === 'f32' && io.buf.length < w * h * ch) return false;
  // a view of our own memory would be detached by growth: address it directly instead
  if (io.kind === 'f32' && io.buf.buffer === X.memory.buffer) io = { kind: 'ptr', ptr: io.buf.byteOffset };
  const stride = w * ch,
    rowBytes = stride * 4,
    P = R.length;
  const mark = wasmMark();
  try {
    // Ring of H_p rows: V_p's window (2r + 3 rows) plus one row of look-ahead, because H rows are
    // produced two at a time (two independent rows per kernel call overlap their running-sum chains).
    const size = Int32Array.from(R, (r) => Math.min(h, 2 * r + 4));
    // One block for everything, so that a refused allocation never grew (and detached) the memory.
    // Per pass: the ring, the V sums (float64) and two V_{p−1} → H_p hand-over rows; then two input
    // rows, the output row and a byte row.
    const al16 = (n: number) => (n + 15) & ~15;
    let total = 0;
    for (let p = 0; p < P; p++) total += al16(size[p] * rowBytes) + al16(stride * 8) + 2 * al16(rowBytes);
    total += 3 * al16(rowBytes) + al16(w * 4);
    const base = wasmAlloc(total);
    if (!base) return false;
    let at = base;
    const take = (n: number) => {
      const a = at;
      at += al16(n);
      return a;
    };
    const ring: number[] = [],
      sums: number[] = [],
      midA: number[] = [],
      midB: number[] = [];
    for (let p = 0; p < P; p++) {
      ring.push(take(size[p] * rowBytes));
      sums.push(take(stride * 8));
      midA.push(take(rowBytes));
      midB.push(take(rowBytes));
    }
    const inA = take(rowBytes),
      inB = take(rowBytes),
      outRow = take(rowBytes),
      bytes = take(w * 4);
    // no allocation from here on: views stay valid
    const H = wasmHeap();
    for (const s of sums) H.f64.fill(0, s >>> 3, (s >>> 3) + stride);
    const inv = Float64Array.from(R, (r, p) => 1 / (2 * r + 1 + (A[p] > 0 ? 2 * A[p] : 0)));
    const hNext = new Int32Array(P),
      vNext = new Int32Array(P);
    const { hrow1, hrow2, hrow3, hrow4, hrow1x2, hrow2x2, hrow3x2, hrow4x2, vrow, vrowext, addrow, premul_row, unpremul_row, rgb_in, rgb_out } = X;
    const hrowN = [hrow1, hrow1, hrow2, hrow3, hrow4];
    const hrowNx2 = [hrow1x2, hrow1x2, hrow2x2, hrow3x2, hrow4x2];
    const rowStep = w * 4;

    /** Byte address of input row k (read into `buf` unless it already is in WebAssembly memory). */
    const source = (k: number, buf: number): number => {
      switch (io.kind) {
        case 'ptr':
          return io.ptr + k * rowBytes;
        case 'f32':
          H.f32.set(io.buf.subarray(k * stride, k * stride + stride), buf >>> 2);
          return buf;
        case 'premul':
          H.u8.set(io.data.subarray(k * rowStep, k * rowStep + rowStep), bytes);
          premul_row(bytes, buf, rowStep);
          return buf;
        case 'rgb':
          H.u8.set(io.data.subarray(k * rowStep, k * rowStep + rowStep), bytes);
          rgb_in(bytes, buf, w);
          return buf;
      }
    };
    /** Write outRow as output row y. */
    const sink = (y: number) => {
      switch (io.kind) {
        case 'f32':
          io.buf.set(H.f32.subarray(outRow >>> 2, (outRow >>> 2) + stride), y * stride);
          break;
        case 'premul':
          unpremul_row(outRow, bytes, rowStep);
          io.data.set(H.u8.subarray(bytes, bytes + rowStep), y * rowStep);
          break;
        case 'rgb':
          // keep the row's alpha bytes: start from the current row
          H.u8.set(io.data.subarray(y * rowStep, y * rowStep + rowStep), bytes);
          rgb_out(outRow, bytes, w);
          io.data.set(H.u8.subarray(bytes, bytes + rowStep), y * rowStep);
          break;
      }
    };
    /**
     * Horizontal box of every channel of one row (src → dst) or of two rows (src2 → dst2 too, when
     * src2 ≥ 0). Channels are independent: groups of ≤ 4 per kernel call.
     */
    const hrow = (src: number, dst: number, src2: number, dst2: number, p: number) => {
      const r = R[p],
        iv = inv[p],
        al = A[p],
        st = ch * 4;
      for (let c = 0; c < ch; ) {
        const n = ch - c >= 4 ? 4 : ch - c;
        if (src2 < 0) hrowN[n](src + c * 4, dst + c * 4, w, st, r, iv, al);
        else hrowNx2[n](src + c * 4, dst + c * 4, src2 + c * 4, dst2 + c * 4, w, st, r, iv, al);
        c += n;
      }
    };
    /** H_p: produce its next `n` (1 or 2) rows into the ring. */
    const produceH = (p: number, n: number) => {
      const k = hNext[p];
      hNext[p] += n;
      let a: number,
        b = -1;
      if (p > 0) {
        produceV(p - 1, midA[p]);
        a = midA[p];
        if (n === 2) {
          produceV(p - 1, midB[p]);
          b = midB[p];
        }
      } else {
        a = source(k, inA);
        if (n === 2) b = source(k + 1, inB);
      }
      const sz = size[p];
      hrow(a, ring[p] + (k % sz) * rowBytes, b, b < 0 ? -1 : ring[p] + ((k + 1) % sz) * rowBytes, p);
    };
    /** V_p: produce its next output row at byte address dst. */
    const produceV = (p: number, dst: number) => {
      const r = R[p],
        alpha = A[p];
      const y = vNext[p]++;
      const need = y + r + 1 < h ? y + r + 1 : h - 1;
      // pairs (k, k + 1) while k ≤ need; k + 1 may be the one row of look-ahead the ring has room for
      while (hNext[p] <= need) produceH(p, hNext[p] + 1 < h ? 2 : 1);
      const Rg = ring[p],
        S = sums[p],
        sz = size[p];
      if (y === 0) for (let k = -r; k <= r; k++) addrow(S, Rg + ((k < 0 ? 0 : k >= h ? h - 1 : k) % sz) * rowBytes, stride);
      const add = Rg + ((y + r + 1 < h ? y + r + 1 : h - 1) % sz) * rowBytes,
        rem = Rg + ((y - r > 0 ? y - r : 0) % sz) * rowBytes;
      if (alpha === 0) vrow(S, add, rem, dst, stride, inv[p]);
      else vrowext(S, add, rem, Rg + ((y - r - 1 > 0 ? y - r - 1 : 0) % sz) * rowBytes, dst, stride, inv[p], alpha);
    };

    const last = P - 1;
    for (let y = 0; y < h; y++) {
      if (io.kind === 'ptr') produceV(last, io.ptr + y * rowBytes);
      else {
        produceV(last, outRow);
        sink(y);
      }
    }
    return true;
  } finally {
    wasmRelease(mark);
  }
}
