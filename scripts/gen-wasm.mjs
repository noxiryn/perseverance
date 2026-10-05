#!/usr/bin/env node
/**
 * Generator (source of truth) for the WebAssembly blur kernels:
 *
 *   node scripts/gen-wasm.mjs          → rewrites src/core/wasm/blurWasm.generated.ts
 *   node scripts/gen-wasm.mjs --check  → exits 1 when the generated file is out of date
 *
 * No toolchain is needed: this file is a tiny assembler (binary encoder + a folded, WAT-like
 * instruction DSL) and the hand-written kernels. Every kernel performs exactly the same IEEE-754
 * operations, in the same order, as the JavaScript code it replaces (float64 running sums, float32
 * storage between steps, Uint8ClampedArray rounding = round-half-even with clamping), so its output
 * is bit-identical — src/core/wasm/blurWasm.test.ts compares the two on random inputs.
 *
 * Kernels (all addresses are byte offsets in the module's exported memory):
 *  - hrow1..hrow4(src, dst, w, stride, r, inv, alpha): one row of the (extended) box blur of
 *    src/filters/stylize/util.ts `hRow` for 1–4 interleaved channels at once (channel pairs as
 *    f64x2 lanes); `stride` = bytes per pixel, so hrow1 also serves any channel of a wider pixel.
 *    hrow1x2..hrow4x2(src, dst, src2, dst2, …): the same for two rows at once (interleaved chains).
 *  - vrow / vrowext / addrow: the vertical steps of util.ts BoxStream (`vRow`, `vRowExt`, the
 *    initial window sums), f64x2 SIMD.
 *  - premul_row / unpremul_row / rgb_in / rgb_out: util.ts row I/O of blurImage (premultiplyRow,
 *    unpremultiplyRow, the opaque RGB rows).
 *  - ds_premul_row / ds_norm / us_unpremul_row: blurImage's reduced-resolution path
 *    (downsampleRowPremul, the cell normalisation, upsampleRowUnpremul).
 *  - bb_h / bb_v: src/core/blur.ts boxBlurImageData passes (exact integer sums).
 *  - bc_h / bc_v: src/core/blur.ts blurChannel passes (vertical pass walks rows).
 *  - med_rows3/5/7, med_cols3/5/7: src/filters/stylize/median.ts separable median networks (u8x16).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* ------------------------------------------------------------------ */
/* Binary encoding                                                     */
/* ------------------------------------------------------------------ */

function uleb(n) {
  const out = [];
  n >>>= 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function sleb(n) {
  const out = [];
  n |= 0;
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

function f64bytes(v) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v, true);
  return [...new Uint8Array(dv.buffer)];
}

function f32bytes(v) {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, v, true);
  return [...new Uint8Array(dv.buffer)];
}

const TYPE = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b };
const name = (s) => [...uleb(Buffer.byteLength(s)), ...Buffer.from(s, 'utf8')];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];

/* ------------------------------------------------------------------ */
/* Instruction DSL (folded: operands first, like WAT's (op a b))       */
/* ------------------------------------------------------------------ */

const get = (n) => ({ k: 'local', op: 0x20, name: n });
const set = (n, v) => [v, { k: 'local', op: 0x21, name: n }];
let labelSeq = 0;
const label = () => `L${labelSeq++}`;
const block = (lbl, ...body) => ({ k: 'block', op: 0x02, label: lbl, type: null, body });
const loop = (lbl, ...body) => ({ k: 'block', op: 0x03, label: lbl, type: null, body });
const br = (lbl) => ({ k: 'br', op: 0x0c, label: lbl });
const brIf = (lbl, cond) => [cond, { k: 'br', op: 0x0d, label: lbl }];
/** if (cond) then else — statement form (no result) */
const when = (cond, then, els = null) => [cond, { k: 'if', type: null, label: label(), then, else: els }];
/** cond ? a : b — expression form with a result of `type` (only the taken arm is evaluated) */
const cond = (type, c, a, b) => [c, { k: 'if', type, label: label(), then: a, else: b }];
/** while (c) { body } — c is a pure expression, emitted twice (guard + loop back-edge). */
const whileDo = (c, ...body) => {
  const L = label();
  return when(c, [loop(L, ...body, brIf(L, c))]);
};

const op2 = (code) => (a, b) => [a, b, code];
const op1 = (code) => (a) => [a, code];
const mem = (code, align) => (p, off = 0) => [p, code, align, ...uleb(off)];
const memS = (code, align) => (p, v, off = 0) => [p, v, code, align, ...uleb(off)];
const simd = (code) => [0xfd, ...uleb(code)];

const I32 = {
  c: (v) => [0x41, ...sleb(v)],
  add: op2(0x6a),
  sub: op2(0x6b),
  mul: op2(0x6c),
  and: op2(0x71),
  eqz: op1(0x45),
  eq: op2(0x46),
  ne: op2(0x47),
  lt_s: op2(0x48),
  lt_u: op2(0x49),
  gt_s: op2(0x4a),
  le_s: op2(0x4c),
  ge_s: op2(0x4e),
  load: mem(0x28, 2),
  load8u: mem(0x2d, 0),
  store: memS(0x36, 2),
  store8: memS(0x3a, 0),
  /** i32.trunc_sat_f64_u: NaN / negative → 0 */
  truncSatF64U: (a) => [a, 0xfc, ...uleb(3)],
  /** c ? a : b (both evaluated) */
  select: (a, b, c) => [a, b, c, 0x1b],
};
const F64 = {
  c: (v) => [0x44, ...f64bytes(v)],
  add: op2(0xa0),
  sub: op2(0xa1),
  mul: op2(0xa2),
  div: op2(0xa3),
  min: op2(0xa4),
  nearest: op1(0x9e),
  eq: op2(0x61),
  lt: op2(0x63),
  ge: op2(0x66),
  load: mem(0x2b, 3),
  store: memS(0x39, 3),
  promote: op1(0xbb),
  fromI32: op1(0xb7),
  fromU32: op1(0xb8),
};
const F32 = {
  c: (v) => [0x43, ...f32bytes(v)],
  load: mem(0x2a, 2),
  store: memS(0x38, 2),
  demote: op1(0xb6),
  fromU32: op1(0xb3),
};
const V = {
  load: (p, off = 0) => [p, ...simd(0x00), 4, ...uleb(off)],
  store: (p, v, off = 0) => [p, v, ...simd(0x0b), 4, ...uleb(off)],
  zero: () => [...simd(0x0c), ...new Array(16).fill(0)],
  load64z: (p, off = 0) => [p, ...simd(0x5d), 3, ...uleb(off)],
  store64lane0: (p, v, off = 0) => [p, v, ...simd(0x5b), 3, ...uleb(off), 0],
};
const F64X2 = {
  splat: (a) => [a, ...simd(0x14)],
  add: (a, b) => [a, b, ...simd(0xf0)],
  sub: (a, b) => [a, b, ...simd(0xf1)],
  mul: (a, b) => [a, b, ...simd(0xf2)],
  /** two f32 (low half) → two f64 */
  promoteLow: (a) => [a, ...simd(0x5f)],
};
Object.assign(V, {
  bytes: (lanes) => [...simd(0x0c), ...lanes], // v128.const
  or: (a, b) => [a, b, ...simd(0x50)],
  load32z: (p, off = 0) => [p, ...simd(0x5c), 2, ...uleb(off)],
  store32lane0: (p, v, off = 0) => [p, v, ...simd(0x5a), 2, ...uleb(off), 0],
  /** i8x16.shuffle: result byte i = (a ++ b)[lanes[i]] */
  shuffle: (a, b, lanes) => [a, b, ...simd(0x0d), ...lanes],
});
Object.assign(F64X2, {
  nearest: (a) => [a, ...simd(0x94)],
  /** two u32 (low half) → two f64 (exact) */
  fromLowU32: (a) => [a, ...simd(0xff)],
  replaceLane: (a, lane, v) => [a, v, ...simd(0x22), lane],
});
const F32X4 = {
  demoteZero: (a) => [a, ...simd(0x5e)],
  nearest: (a) => [a, ...simd(0x6a)],
  extract: (a, lane) => [a, ...simd(0x1f), lane],
  fromU32: (a) => [a, ...simd(0xfb)],
};
const I32X4 = {
  splat: (a) => [a, ...simd(0x11)],
  minS: (a, b) => [a, b, ...simd(0xb6)],
  extract: (a, lane) => [a, ...simd(0x1b), lane],
  /** u16 (low half) → u32 */
  extendLowU16: (a) => [a, ...simd(0xa9)],
  /** saturating, NaN → 0 */
  truncSatF32S: (a) => [a, ...simd(0xf8)],
  /** two f64 → two i32 in the low lanes (saturating, NaN → 0), high lanes 0 */
  truncSatF64SZero: (a) => [a, ...simd(0xfc)],
};
const I16X8 = {
  /** u8 (low half) → u16 */
  extendLowU8: (a) => [a, ...simd(0x89)],
  /** signed i32 → u16 with saturation (negative → 0) */
  narrowI32U: (a, b) => [a, b, ...simd(0x86)],
};
const I8X16 = {
  /** signed i16 → u8 with saturation */
  narrowI16U: (a, b) => [a, b, ...simd(0x66)],
};
const U8X16 = {
  min: (a, b) => [a, b, ...simd(0x77)],
  max: (a, b) => [a, b, ...simd(0x79)],
};
/** Shuffle lanes: bytes of 32-bit lanes (a: 0–3, b: 4–7) */
const lanes32 = (...ls) => ls.flatMap((l) => [l * 4, l * 4 + 1, l * 4 + 2, l * 4 + 3]);
/**
 * ToUint8Clamp of the four lanes of an i32x4 that holds nearest-rounded, saturated values: clamp
 * to ≤ 255 (the unsigned narrowing turns negatives into 0). `k255` = local with i32x4.splat(255).
 */
