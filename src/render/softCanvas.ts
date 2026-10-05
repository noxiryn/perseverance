/**
 * TEST-ONLY software Canvas 2D for jsdom (which has no canvas implementation); the app never
 * imports this file. `installSoftCanvas()` makes `canvas.getContext('2d')` return a small subset of
 * CanvasRenderingContext2D and provides DOMMatrix / ImageData when missing, so compositor paths that
 * only draw images, fill solid rects and read/write pixels run in unit tests: raster / solid-fill /
 * adjustment layers, masks at 1:1 (no feather), clip stacks, groups, live region updates.
 *
 * Pixels are stored premultiplied with 8 bits per channel like Chromium's canvases (so rounding is
 * close to the browser's, not bit-identical); compositing and blend modes follow the W3C
 * Compositing and Blending spec, including the "unbounded" operations (destination-in, source-in,
 * source-out, destination-atop, copy) that affect the whole clip area. Anything unsupported
 * (non-rect paths, gradients, CSS filters, rotated / skewed draws, text) throws, so a test can never
 * pass on pixels this canvas did not really compute.
 */

type Mat = [number, number, number, number, number, number];

interface Surface {
  w: number;
  h: number;
  /** Premultiplied RGBA, 8 bits per channel. */
  px: Uint8ClampedArray;
}

interface State {
  alpha: number;
  op: string;
  fill: [number, number, number, number];
  fillStyle: string;
  t: Mat;
  /** Device-space clip rect (x0, y0, x1, y1), null = none. */
  clip: [number, number, number, number] | null;
  filter: string;
}

/* ---------------- DOMMatrix / ImageData (only when the environment lacks them) ---------------- */

interface M2 {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export class SoftMatrix implements M2 {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  constructor(init?: ArrayLike<number> | string) {
    if (init && typeof init !== 'string' && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = Array.from(init).slice(0, 6) as Mat;
  }
  get is2D() {
    return true;
  }
  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }
  clone(): SoftMatrix {
    return new SoftMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
  }
  multiplySelf(o: M2): this {
    const { a, b, c, d, e, f } = this;
    this.a = a * o.a + c * o.b;
    this.b = b * o.a + d * o.b;
    this.c = a * o.c + c * o.d;
    this.d = b * o.c + d * o.d;
    this.e = a * o.e + c * o.f + e;
    this.f = b * o.e + d * o.f + f;
    return this;
  }
  preMultiplySelf(o: M2): this {
    const r = new SoftMatrix([o.a, o.b, o.c, o.d, o.e, o.f]).multiplySelf(this);
    [this.a, this.b, this.c, this.d, this.e, this.f] = [r.a, r.b, r.c, r.d, r.e, r.f];
    return this;
  }
  translateSelf(x = 0, y = 0): this {
    return this.multiplySelf({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
  }
  scaleSelf(sx = 1, sy = sx): this {
    return this.multiplySelf({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
  }
  rotateSelf(deg = 0): this {
    const r = (deg * Math.PI) / 180;
    const cs = Math.cos(r),
      sn = Math.sin(r);
    return this.multiplySelf({ a: cs, b: sn, c: -sn, d: cs, e: 0, f: 0 });
  }
  skewXSelf(deg = 0): this {
    return this.multiplySelf({ a: 1, b: 0, c: Math.tan((deg * Math.PI) / 180), d: 1, e: 0, f: 0 });
  }
  invertSelf(): this {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = [NaN, NaN, NaN, NaN, NaN, NaN];
      return this;
    }
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }
  multiply(o: M2) {
    return this.clone().multiplySelf(o);
  }
  translate(x = 0, y = 0) {
    return this.clone().translateSelf(x, y);
  }
  scale(sx = 1, sy = sx) {
    return this.clone().scaleSelf(sx, sy);
  }
  rotate(deg = 0) {
    return this.clone().rotateSelf(deg);
  }
  inverse() {
    return this.clone().invertSelf();
  }
  transformPoint(p: { x?: number; y?: number }) {
    const x = p.x ?? 0,
      y = p.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
}

export class SoftImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace = 'srgb';
  constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
    if (typeof a === 'number') {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a;
      this.width = b;
      this.height = c ?? a.length / 4 / b;
    }
  }
}

/* ---------------- colors ---------------- */

function parseColor(s: string): [number, number, number, number] {
  const v = s.trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  if (v === 'white') return [255, 255, 255, 1];
  if (v === 'black') return [0, 0, 0, 1];
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  throw new Error(`softCanvas: unsupported color "${s}"`);
}

/* ---------------- blending (W3C Compositing and Blending Level 1) ---------------- */

type Sep = (b: number, s: number) => number;
const softD = (b: number) => (b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b));
const hardLight: Sep = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));
const SEPARABLE: Record<string, Sep> = {
  'source-over': (_b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'hard-light': hardLight,
  'soft-light': (b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (softD(b) - b)),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};

type RGB = [number, number, number];
const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c: RGB): RGB {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let o: RGB = [...c];
  if (n < 0) o = o.map((v) => l + ((v - l) * l) / (l - n)) as RGB;
  if (x > 1) o = o.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as RGB;
  return o;
}
const setLum = (c: RGB, l: number): RGB => {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
};
const sat = (c: RGB) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: RGB, s: number): RGB {
  const idx = [0, 1, 2].sort((i, j) => c[i] - c[j]);
  const o: RGB = [0, 0, 0];
  const [mn, md, mx] = idx;
  if (c[mx] > c[mn]) {
    o[md] = ((c[md] - c[mn]) * s) / (c[mx] - c[mn]);
    o[mx] = s;
  }
  o[mn] = 0;
  return o;
}
const NON_SEPARABLE: Record<string, (b: RGB, s: RGB) => RGB> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};
const UNBOUNDED = new Set(['destination-in', 'source-in', 'source-out', 'destination-atop', 'copy']);

