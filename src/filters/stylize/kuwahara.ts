/**
 * Smooth Kuwahara filter (Papari-style variance weighting of the 4 quadrants) computed with
 * sliding box means → O(1) per pixel regardless of radius. Alpha is preserved; colors are
 * averaged premultiplied so transparent neighbours never darken edges.
 */
import type { Img } from './util';

/** Box means over (r+1)² windows anchored at (x', y') ∈ [-r, w-1]×[-r, h-1], edge-clamped. */
function anchoredMeans(src: Float32Array, w: number, h: number, r: number, H: Float32Array, out: Float32Array) {
  const W = w + r;
  const inv = 1 / ((r + 1) * (r + 1));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = 0; k <= r; k++) {
      const xx = -r + k;
      sum += src[row + (xx < 0 ? 0 : xx >= w ? w - 1 : xx)];
    }
    const ho = y * W;
    for (let X = 0; X < W; X++) {
      H[ho + X] = sum;
      const xo = X - r; // x'
      const add = xo + r + 1,
        rem = xo;
      sum += src[row + (add < 0 ? 0 : add >= w ? w - 1 : add)] - src[row + (rem < 0 ? 0 : rem >= w ? w - 1 : rem)];
    }
  }
  const Hh = h + r;
  for (let X = 0; X < W; X++) {
    let sum = 0;
    for (let k = 0; k <= r; k++) {
      const yy = -r + k;
      sum += H[(yy < 0 ? 0 : yy >= h ? h - 1 : yy) * W + X];
    }
    for (let Y = 0; Y < Hh; Y++) {
      out[Y * W + X] = sum * inv;
      const yo = Y - r;
      const add = yo + r + 1,
        rem = yo;
      sum += H[(add < 0 ? 0 : add >= h ? h - 1 : add) * W + X] - H[(rem < 0 ? 0 : rem >= h ? h - 1 : rem) * W + X];
    }
  }
}

export function kuwahara<T extends Img>(img: T, radius: number): T {
  const r = Math.max(1, Math.round(radius));
  const { width: w, height: h, data } = img;
  const n = w * h;
  const W = w + r,
    Hh = h + r;
  const pr = new Float32Array(n),
    pg = new Float32Array(n),
    pb = new Float32Array(n),
    pa = new Float32Array(n),
    pl = new Float32Array(n),
    pl2 = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = data[j + 3] / 255;
    const m = a / 255;
    const R = data[j] * m,
      G = data[j + 1] * m,
      B = data[j + 2] * m;
    pr[i] = R;
    pg[i] = G;
    pb[i] = B;
    pa[i] = a;
    const l = R * 0.2126 + G * 0.7152 + B * 0.0722;
    pl[i] = l;
    pl2[i] = l * l;
  }
  const H = new Float32Array(W * h);
  const mk = (src: Float32Array) => {
    const o = new Float32Array(W * Hh);
    anchoredMeans(src, w, h, r, H, o);
    return o;
  };
  const mr = mk(pr),
    mg = mk(pg),
    mb = mk(pb),
    ma = mk(pa),
    ml = mk(pl),
    ml2 = mk(pl2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      if (data[j + 3] === 0) continue;
      const q0 = y * W + x,
        q1 = y * W + x + r,
        q2 = (y + r) * W + x,
        q3 = (y + r) * W + x + r;
      let sr = 0,
        sg = 0,
        sb = 0,
        sa = 0,
        sw = 0;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? q0 : k === 1 ? q1 : k === 2 ? q2 : q3;
        const m = ml[q];
        let v = ml2[q] - m * m;
        if (v < 0) v = 0;
        const v2 = v * v;
        const wt = 1 / (1e-14 + v2 * v2);
        sr += mr[q] * wt;
        sg += mg[q] * wt;
        sb += mb[q] * wt;
        sa += ma[q] * wt;
        sw += wt;
      }
      if (sa <= 1e-9 * sw) continue;
      const inv = 255 / sa;
      data[j] = sr * inv;
      data[j + 1] = sg * inv;
      data[j + 2] = sb * inv;
    }
  }
  return img;
}