const clampI = (t) => I32X4.minS(t, g('k255'));
/** f32x4 → i32x4 of ToUint8Clamp(lane) (round half to even, NaN → 0, clamped to 0..255). */
const u8f32x4 = (v) => clampI(I32X4.truncSatF32S(F32X4.nearest(v)));
/** Pack four clamped i32x4 into 16 bytes (lanes in order). */
const pack16 = (t0, t1, t2, t3) => I8X16.narrowI16U(I16X8.narrowI32U(t0, t1), I16X8.narrowI32U(t2, t3));
/** Pack one clamped i32x4 into its low 4 bytes. */
const pack4 = (t) => [set('pk', t), I8X16.narrowI16U(I16X8.narrowI32U(g('pk'), g('pk')), I16X8.narrowI32U(g('pk'), g('pk')))];

// shorthands
const g = get;
const inc = (n, by = 1) => set(n, I32.add(g(n), typeof by === 'number' ? I32.c(by) : by));
const i32min = (a, b) => I32.select(a, b, I32.lt_s(a, b)); // a, b must be side-effect free
const i32max = (a, b) => I32.select(a, b, I32.gt_s(a, b));
/** Math.fround */
const fround = (v) => F64.promote(F32.demote(v));
/**
 * Uint8ClampedArray store conversion (ToUint8Clamp): NaN → 0, clamp to 0..255, round half to even.
 * Scalar form for row tails and the integer box blur; the hot rows use the SIMD forms above.
 */
const u8 = (v) => I32.truncSatF64U(F64.min(F64.nearest(v), F64.c(255)));

/* ------------------------------------------------------------------ */
/* Functions                                                           */
/* ------------------------------------------------------------------ */

const funcs = [];
/** params / locals: { name: type } (insertion order = index order) */
function func(fname, params, locals, body) {
  funcs.push({ name: fname, params: Object.entries(params), locals: Object.entries(locals), body });
}

function emit(node, ctx, out) {
  if (typeof node === 'number') out.push(node);
  else if (Array.isArray(node)) for (const n of node) emit(n, ctx, out);
  else if (node.k === 'local') {
    const i = ctx.locals.get(node.name);
    if (i === undefined) throw new Error(`${ctx.fn}: unknown local ${node.name}`);
    out.push(node.op, ...uleb(i));
  } else if (node.k === 'block') {
    out.push(node.op, node.type ? TYPE[node.type] : 0x40);
    ctx.labels.push(node.label);
    emit(node.body, ctx, out);
    ctx.labels.pop();
    out.push(0x0b);
  } else if (node.k === 'if') {
    out.push(0x04, node.type ? TYPE[node.type] : 0x40);
    ctx.labels.push(node.label);
    emit(node.then, ctx, out);
    if (node.else) {
      out.push(0x05);
      emit(node.else, ctx, out);
    }
    ctx.labels.pop();
    out.push(0x0b);
  } else if (node.k === 'br') {
    const at = ctx.labels.lastIndexOf(node.label);
    if (at < 0) throw new Error(`${ctx.fn}: branch to unknown label ${node.label}`);
    out.push(node.op, ...uleb(ctx.labels.length - 1 - at));
  } else throw new Error(`${ctx.fn}: bad node ${JSON.stringify(node)}`);
}

/* ---------------- util.ts hRow, 1–4 channels ---------------- */

/** Lane helpers: a group is one channel (f64) or two adjacent channels (f64x2). */
function laneOps(kind) {
  if (kind === 's')
    return {
      t: 'f64',
      load: (p, off) => F64.promote(F32.load(p, off)),
      store: (p, v, off) => F32.store(p, F32.demote(v), off),
      add: F64.add,
      sub: F64.sub,
      mul: F64.mul,
      zero: () => F64.c(0),
      inv: () => g('inv'),
      alpha: () => g('alpha'),
    };
  return {
    t: 'v128',
    load: (p, off) => F64X2.promoteLow(V.load64z(p, off)),
    store: (p, v, off) => V.store64lane0(p, F32X4.demoteZero(v), off),
    add: F64X2.add,
    sub: F64X2.sub,
    mul: F64X2.mul,
    zero: () => V.zero(),
    inv: () => g('invv'),
    alpha: () => g('alphav'),
  };
}

/**
 * hRow of util.ts for the channels in `plan` (each { kind: 's' | 'v', off: byte offset in the pixel }),
 * for one row or two rows at once (`rows` = 2: two independent rows interleaved in one loop, so the
 * two running-sum dependency chains overlap — the loop is otherwise bound by the add latency).
 * Same phases and the same float64 operations per channel and row as the JS:
 *   sum = Σ taps (clamped), then per x: dst = sum·inv (or (sum + α·(left + right))·inv) and
 *   sum += add − rem.
 */