/** Composite one premultiplied source pixel (0..1 floats) into dst[i..i+3] (premultiplied bytes). */
function compositePixel(op: string, dst: Uint8ClampedArray, i: number, sr: number, sg: number, sb: number, sa: number) {
  const dr = dst[i] / 255,
    dg = dst[i + 1] / 255,
    db = dst[i + 2] / 255,
    da = dst[i + 3] / 255;
  let r: number, g: number, b: number, a: number;
  const sep = SEPARABLE[op];
  const nonSep = NON_SEPARABLE[op];
  if (sep || nonSep) {
    a = sa + da - sa * da;
    let br = sr,
      bg = sg,
      bb = sb;
    if (sa > 0 && da > 0) {
      const S: RGB = [sr / sa, sg / sa, sb / sa];
      const B: RGB = [dr / da, dg / da, db / da];
      const m = nonSep ? nonSep(B, S) : [sep!(B[0], S[0]), sep!(B[1], S[1]), sep!(B[2], S[2])];
      br = (1 - da) * sr + da * sa * m[0];
      bg = (1 - da) * sg + da * sa * m[1];
      bb = (1 - da) * sb + da * sa * m[2];
    }
    r = br + (1 - sa) * dr;
    g = bg + (1 - sa) * dg;
    b = bb + (1 - sa) * db;
  } else {
    // Porter-Duff: Co = Fa·Cs + Fb·Cd (premultiplied).
    let Fa: number, Fb: number;
    switch (op) {
      case 'destination-over':
        Fa = 1 - da;
        Fb = 1;
        break;
      case 'source-in':
        Fa = da;
        Fb = 0;
        break;
      case 'destination-in':
        Fa = 0;
        Fb = sa;
        break;
      case 'source-out':
        Fa = 1 - da;
        Fb = 0;
        break;
      case 'destination-out':
        Fa = 0;
        Fb = 1 - sa;
        break;
      case 'source-atop':
        Fa = da;
        Fb = 1 - sa;
        break;
      case 'destination-atop':
        Fa = 1 - da;
        Fb = sa;
        break;
      case 'xor':
        Fa = 1 - da;
        Fb = 1 - sa;
        break;
      case 'copy':
        Fa = 1;
        Fb = 0;
        break;
      case 'lighter':
        Fa = 1;
        Fb = 1;
        break;
      default:
        throw new Error(`softCanvas: unsupported globalCompositeOperation "${op}"`);
    }
    r = Fa * sr + Fb * dr;
    g = Fa * sg + Fb * dg;
    b = Fa * sb + Fb * db;
    a = Fa * sa + Fb * da;
  }
  dst[i] = Math.round(Math.min(1, r) * 255);
  dst[i + 1] = Math.round(Math.min(1, g) * 255);
  dst[i + 2] = Math.round(Math.min(1, b) * 255);
  dst[i + 3] = Math.round(Math.min(1, a) * 255);
}