function hrowFn(fname, plan, rows = 1) {
  const locals = { x: 'i32', k: 'i32', xAdd: 'i32', xRem: 'i32', xm: 'i32', invv: 'v128', alphav: 'v128' };
  const params = { src: 'i32', dst: 'i32' };
  if (rows === 2) Object.assign(params, { src2: 'i32', dst2: 'i32' });
  Object.assign(params, { w: 'i32', st: 'i32', r: 'i32', inv: 'f64', alpha: 'f64' });
  const RW = [];
  for (let ri = 0; ri < rows; ri++) {
    const sfx = ri ? '2' : '';
    const R = { src: 'src' + sfx, dst: 'dst' + sfx, p: 'p' + sfx, pa: 'pa' + sfx, pr: 'pr' + sfx, pd: 'pd' + sfx, lastp: 'lastp' + sfx };
    for (const n of ['p', 'pa', 'pr', 'pd', 'lastp']) locals[R[n]] = 'i32';
    RW.push(R);
  }
  const G = [];
  RW.forEach((R, ri) =>
    plan.forEach((q, i) => {
      const o = laneOps(q.kind);
      const id = `${i}_${ri}`;
      for (const n of ['f', 'l', 's', 'a', 'm', 'v', 'c']) locals[n + id] = o.t;
      G.push({ ...o, R, off: q.off, f: 'f' + id, l: 'l' + id, s: 's' + id, a: 'a' + id, m: 'm' + id, v: 'v' + id, c: 'c' + id });
    }),
  );
  const each = (fn) => G.map(fn);
  const eachRow = (fn) => RW.map(fn);
  /** x += 1 and the named pointers of every row += stride */
  const step = (...ptrs) => [inc('x'), ...RW.flatMap((R) => ptrs.map((n) => inc(R[n], g('st'))))];
  const at = (R, n) => I32.add(g(R.src), I32.mul(n, g('st'))); // src + n·stride
  const xr = I32.sub(g('x'), g('r')); // x − r
  const storeOut = (val) => each((q) => q.store(g(q.R.pd), val(q), q.off));
  const plain = (q) => q.mul(g(q.s), q.inv());
  const ext = (left, right) => (q) => q.mul(q.add(g(q.s), q.mul(q.alpha(), q.add(left(q), right(q)))), q.inv());
  const pick = (q, c, a) => cond(q.t, c, [q.load(a, q.off)], [g(q.f)]); // c ? src[a] : first
  const setPr = () => eachRow((R) => set(R.pr, at(R, xr)));

  const alpha0 = [
    // x < xm: add tap inside, rem tap = first
    whileDo(I32.lt_s(g('x'), g('xm')), storeOut(plain), each((q) => set(q.s, q.add(g(q.s), q.sub(q.load(g(q.R.pa), q.off), g(q.f))))), step('pd', 'pa')),
    when(
      I32.ge_s(g('xAdd'), g('xRem')),
      [setPr(), whileDo(I32.lt_s(g('x'), g('xAdd')), storeOut(plain), each((q) => set(q.s, q.add(g(q.s), q.sub(q.load(g(q.R.pa), q.off), q.load(g(q.R.pr), q.off))))), step('pd', 'pa', 'pr'))],
      [each((q) => set(q.c, q.sub(g(q.l), g(q.f)))), whileDo(I32.lt_s(g('x'), g('xRem')), storeOut(plain), each((q) => set(q.s, q.add(g(q.s), g(q.c)))), step('pd'))],
    ),
    setPr(),
    whileDo(I32.lt_s(g('x'), g('w')), storeOut(plain), each((q) => set(q.s, q.add(g(q.s), q.sub(g(q.l), pick(q, I32.gt_s(xr, I32.c(0)), g(q.R.pr)))))), step('pd', 'pr')),
  ];

  const alphaExt = [
    whileDo(
      I32.lt_s(g('x'), g('xm')),
      each((q) => set(q.a, q.load(g(q.R.pa), q.off))),
      storeOut(ext((q) => g(q.f), (q) => g(q.a))),
      each((q) => set(q.s, q.add(g(q.s), q.sub(g(q.a), g(q.f))))),
      step('pd', 'pa'),
    ),
    when(
      I32.ge_s(g('xAdd'), g('xRem')),
      [
        setPr(),
        // prevRem = x − r − 1 > 0 ? src[x − r − 1] : first
        each((q) => set(q.v, pick(q, I32.gt_s(I32.sub(xr, I32.c(1)), I32.c(0)), I32.sub(g(q.R.pr), g('st'))))),
        whileDo(
          I32.lt_s(g('x'), g('xAdd')),
          each((q) => [set(q.a, q.load(g(q.R.pa), q.off)), set(q.m, q.load(g(q.R.pr), q.off))]),
          storeOut(ext((q) => g(q.v), (q) => g(q.a))),
          each((q) => [set(q.s, q.add(g(q.s), q.sub(g(q.a), g(q.m)))), set(q.v, g(q.m))]),
          step('pd', 'pa', 'pr'),
        ),
      ],
      [
        each((q) => [set(q.c, q.sub(g(q.l), g(q.f))), set(q.m, q.mul(q.alpha(), q.add(g(q.f), g(q.l))))]),
        whileDo(
          I32.lt_s(g('x'), g('xRem')),
          storeOut((q) => q.mul(q.add(g(q.s), g(q.m)), q.inv())),
          each((q) => set(q.s, q.add(g(q.s), g(q.c)))),
          step('pd'),
        ),
      ],
    ),
    setPr(),
    whileDo(
      I32.lt_s(g('x'), g('w')),
      // left = rem − 1 > 0 ? src[rem − 1] : first   (rem = x − r)
      each((q) => set(q.v, pick(q, I32.gt_s(I32.sub(xr, I32.c(1)), I32.c(0)), I32.sub(g(q.R.pr), g('st'))))),
      storeOut(ext((q) => g(q.v), (q) => g(q.l))),
      each((q) => set(q.s, q.add(g(q.s), q.sub(g(q.l), pick(q, I32.gt_s(xr, I32.c(0)), g(q.R.pr)))))),
      step('pd', 'pr'),
    ),
  ];

  func(fname, params, locals, [
    set('invv', F64X2.splat(g('inv'))),
    set('alphav', F64X2.splat(g('alpha'))),
    eachRow((R) => set(R.lastp, at(R, I32.sub(g('w'), I32.c(1))))),
    each((q) => [set(q.f, q.load(g(q.R.src), q.off)), set(q.l, q.load(g(q.R.lastp), q.off)), set(q.s, q.zero())]),
    // sum over k = −r..r in order: r × first, src[0..min(r, w − 1)], then last for k = w..r
    set('k', I32.c(0)),
    whileDo(I32.lt_s(g('k'), g('r')), each((q) => set(q.s, q.add(g(q.s), g(q.f)))), inc('k')),
    set('k', I32.c(0)),
    eachRow((R) => set(R.p, g(R.src))),
    whileDo(
      I32.and(I32.le_s(g('k'), g('r')), I32.lt_s(g('k'), g('w'))),
      each((q) => set(q.s, q.add(g(q.s), q.load(g(q.R.p), q.off)))),
      inc('k'),
      eachRow((R) => inc(R.p, g('st'))),
    ),
    set('k', g('w')),
    whileDo(I32.le_s(g('k'), g('r')), each((q) => set(q.s, q.add(g(q.s), g(q.l)))), inc('k')),
    // xAdd = max(0, min(w, w − r − 1)), xRem = min(w, r + 1), xm = min(xAdd, xRem)
    set('xAdd', I32.sub(I32.sub(g('w'), g('r')), I32.c(1))),
    set('xAdd', i32min(g('w'), g('xAdd'))),
    set('xAdd', i32max(g('xAdd'), I32.c(0))),
    set('xRem', I32.add(g('r'), I32.c(1))),
    set('xRem', i32min(g('w'), g('xRem'))),
    set('xm', i32min(g('xAdd'), g('xRem'))),
    set('x', I32.c(0)),
    eachRow((R) => [set(R.pd, g(R.dst)), set(R.pa, at(R, I32.add(g('r'), I32.c(1))))]),
    when(F64.eq(g('alpha'), F64.c(0)), alpha0, alphaExt),
  ]);
}