/* ---------------- context ---------------- */

const surfaces = new WeakMap<HTMLCanvasElement, Surface>();
const contexts = new WeakMap<HTMLCanvasElement, SoftContext>();

function surfaceOf(c: HTMLCanvasElement): Surface {
  let s = surfaces.get(c);
  const w = Math.max(0, c.width | 0);
  const h = Math.max(0, c.height | 0);
  if (!s || s.w !== w || s.h !== h) {
    s = { w, h, px: new Uint8ClampedArray(w * h * 4) };
    surfaces.set(c, s);
  }
  return s;
}

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

class SoftContext {
  private st: State = { alpha: 1, op: 'source-over', fill: [0, 0, 0, 1], fillStyle: '#000000', t: [...IDENTITY], clip: null, filter: 'none' };
  private stack: State[] = [];
  private path: [number, number, number, number][] = [];
  // Accepted and ignored (no effect on what this canvas supports).
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';
  shadowColor = 'rgba(0, 0, 0, 0)';
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  strokeStyle = '#000000';
  lineWidth = 1;
  font = '10px sans-serif';
  constructor(readonly canvas: HTMLCanvasElement) {}

  get globalAlpha() {
    return this.st.alpha;
  }
  set globalAlpha(v: number) {
    if (Number.isFinite(v) && v >= 0 && v <= 1) this.st.alpha = v;
  }
  get globalCompositeOperation() {
    return this.st.op;
  }
  set globalCompositeOperation(v: string) {
    this.st.op = v;
  }
  get fillStyle(): string {
    return this.st.fillStyle;
  }
  set fillStyle(v: string) {
    if (typeof v !== 'string') throw new Error('softCanvas: only solid color fill styles are supported');
    this.st.fill = parseColor(v);
    this.st.fillStyle = v;
  }
  get filter() {
    return this.st.filter;
  }
  set filter(v: string) {
    this.st.filter = v;
  }

  save() {
    this.stack.push({ ...this.st, t: [...this.st.t] as Mat, clip: this.st.clip && ([...this.st.clip] as State['clip']) });
  }
  restore() {
    const s = this.stack.pop();
    if (s) this.st = s;
  }
  setTransform(a?: number | M2, b?: number, c?: number, d?: number, e?: number, f?: number) {
    if (a === undefined) this.st.t = [...IDENTITY];
    else if (typeof a === 'object') this.st.t = [a.a, a.b, a.c, a.d, a.e, a.f];
    else this.st.t = [a, b!, c!, d!, e!, f!];
  }
  resetTransform() {
    this.st.t = [...IDENTITY];
  }
  getTransform() {
    return new SoftMatrix(this.st.t);
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    const m = new SoftMatrix(this.st.t).multiplySelf({ a, b, c, d, e, f });
    this.st.t = [m.a, m.b, m.c, m.d, m.e, m.f];
  }
  translate(x: number, y: number) {
    this.transform(1, 0, 0, 1, x, y);
  }
  scale(x: number, y: number) {
    this.transform(x, 0, 0, y, 0, 0);
  }

  /** Device rect of a user-space rect (axis-aligned transforms only). */
  private deviceRect(x: number, y: number, w: number, h: number): [number, number, number, number] {
    const [a, b, c, d, e, f] = this.st.t;
    if (b !== 0 || c !== 0) throw new Error('softCanvas: rotated / skewed drawing is not supported');
    const x0 = a * x + e,
      x1 = a * (x + w) + e,
      y0 = d * y + f,
      y1 = d * (y + h) + f;
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }

  /** Pixels whose centers lie in a device rect, limited to the clip and the canvas. */
  private pixelSpan(r: [number, number, number, number], s: Surface): [number, number, number, number] {
    let x0 = Math.ceil(r[0] - 0.5),
      y0 = Math.ceil(r[1] - 0.5),
      x1 = Math.ceil(r[2] - 0.5),
      y1 = Math.ceil(r[3] - 0.5);
    const cl = this.st.clip;
    if (cl) {
      x0 = Math.max(x0, Math.ceil(cl[0] - 0.5));
      y0 = Math.max(y0, Math.ceil(cl[1] - 0.5));
      x1 = Math.min(x1, Math.ceil(cl[2] - 0.5));
      y1 = Math.min(y1, Math.ceil(cl[3] - 0.5));
    }
    return [Math.max(0, x0), Math.max(0, y0), Math.min(s.w, x1), Math.min(s.h, y1)];
  }

  private everywhere(): [number, number, number, number] {
    return [-1e9, -1e9, 1e9, 1e9];
  }

  beginPath() {
    this.path = [];
  }
  rect(x: number, y: number, w: number, h: number) {
    this.path.push(this.deviceRect(x, y, w, h));
  }
  clip() {
    if (this.path.length !== 1) throw new Error('softCanvas: only single-rect clip paths are supported');
    const r = this.path[0];
    const c = this.st.clip;
    this.st.clip = c ? [Math.max(c[0], r[0]), Math.max(c[1], r[1]), Math.min(c[2], r[2]), Math.min(c[3], r[3])] : [...r];
  }

  clearRect(x: number, y: number, w: number, h: number) {
    const s = surfaceOf(this.canvas);
    const [x0, y0, x1, y1] = this.pixelSpan(this.deviceRect(x, y, w, h), s);
    for (let py = y0; py < y1; py++) s.px.fill(0, (py * s.w + x0) * 4, (py * s.w + x1) * 4);
  }

  fillRect(x: number, y: number, w: number, h: number) {
    this.checkFilter();
    const s = surfaceOf(this.canvas);
    const op = this.st.op;
    const [cr, cg, cb, ca] = this.st.fill;
    const a = ca * this.st.alpha;
    const inside = this.deviceRect(x, y, w, h);
    const span = this.pixelSpan(UNBOUNDED.has(op) ? this.everywhere() : inside, s);
    const [ix0, iy0, ix1, iy1] = this.pixelSpan(inside, s);
    for (let py = span[1]; py < span[3]; py++)
      for (let px = span[0]; px < span[2]; px++) {
        const hit = px >= ix0 && px < ix1 && py >= iy0 && py < iy1;
        const sa = hit ? a : 0;
        compositePixel(op, s.px, (py * s.w + px) * 4, (cr / 255) * sa, (cg / 255) * sa, (cb / 255) * sa, sa);
      }
  }