const HPLANS = {
  1: [{ kind: 's', off: 0 }],
  2: [{ kind: 'v', off: 0 }],
  3: [
    { kind: 'v', off: 0 },
    { kind: 's', off: 8 },
  ],
  4: [
    { kind: 'v', off: 0 },
    { kind: 'v', off: 8 },
  ],
};
for (const n of [1, 2, 3, 4]) hrowFn(`hrow${n}`, HPLANS[n]);
for (const n of [1, 2, 3, 4]) hrowFn(`hrow${n}x2`, HPLANS[n], 2);

/* ---------------- util.ts BoxStream vertical steps ---------------- */

/** Pairs as f64x2, then the odd element (if any) as scalar. `pair` / `one` get the step's pointers. */
function pairLoop(ptrs, n, pair, one) {
  return [
    set('e', I32.add(g(ptrs[0].name), I32.mul(I32.and(n, I32.c(-2)), I32.c(ptrs[0].size)))),
    whileDo(I32.lt_u(g(ptrs[0].name), g('e')), pair(), ...ptrs.map((p) => inc(p.name, p.size * 2))),
    when(I32.and(n, I32.c(1)), one()),
  ];
}

// vRow: out = S·inv; S += add − rem
func('vrow', { S: 'i32', ad: 'i32', rm: 'i32', d: 'i32', n: 'i32', inv: 'f64' }, { invv: 'v128', e: 'i32', s: 'v128', t: 'f64' }, [
  set('invv', F64X2.splat(g('inv'))),
  pairLoop(
    [
      { name: 'S', size: 8 },
      { name: 'ad', size: 4 },
      { name: 'rm', size: 4 },
      { name: 'd', size: 4 },
    ],
    g('n'),
    () => [
      set('s', V.load(g('S'))),
      V.store64lane0(g('d'), F32X4.demoteZero(F64X2.mul(g('s'), g('invv')))),
      V.store(g('S'), F64X2.add(g('s'), F64X2.sub(F64X2.promoteLow(V.load64z(g('ad'))), F64X2.promoteLow(V.load64z(g('rm')))))),
    ],
    () => [
      set('t', F64.load(g('S'))),
      F32.store(g('d'), F32.demote(F64.mul(g('t'), g('inv')))),
      F64.store(g('S'), F64.add(g('t'), F64.sub(F64.promote(F32.load(g('ad'))), F64.promote(F32.load(g('rm')))))),
    ],
  ),
]);

// vRowExt: out = (S + α·(up + add))·inv; S += add − rem
func(
  'vrowext',
  { S: 'i32', ad: 'i32', rm: 'i32', up: 'i32', d: 'i32', n: 'i32', inv: 'f64', alpha: 'f64' },
  { invv: 'v128', alphav: 'v128', e: 'i32', s: 'v128', a: 'v128', t: 'f64', b: 'f64' },
  [
    set('invv', F64X2.splat(g('inv'))),
    set('alphav', F64X2.splat(g('alpha'))),
    pairLoop(
      [
        { name: 'S', size: 8 },
        { name: 'ad', size: 4 },
        { name: 'rm', size: 4 },
        { name: 'up', size: 4 },
        { name: 'd', size: 4 },
      ],
      g('n'),
      () => [
        set('s', V.load(g('S'))),
        set('a', F64X2.promoteLow(V.load64z(g('ad')))),
        V.store64lane0(g('d'), F32X4.demoteZero(F64X2.mul(F64X2.add(g('s'), F64X2.mul(g('alphav'), F64X2.add(F64X2.promoteLow(V.load64z(g('up'))), g('a')))), g('invv')))),
        V.store(g('S'), F64X2.add(g('s'), F64X2.sub(g('a'), F64X2.promoteLow(V.load64z(g('rm')))))),
      ],
      () => [
        set('t', F64.load(g('S'))),
        set('b', F64.promote(F32.load(g('ad')))),
        F32.store(g('d'), F32.demote(F64.mul(F64.add(g('t'), F64.mul(g('alpha'), F64.add(F64.promote(F32.load(g('up'))), g('b')))), g('inv')))),
        F64.store(g('S'), F64.add(g('t'), F64.sub(g('b'), F64.promote(F32.load(g('rm')))))),
      ],
    ),
  ],
);

// S[q] += row[q]
func('addrow', { S: 'i32', row: 'i32', n: 'i32' }, { e: 'i32' }, [
  pairLoop(
    [
      { name: 'S', size: 8 },
      { name: 'row', size: 4 },
    ],
    g('n'),
    () => V.store(g('S'), F64X2.add(V.load(g('S')), F64X2.promoteLow(V.load64z(g('row'))))),
    () => F64.store(g('S'), F64.add(F64.load(g('S')), F64.promote(F32.load(g('row'))))),
  ),
]);

/* ---------------- util.ts blurImage row I/O ---------------- */

const byte = (c) => F64.fromU32(I32.load8u(g('pb'), c));
/** the four bytes at pb as i32x4 lanes */
const bytes4 = () => I32X4.extendLowU16(I16X8.extendLowU8(V.load32z(g('pb'))));

// premultiplyRow: n bytes of RGBA at b → n floats at f. Per pixel: a = 255 → the bytes as floats;
// 0 < a < 255 → float32(byte · (a / 255)) for RGB (float64 products, lane-wise) and a; a = 0 → zeros.
func('premul_row', { b: 'i32', f: 'i32', n: 'i32' }, { pb: 'i32', pf: 'i32', e: 'i32', a: 'i32', m: 'f64', q: 'v128' }, [
  set('pb', g('b')),
  set('pf', g('f')),
  set('e', I32.add(g('b'), g('n'))),
  whileDo(
    I32.lt_u(g('pb'), g('e')),
    set('a', I32.load8u(g('pb'), 3)),
    when(
      I32.eq(g('a'), I32.c(255)),
      V.store(g('pf'), F32X4.fromU32(bytes4())),
      [
        when(
          g('a'),
          [
            set('m', F64.div(F64.fromU32(g('a')), F64.c(255))),
            set('q', bytes4()),
            // lanes (r, g) · m and (b, a) · (m, 1) in float64, rounded to float32, repacked
            V.store(
              g('pf'),
              V.shuffle(
                F32X4.demoteZero(F64X2.mul(F64X2.fromLowU32(g('q')), F64X2.splat(g('m')))),
                F32X4.demoteZero(F64X2.mul(F64X2.fromLowU32(V.shuffle(g('q'), g('q'), lanes32(2, 3, 2, 3))), F64X2.replaceLane(F64X2.splat(g('m')), 1, F64.c(1)))),
                lanes32(0, 1, 4, 5),
              ),
            ),
          ],
          V.store(g('pf'), V.zero()),
        ),
      ],
    ),
    inc('pb', 4),
    inc('pf', 16),
  ),
]);