  drawImage(img: HTMLCanvasElement, ...n: number[]) {
    this.checkFilter();
    if (!(img instanceof HTMLCanvasElement)) throw new Error('softCanvas: only canvases can be drawn');
    const src = surfaceOf(img);
    let sx = 0,
      sy = 0,
      sw = src.w,
      sh = src.h,
      dx: number,
      dy: number,
      dw = sw,
      dh = sh;
    if (n.length === 2) [dx, dy] = n;
    else if (n.length === 4) [dx, dy, dw, dh] = n;
    else if (n.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = n;
    else throw new Error('softCanvas: bad drawImage arguments');
    const s = surfaceOf(this.canvas);
    const op = this.st.op;
    const ga = this.st.alpha;
    const dr = this.deviceRect(dx, dy, dw, dh);
    if (!(sw > 0 && sh > 0) || !(dr[2] > dr[0] && dr[3] > dr[1])) {
      if (!UNBOUNDED.has(op)) return;
    }
    const kx = sw / Math.max(1e-9, dr[2] - dr[0]);
    const ky = sh / Math.max(1e-9, dr[3] - dr[1]);
    const span = this.pixelSpan(UNBOUNDED.has(op) ? this.everywhere() : dr, s);
    const [ix0, iy0, ix1, iy1] = this.pixelSpan(dr, s);
    const sp = src.px;
    for (let py = span[1]; py < span[3]; py++)
      for (let px = span[0]; px < span[2]; px++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0;
        if (px >= ix0 && px < ix1 && py >= iy0 && py < iy1) {
          // Nearest source pixel (exact for whole-pixel 1:1 draws, the only kind tests rely on).
          const qx = Math.floor(sx + (px + 0.5 - dr[0]) * kx);
          const qy = Math.floor(sy + (py + 0.5 - dr[1]) * ky);
          if (qx >= 0 && qy >= 0 && qx < src.w && qy < src.h) {
            const j = (qy * src.w + qx) * 4;
            r = (sp[j] / 255) * ga;
            g = (sp[j + 1] / 255) * ga;
            b = (sp[j + 2] / 255) * ga;
            a = (sp[j + 3] / 255) * ga;
          }
        }
        compositePixel(op, s.px, (py * s.w + px) * 4, r, g, b, a);
      }
  }

  getImageData(x: number, y: number, w: number, h: number): ImageData {
    const s = surfaceOf(this.canvas);
    const out = new SoftImageData(w, h);
    const d = out.data;
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        const X = x + px,
          Y = y + py;
        if (X < 0 || Y < 0 || X >= s.w || Y >= s.h) continue;
        const j = (Y * s.w + X) * 4;
        const o = (py * w + px) * 4;
        const a = s.px[j + 3];
        if (!a) continue;
        d[o] = Math.round((s.px[j] * 255) / a);
        d[o + 1] = Math.round((s.px[j + 1] * 255) / a);
        d[o + 2] = Math.round((s.px[j + 2] * 255) / a);
        d[o + 3] = a;
      }
    return out as unknown as ImageData;
  }

  putImageData(img: ImageData, x: number, y: number) {
    const s = surfaceOf(this.canvas);
    const d = img.data;
    for (let py = 0; py < img.height; py++)
      for (let px = 0; px < img.width; px++) {
        const X = x + px,
          Y = y + py;
        if (X < 0 || Y < 0 || X >= s.w || Y >= s.h) continue;
        const o = (py * img.width + px) * 4;
        const j = (Y * s.w + X) * 4;
        const a = d[o + 3];
        s.px[j] = Math.round((d[o] * a) / 255);
        s.px[j + 1] = Math.round((d[o + 1] * a) / 255);
        s.px[j + 2] = Math.round((d[o + 2] * a) / 255);
        s.px[j + 3] = a;
      }
  }

  createImageData(w: number, h: number): ImageData {
    return new SoftImageData(w, h) as unknown as ImageData;
  }

  private checkFilter() {
    if (this.st.filter && this.st.filter !== 'none') throw new Error(`softCanvas: CSS filters are not supported ("${this.st.filter}")`);
  }
}

/** Install the software canvas (jsdom). Returns the uninstaller. */
export function installSoftCanvas(): () => void {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (type: string, opts?: unknown) => unknown };
  const prev = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement, type: string) {
    if (type !== '2d') return null;
    let k = contexts.get(this);
    if (!k) contexts.set(this, (k = new SoftContext(this)));
    return k;
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const added: string[] = [];
  if (typeof g.DOMMatrix === 'undefined') {
    g.DOMMatrix = SoftMatrix;
    added.push('DOMMatrix');
  }
  if (typeof g.ImageData === 'undefined') {
    g.ImageData = SoftImageData;
    added.push('ImageData');
  }
  return () => {
    proto.getContext = prev;
    for (const k of added) delete g[k];
  };
}

/** Straight-alpha RGBA of one pixel of a canvas drawn with the software canvas. */
export function pixelAt(c: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
  const d = (c.getContext('2d') as unknown as SoftContext).getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}