const flt = (c) => F64.promote(F32.load(g('pf'), c * 4));
const ALPHA_255 = V.bytes([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);

// unpremultiplyRow: n floats at f → n bytes at b. Per pixel: a ≥ 254.5 → u8 of the floats, alpha
// 255; a < 0.5 → zeros; else u8(c · (255 / a)) in float64 and u8(a).
func('unpremul_row', { f: 'i32', b: 'i32', n: 'i32' }, { pb: 'i32', pf: 'i32', e: 'i32', a: 'f64', m: 'f64', v: 'v128', k255: 'v128', pk: 'v128' }, [
  set('k255', I32X4.splat(I32.c(255))),
  set('pb', g('b')),
  set('pf', g('f')),
  set('e', I32.add(g('b'), g('n'))),
  whileDo(
    I32.lt_u(g('pb'), g('e')),
    set('v', V.load(g('pf'))),
    set('a', F64.promote(F32X4.extract(g('v'), 3))),
    when(
      F64.ge(g('a'), F64.c(254.5)),
      V.store32lane0(g('pb'), V.or(pack4(u8f32x4(g('v'))), ALPHA_255)),
      [
        when(F64.lt(g('a'), F64.c(0.5)), I32.store(g('pb'), I32.c(0)), [
          set('m', F64.div(F64.c(255), g('a'))),
          V.store32lane0(
            g('pb'),
            pack4(
              clampI(
                V.shuffle(
                  I32X4.truncSatF64SZero(F64X2.nearest(F64X2.mul(F64X2.promoteLow(g('v')), F64X2.splat(g('m'))))),
                  I32X4.truncSatF64SZero(F64X2.nearest(F64X2.mul(F64X2.promoteLow(V.shuffle(g('v'), g('v'), lanes32(2, 3, 2, 3))), F64X2.replaceLane(F64X2.splat(g('m')), 1, F64.c(1))))),
                  lanes32(0, 1, 4, 5),
                ),
              ),
            ),
          ),
        ]),
      ],
    ),
    inc('pb', 4),
    inc('pf', 16),
  ),
]);

// opaque rows: RGB bytes of w RGBA pixels ↔ 3·w floats; 4 pixels per step, then one at a time
func('rgb_in', { b: 'i32', f: 'i32', w: 'i32' }, { pb: 'i32', pf: 'i32', e: 'i32', e4: 'i32', v: 'v128' }, [
  set('pb', g('b')),
  set('pf', g('f')),
  set('e', I32.add(g('b'), I32.mul(g('w'), I32.c(4)))),
  set('e4', I32.add(g('b'), I32.mul(I32.and(g('w'), I32.c(-4)), I32.c(4)))),
  whileDo(
    I32.lt_u(g('pb'), g('e4')),
    set('v', V.load(g('pb'))),
    [
      [0, 1, 2, 4],
      [5, 6, 8, 9],
      [10, 12, 13, 14],
    ].map((ls, k) => V.store(g('pf'), F32X4.fromU32(I32X4.extendLowU16(I16X8.extendLowU8(V.shuffle(g('v'), g('v'), [...ls, ...ls, ...ls, ...ls])))), k * 16)),
    inc('pb', 16),
    inc('pf', 48),
  ),
  whileDo(I32.lt_u(g('pb'), g('e')), [0, 1, 2].map((c) => F32.store(g('pf'), F32.fromU32(I32.load8u(g('pb'), c)), c * 4)), inc('pb', 4), inc('pf', 12)),
]);
func('rgb_out', { f: 'i32', b: 'i32', w: 'i32' }, { pb: 'i32', pf: 'i32', e: 'i32', e4: 'i32', k255: 'v128' }, [
  set('k255', I32X4.splat(I32.c(255))),
  set('pb', g('b')),
  set('pf', g('f')),
  set('e', I32.add(g('b'), I32.mul(g('w'), I32.c(4)))),
  set('e4', I32.add(g('b'), I32.mul(I32.and(g('w'), I32.c(-4)), I32.c(4)))),
  whileDo(
    I32.lt_u(g('pb'), g('e4')),
    // 12 converted RGB bytes, interleaved with the 4 alpha bytes already there
    V.store(
      g('pb'),
      V.shuffle(
        pack16(u8f32x4(V.load(g('pf'))), u8f32x4(V.load(g('pf'), 16)), u8f32x4(V.load(g('pf'), 32)), g('k255')),
        V.load(g('pb')),
        [0, 1, 2, 19, 3, 4, 5, 23, 6, 7, 8, 27, 9, 10, 11, 31],
      ),
    ),
    inc('pb', 16),
    inc('pf', 48),
  ),
  whileDo(I32.lt_u(g('pb'), g('e')), [0, 1, 2].map((c) => I32.store8(g('pb'), u8(flt(c)), c)), inc('pb', 4), inc('pf', 12)),
]);

/* ---------------- util.ts blurImage reduced-resolution path ---------------- */

// downsampleRowPremul: one image row (bytes at b) added into its w2 cells at sm (4 floats per cell)
func(
  'ds_premul_row',
  { b: 'i32', w: 'i32', fc: 'i32', w2: 'i32', sm: 'i32' },
  { pb: 'i32', x: 'i32', x0: 'i32', x1: 'i32', x2: 'i32', a: 'i32', m: 'f64', s0: 'f64', s1: 'f64', s2: 'f64', s3: 'f64' },
  [
    set('pb', g('b')),
    whileDo(
      I32.lt_s(g('x2'), g('w2')),
      set('x1', I32.add(g('x0'), g('fc'))),
      set('x1', i32min(g('x1'), g('w'))),
      [0, 1, 2, 3].map((c) => set('s' + c, F64.promote(F32.load(g('sm'), c * 4)))),
      set('x', g('x0')),
      whileDo(
        I32.lt_s(g('x'), g('x1')),
        set('a', I32.load8u(g('pb'), 3)),
        when(
          I32.eq(g('a'), I32.c(255)),
          [[0, 1, 2].map((c) => set('s' + c, fround(F64.add(g('s' + c), byte(c))))), set('s3', fround(F64.add(g('s3'), F64.c(255))))],
          [
            when(g('a'), [
              set('m', F64.div(F64.fromU32(g('a')), F64.c(255))),
              [0, 1, 2].map((c) => set('s' + c, fround(F64.add(g('s' + c), fround(F64.mul(byte(c), g('m'))))))),
              set('s3', fround(F64.add(g('s3'), F64.fromU32(g('a'))))),
            ]),
          ],
        ),
        inc('x'),
        inc('pb', 4),
      ),
      [0, 1, 2, 3].map((c) => F32.store(g('sm'), F32.demote(g('s' + c)), c * 4)),
      inc('x0', g('fc')),
      inc('x2'),
      inc('sm', 16),
    ),
  ],
);

// the cell normalisation of one cell row: cell ·= 1 / (cell width · kh)
func('ds_norm', { sm: 'i32', w: 'i32', fc: 'i32', w2: 'i32', kh: 'i32' }, { x0: 'i32', x1: 'i32', x2: 'i32', k: 'f64' }, [
  whileDo(
    I32.lt_s(g('x2'), g('w2')),
    set('x1', I32.add(g('x0'), g('fc'))),
    set('x1', i32min(g('x1'), g('w'))),
    set('k', F64.div(F64.c(1), F64.fromI32(I32.mul(I32.sub(g('x1'), g('x0')), g('kh'))))),
    [0, 1, 2, 3].map((c) => F32.store(g('sm'), F32.demote(F64.mul(F64.promote(F32.load(g('sm'), c * 4)), g('k'))), c * 4)),
    inc('x0', g('fc')),
    inc('x2'),
    inc('sm', 16),
  ),
]);

// upsampleRowUnpremul: bilinear between grid rows r0 / r1 (byte addresses), x taps from xi0/xi1
// (byte offsets, i32 arrays) and xt (f32 array), un-premultiplied into w RGBA pixels at b.
// Channel pairs (r, g) and (b, a) as f64x2 lanes: top = A + (A1 − A)·tx, bot likewise, value =
// fround(top + (bot − top)·ty) — the JS operations lane by lane.
func(
  'us_unpremul_row',
  { r0: 'i32', r1: 'i32', ty: 'f64', xi0: 'i32', xi1: 'i32', xt: 'i32', b: 'i32', w: 'i32' },
  {
    pb: 'i32', e: 'i32', o0: 'i32', o1: 'i32', a0: 'i32', a1: 'i32', b0: 'i32', b1: 'i32',
    a: 'f64', m: 'f64', tx: 'v128', tyv: 'v128', p: 'v128', top: 'v128', bot: 'v128', v01: 'v128', v23: 'v128', c: 'v128', k255: 'v128', pk: 'v128',
  },
  (() => {
    const lerp = (off, out) => [
      set('p', F64X2.promoteLow(V.load64z(g('a0'), off))),
      set('top', F64X2.add(g('p'), F64X2.mul(F64X2.sub(F64X2.promoteLow(V.load64z(g('a1'), off)), g('p')), g('tx')))),
      set('p', F64X2.promoteLow(V.load64z(g('b0'), off))),
      set('bot', F64X2.add(g('p'), F64X2.mul(F64X2.sub(F64X2.promoteLow(V.load64z(g('b1'), off)), g('p')), g('tx')))),
      // float32 rounding of both lanes (fround), kept as f32 lanes 0–1
      set(out, F32X4.demoteZero(F64X2.add(g('top'), F64X2.mul(F64X2.sub(g('bot'), g('top')), g('tyv'))))),
    ];
    return [
      set('k255', I32X4.splat(I32.c(255))),
      set('tyv', F64X2.splat(g('ty'))),
      set('pb', g('b')),
      set('e', I32.add(g('b'), I32.mul(g('w'), I32.c(4)))),
      whileDo(
        I32.lt_u(g('pb'), g('e')),
        set('o0', I32.load(g('xi0'))),
        set('o1', I32.load(g('xi1'))),
        set('a0', I32.add(g('r0'), g('o0'))),
        set('a1', I32.add(g('r0'), g('o1'))),
        set('b0', I32.add(g('r1'), g('o0'))),
        set('b1', I32.add(g('r1'), g('o1'))),
        set('tx', F64X2.splat(F64.promote(F32.load(g('xt'))))),
        lerp(8, 'v23'),
        set('a', F64.promote(F32X4.extract(g('v23'), 1))),
        when(F64.lt(g('a'), F64.c(0.5)), I32.store(g('pb'), I32.c(0)), [
          lerp(0, 'v01'),
          // (v0, v1, v2, a) as float32 lanes
          set('c', V.shuffle(g('v01'), g('v23'), lanes32(0, 1, 4, 5))),
          when(
            F64.ge(g('a'), F64.c(254.5)),
            V.store32lane0(g('pb'), V.or(pack4(u8f32x4(g('c'))), ALPHA_255)),
            [
              set('m', F64.div(F64.c(255), g('a'))),
              V.store32lane0(
                g('pb'),
                pack4(
                  clampI(
                    V.shuffle(
                      I32X4.truncSatF64SZero(F64X2.nearest(F64X2.mul(F64X2.promoteLow(g('c')), F64X2.splat(g('m'))))),
                      I32X4.truncSatF64SZero(F64X2.nearest(F64X2.mul(F64X2.promoteLow(g('v23')), F64X2.replaceLane(F64X2.splat(g('m')), 1, F64.c(1))))),
                      lanes32(0, 1, 4, 5),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ]),
        inc('pb', 4),
        inc('xi0', 4),
        inc('xi1', 4),
        inc('xt', 4),
      ),
    ];
  })(),
);

/* ---------------- core/blur.ts boxBlurImageData passes ---------------- */

// boxBlurH: rows of RGBA bytes src → dst. The JS running sums are whole numbers (exact in float64),
// so they are kept in i32 registers; the output is u8(sum · iarr) as in the JS.
func(
  'bb_h',
  { src: 'i32', dst: 'i32', w: 'i32', h: 'i32', r: 'i32', iarr: 'f64' },
  { y: 'i32', x: 'i32', j: 'i32', row: 'i32', pd: 'i32', p: 'i32', q: 'i32', rs: 'i32', v0: 'i32', v1: 'i32', v2: 'i32', v3: 'i32' },
  [
    set('rs', I32.mul(g('w'), I32.c(4))),
    set('row', g('src')),
    set('pd', g('dst')),
    whileDo(
      I32.lt_s(g('y'), g('h')),
      [0, 1, 2, 3].map((c) => set('v' + c, I32.mul(g('r'), I32.load8u(g('row'), c)))),
      set('j', I32.c(0)),
      whileDo(
        I32.lt_s(g('j'), g('r')),
        set('p', I32.add(g('row'), I32.mul(i32min(g('j'), I32.sub(g('w'), I32.c(1))), I32.c(4)))),
        [0, 1, 2, 3].map((c) => set('v' + c, I32.add(g('v' + c), I32.load8u(g('p'), c)))),
        inc('j'),
      ),
      set('x', I32.c(0)),
      whileDo(
        I32.lt_s(g('x'), g('w')),
        set('j', I32.add(g('x'), g('r'))),
        set('p', I32.add(g('row'), I32.mul(i32min(g('j'), I32.sub(g('w'), I32.c(1))), I32.c(4)))),
        set('j', I32.sub(g('x'), g('r'))),
        set('q', I32.add(g('row'), I32.mul(i32max(g('j'), I32.c(0)), I32.c(4)))),
        [0, 1, 2, 3].map((c) => [
          set('v' + c, I32.add(g('v' + c), I32.load8u(g('p'), c))),
          I32.store8(g('pd'), u8(F64.mul(F64.fromI32(g('v' + c)), g('iarr'))), c),
          set('v' + c, I32.sub(g('v' + c), I32.load8u(g('q'), c))),
        ]),
        inc('x'),
        inc('pd', 4),
      ),
      inc('y'),
      inc('row', g('rs')),
    ),
  ],
);

// boxBlurV, walking rows: acc (i32 × 4w) holds every column's running sum
func(
  'bb_v',
  { src: 'i32', dst: 'i32', w: 'i32', h: 'i32', r: 'i32', iarr: 'f64', acc: 'i32' },
  { y: 'i32', j: 'i32', q: 'i32', rs: 'i32', pa: 'i32', ps: 'i32', pd: 'i32', pc: 'i32', v: 'i32' },
  [
    set('rs', I32.mul(g('w'), I32.c(4))),
    set('q', I32.c(0)),
    whileDo(I32.lt_s(g('q'), g('rs')), I32.store(I32.add(g('acc'), I32.mul(g('q'), I32.c(4))), I32.mul(g('r'), I32.load8u(I32.add(g('src'), g('q'))))), inc('q')),
    set('j', I32.c(0)),
    whileDo(
      I32.lt_s(g('j'), g('r')),
      set('pa', I32.add(g('src'), I32.mul(i32min(g('j'), I32.sub(g('h'), I32.c(1))), g('rs')))),
      set('q', I32.c(0)),
      set('pc', g('acc')),
      whileDo(I32.lt_s(g('q'), g('rs')), I32.store(g('pc'), I32.add(I32.load(g('pc')), I32.load8u(I32.add(g('pa'), g('q'))))), inc('q'), inc('pc', 4)),
      inc('j'),
    ),
    set('y', I32.c(0)),
    set('pd', g('dst')),
    whileDo(
      I32.lt_s(g('y'), g('h')),
      set('j', I32.add(g('y'), g('r'))),
      set('pa', I32.add(g('src'), I32.mul(i32min(g('j'), I32.sub(g('h'), I32.c(1))), g('rs')))),
      set('j', I32.sub(g('y'), g('r'))),
      set('ps', I32.add(g('src'), I32.mul(i32max(g('j'), I32.c(0)), g('rs')))),
      set('q', I32.c(0)),
      set('pc', g('acc')),
      whileDo(
        I32.lt_s(g('q'), g('rs')),
        set('v', I32.add(I32.load(g('pc')), I32.load8u(I32.add(g('pa'), g('q'))))),
        I32.store8(I32.add(g('pd'), g('q')), u8(F64.mul(F64.fromI32(g('v')), g('iarr')))),
        I32.store(g('pc'), I32.sub(g('v'), I32.load8u(I32.add(g('ps'), g('q'))))),
        inc('q'),
        inc('pc', 4),
      ),
      inc('y'),
      inc('pd', g('rs')),
    ),
  ],
);

/* ---------------- core/blur.ts blurChannel passes ---------------- */

const fat = (base, i) => F64.promote(F32.load(I32.add(base, I32.mul(i, I32.c(4))))); // f64(float32 base[i])

// rows: src → dst (float32 planes), val += add; out = val·iarr; val −= rem
func(
  'bc_h',
  { src: 'i32', dst: 'i32', w: 'i32', h: 'i32', r: 'i32', iarr: 'f64' },
  { y: 'i32', x: 'i32', j: 'i32', row: 'i32', pd: 'i32', rs: 'i32', wm: 'i32', val: 'f64' },
  [
    set('rs', I32.mul(g('w'), I32.c(4))),
    set('wm', I32.sub(g('w'), I32.c(1))),
    set('row', g('src')),
    set('pd', g('dst')),
    whileDo(
      I32.lt_s(g('y'), g('h')),
      set('val', F64.mul(F64.fromI32(g('r')), F64.promote(F32.load(g('row'))))),
      set('j', I32.c(0)),
      whileDo(I32.lt_s(g('j'), g('r')), set('val', F64.add(g('val'), fat(g('row'), i32min(g('j'), g('wm'))))), inc('j')),
      set('x', I32.c(0)),
      whileDo(
        I32.lt_s(g('x'), g('w')),
        set('j', I32.add(g('x'), g('r'))),
        set('val', F64.add(g('val'), fat(g('row'), i32min(g('j'), g('wm'))))),
        F32.store(g('pd'), F32.demote(F64.mul(g('val'), g('iarr')))),
        set('j', I32.sub(g('x'), g('r'))),
        set('val', F64.sub(g('val'), fat(g('row'), i32max(g('j'), I32.c(0))))),
        inc('x'),
        inc('pd', 4),
      ),
      inc('y'),
      inc('row', g('rs')),
    ),
  ],
);

// columns, walking rows: src → dst; acc (f64 × w) holds every column's running value
func(
  'bc_v',
  { src: 'i32', dst: 'i32', w: 'i32', h: 'i32', r: 'i32', iarr: 'f64', acc: 'i32' },
  { y: 'i32', j: 'i32', rs: 'i32', pa: 'i32', ps: 'i32', pd: 'i32', pc: 'i32', e: 'i32', rv: 'v128', iv: 'v128', s: 'v128', t: 'f64', rf: 'f64' },
  (() => {
    const rowsLoop = (pair, one) => [
      set('pc', g('acc')),
      set('e', I32.add(g('acc'), I32.mul(I32.and(g('w'), I32.c(-2)), I32.c(8)))),
      whileDo(I32.lt_u(g('pc'), g('e')), pair(), inc('pc', 16), inc('pa', 8), inc('ps', 8), inc('pd', 8)),
      when(I32.and(g('w'), I32.c(1)), one()),
    ];
    return [
      set('rs', I32.mul(g('w'), I32.c(4))),
      set('rf', F64.fromI32(g('r'))),
      set('rv', F64X2.splat(g('rf'))),
      set('iv', F64X2.splat(g('iarr'))),
      // acc[x] = r · src[x]
      set('pa', g('src')),
      rowsLoop(
        () => V.store(g('pc'), F64X2.mul(g('rv'), F64X2.promoteLow(V.load64z(g('pa'))))),
        () => F64.store(g('pc'), F64.mul(g('rf'), F64.promote(F32.load(g('pa'))))),
      ),
      // acc[x] += src[min(j, h − 1)·w + x] for j < r
      set('j', I32.c(0)),
      whileDo(
        I32.lt_s(g('j'), g('r')),
        set('pa', I32.add(g('src'), I32.mul(i32min(g('j'), I32.sub(g('h'), I32.c(1))), g('rs')))),
        rowsLoop(
          () => V.store(g('pc'), F64X2.add(V.load(g('pc')), F64X2.promoteLow(V.load64z(g('pa'))))),
          () => F64.store(g('pc'), F64.add(F64.load(g('pc')), F64.promote(F32.load(g('pa'))))),
        ),
        inc('j'),
      ),
      set('y', I32.c(0)),
      whileDo(
        I32.lt_s(g('y'), g('h')),
        set('j', I32.add(g('y'), g('r'))),
        set('pa', I32.add(g('src'), I32.mul(i32min(g('j'), I32.sub(g('h'), I32.c(1))), g('rs')))),
        set('j', I32.sub(g('y'), g('r'))),
        set('ps', I32.add(g('src'), I32.mul(i32max(g('j'), I32.c(0)), g('rs')))),
        set('pd', I32.add(g('dst'), I32.mul(g('y'), g('rs')))),
        rowsLoop(
          () => [
            set('s', F64X2.add(V.load(g('pc')), F64X2.promoteLow(V.load64z(g('pa'))))),
            V.store64lane0(g('pd'), F32X4.demoteZero(F64X2.mul(g('s'), g('iv')))),
            V.store(g('pc'), F64X2.sub(g('s'), F64X2.promoteLow(V.load64z(g('ps'))))),
          ],
          () => [
            set('t', F64.add(F64.load(g('pc')), F64.promote(F32.load(g('pa'))))),
            F32.store(g('pd'), F32.demote(F64.mul(g('t'), g('iarr')))),
            F64.store(g('pc'), F64.sub(g('t'), F64.promote(F32.load(g('ps'))))),
          ],
        ),
        inc('y'),
      ),
    ];
  })(),
);

/* ---------------- median.ts separable median networks (u8x16) ---------------- */

/** Compare-exchange networks of median.ts (each pair (i, j): p_i = min, p_j = max); result index. */
const MED = {
  3: { net: [[0, 1], [1, 2], [0, 1]], out: 1 },
  5: { net: [[0, 1], [3, 4], [0, 3], [1, 4], [1, 2], [2, 3], [1, 2]], out: 2 },
  7: {
    net: [[0, 5], [0, 3], [1, 6], [2, 4], [0, 1], [3, 5], [2, 6], [2, 3], [3, 6], [4, 5], [1, 4], [1, 3], [3, 4]],
    out: 3,
  },
};

function network(n, load) {
  const { net, out } = MED[n];
  const code = [];
  for (let i = 0; i < n; i++) code.push(set('p' + i, load(i)));
  for (const [i, j] of net) code.push(set('t', U8X16.min(g('p' + i), g('p' + j))), set('p' + j, U8X16.max(g('p' + i), g('p' + j))), set('p' + i, g('t')));
  return { code, out: 'p' + out };
}

/**
 * Interior of one row of the horizontal median (median.ts rowsMedN): dst[q] = med(src[q − r .. q + r])
 * for q in [from, to) (byte addresses; the caller keeps q − r ≥ row start and q + r < row end),
 * 16 at a time, then the remainder one by one (each lane is the scalar network).
 */
function medRowsFn(n) {
  const r = (n - 1) >> 1;
  const locals = { q: 'i32', d: 'i32', e: 'i32', t: 'v128' };
  for (let i = 0; i < n; i++) locals['p' + i] = 'v128';
  const vec16 = network(n, (i) => V.load(I32.add(g('q'), I32.c(i - r))));
  const one = network(n, (i) => [I32.load8u(I32.add(g('q'), I32.c(i - r))), ...simd(0x0f)]); // i8x16.splat
  func(`med_rows${n}`, { src: 'i32', dst: 'i32', from: 'i32', to: 'i32' }, locals, [
    set('q', I32.add(g('src'), g('from'))),
    set('d', I32.add(g('dst'), g('from'))),
    set('e', I32.add(g('src'), I32.sub(g('to'), I32.c(15)))),
    whileDo(I32.lt_u(g('q'), g('e')), vec16.code, V.store(g('d'), g(vec16.out)), inc('q', 16), inc('d', 16)),
    set('e', I32.add(g('src'), g('to'))),
    whileDo(I32.lt_u(g('q'), g('e')), one.code, I32.store8(g('d'), [g(one.out), ...simd(0x16), 0]), inc('q'), inc('d')), // i8x16.extract_lane_u 0
  ]);
}

/** One row of the vertical median (median.ts colsMedN): n source rows (byte addresses r0..rn−1) → dst, w bytes. */
function medColsFn(n) {
  const locals = { x: 'i32', e: 'i32', t: 'v128' };
  const params = { dst: 'i32', w: 'i32' };
  for (let i = 0; i < n; i++) params['r' + i] = 'i32';
  for (let i = 0; i < n; i++) locals['p' + i] = 'v128';
  const vec16 = network(n, (i) => V.load(I32.add(g('r' + i), g('x'))));
  const one = network(n, (i) => [I32.load8u(I32.add(g('r' + i), g('x'))), ...simd(0x0f)]);
  func(`med_cols${n}`, params, locals, [
    set('e', I32.sub(g('w'), I32.c(15))),
    whileDo(I32.lt_s(g('x'), g('e')), vec16.code, V.store(I32.add(g('dst'), g('x')), g(vec16.out)), inc('x', 16)),
    whileDo(I32.lt_s(g('x'), g('w')), one.code, I32.store8(I32.add(g('dst'), g('x')), [g(one.out), ...simd(0x16), 0]), inc('x')),
  ]);
}

for (const n of [3, 5, 7]) {
  medRowsFn(n);
  medColsFn(n);
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

/** Initial memory (64 KiB pages); the runtime grows it on demand. */
const MIN_PAGES = 16;

export function buildModule() {
  const types = [];
  const typeIndex = new Map();
  const typeOf = (f) => {
    const key = f.params.map(([, t]) => t).join(',');
    if (!typeIndex.has(key)) {
      typeIndex.set(key, types.length);
      types.push([0x60, ...vec(f.params.map(([, t]) => [TYPE[t]])), ...vec([])]);
    }
    return typeIndex.get(key);
  };
  const fidx = funcs.map(typeOf);
  const bodies = funcs.map((f) => {
    const locals = new Map();
    [...f.params, ...f.locals].forEach(([n], i) => {
      if (locals.has(n)) throw new Error(`${f.name}: duplicate local ${n}`);
      locals.set(n, i);
    });
    const code = [];
    emit(f.body, { fn: f.name, locals, labels: [] }, code);
    const body = [...vec(f.locals.map(([, t]) => [1, TYPE[t]])), ...code, 0x0b];
    return [...uleb(body.length), ...body];
  });
  const exports = [...funcs.map((f, i) => [...name(f.name), 0x00, ...uleb(i)]), [...name('memory'), 0x02, 0]];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(3, vec(fidx.map((i) => uleb(i)))),
    ...section(5, vec([[0x00, ...uleb(MIN_PAGES)]])),
    ...section(7, vec(exports)),
    ...section(10, vec(bodies)),
    // "name" custom section (function names): profilers show hrow4 instead of wasm-function[3]
    ...section(0, [...name('name'), ...section(1, vec(funcs.map((f, i) => [...uleb(i), ...name(f.name)])))]),
  ];
  return new Uint8Array(bytes);
}

export const EXPORTS = funcs.map((f) => ({ name: f.name, params: f.params.map(([n, t]) => `${n}: ${t}`) }));

export function generatedSource(bytes = buildModule()) {
  const b64 = Buffer.from(bytes).toString('base64');
  const lines = b64.match(/.{1,100}/g) ?? [];
  return `/* eslint-disable */
// GENERATED by scripts/gen-wasm.mjs — do not edit. Regenerate with \`node scripts/gen-wasm.mjs\`.
// ${bytes.length} bytes; exports: memory, ${funcs.map((f) => f.name).join(', ')}.
export const BLUR_WASM_BASE64 =
${lines.map((l) => `  '${l}'`).join(' +\n')};
`;
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'wasm', 'blurWasm.generated.ts');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bytes = buildModule();
  new WebAssembly.Module(bytes); // validates (throws CompileError with the offending function)
  const src = generatedSource(bytes);
  if (process.argv.includes('--check')) {
    let cur = '';
    try {
      cur = readFileSync(OUT, 'utf8');
    } catch {
      /* missing */
    }
    if (cur !== src) {
      console.error('src/core/wasm/blurWasm.generated.ts is out of date: run node scripts/gen-wasm.mjs');
      process.exit(1);
    }
    console.log(`up to date (${bytes.length} bytes)`);
  } else {
    writeFileSync(OUT, src);
    console.log(`wrote ${OUT} (${bytes.length} bytes, ${funcs.length} functions)`);
  }
}
