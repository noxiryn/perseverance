import { useEffect, useRef, useState } from 'react';
import type { CurvePoints, CurvesValue } from '../../core/types';
import { Tabs } from './basic';

/** Monotone cubic interpolation of curve points → 256-entry lookup table (0..255). */
export function curveLUT(points: CurvePoints): Uint8ClampedArray {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const lut = new Uint8ClampedArray(256);
  if (pts.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  if (pts.length === 1) {
    lut.fill(pts[0][1]);
    return lut;
  }
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / d[i],
        b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
  }
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) {
      lut[x] = ys[0];
      continue;
    }
    if (x >= xs[n - 1]) {
      lut[x] = ys[n - 1];
      continue;
    }
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k];
    const t = (x - xs[k]) / h;
    const t2 = t * t,
      t3 = t2 * t;
    lut[x] =
      (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
  }
  return lut;
}

export const IDENTITY_CURVES: CurvesValue = {
  rgb: [
    [0, 0],
    [255, 255],
  ],
  r: [
    [0, 0],
    [255, 255],
  ],
  g: [
    [0, 0],
    [255, 255],
  ],
  b: [
    [0, 0],
    [255, 255],
  ],
};

/** Inner padding (px) so the 0/255 endpoint handles are fully visible. */
const CURVE_PAD = 6;

const CH_COLORS = { rgb: '#e6e6e6', r: '#ff5a5a', g: '#5aff8c', b: '#5a9bff' } as const;

/** Interactive curves editor (click to add points, drag to move, drag out to delete). */
export function CurvesEditor({
  value,
  onChange,
  onCommit,
  size = 220,
  histogram,
}: {
  value: CurvesValue;
  onChange: (v: CurvesValue) => void;
  onCommit?: (v: CurvesValue) => void;
  size?: number;
  /** Optional 256-bin luminance histogram to draw behind the curve. */
  histogram?: number[];
}) {
  const [ch, setCh] = useState<keyof CurvesValue>('rgb');
  const ref = useRef<HTMLCanvasElement>(null);
  const pts = value[ch];

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, 0, size, size);
    const inner = size - CURVE_PAD * 2;
    const X = (v: number) => CURVE_PAD + (v / 255) * inner;
    const Y = (v: number) => CURVE_PAD + (1 - v / 255) * inner;
    if (histogram) {
      const max = Math.max(...histogram, 1);
      ctx.fillStyle = '#2c2c2c';
      for (let i = 0; i < 256; i++) {
        const h = (histogram[i] / max) * inner;
        ctx.fillRect(CURVE_PAD + (i / 256) * inner, CURVE_PAD + inner - h, inner / 256 + 0.5, h);
      }
    }
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.strokeRect(CURVE_PAD, CURVE_PAD, inner, inner);
    for (let i = 1; i < 4; i++) {
      const t = CURVE_PAD + (i * inner) / 4;
      ctx.beginPath();
      ctx.moveTo(t, CURVE_PAD);
      ctx.lineTo(t, CURVE_PAD + inner);
      ctx.moveTo(CURVE_PAD, t);
      ctx.lineTo(CURVE_PAD + inner, t);
      ctx.stroke();
    }
    ctx.strokeStyle = '#3a3a3a';
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    ctx.lineTo(X(255), Y(255));
    ctx.stroke();
    const lut = curveLUT(pts);
    ctx.strokeStyle = CH_COLORS[ch];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < 256; x++) {
      if (x === 0) ctx.moveTo(X(x), Y(lut[x]));
      else ctx.lineTo(X(x), Y(lut[x]));
    }
    ctx.stroke();
    for (const [x, y] of pts) {
      ctx.fillStyle = '#111';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.rect(X(x) - 3.5, Y(y) - 3.5, 7, 7);
      ctx.fill();
      ctx.stroke();
    }
  }, [pts, ch, size, histogram]);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // Map client coords → 0..255 inside the padded plot area.
    const padX = (CURVE_PAD / size) * r.width;
    const padY = (CURVE_PAD / size) * r.height;
    const toPt = (cx: number, cy: number): [number, number] => [
      Math.round(Math.max(0, Math.min(255, ((cx - r.left - padX) / (r.width - padX * 2)) * 255))),
      Math.round(Math.max(0, Math.min(255, (1 - (cy - r.top - padY) / (r.height - padY * 2)) * 255))),
    ];
    const p = toPt(e.clientX, e.clientY);
    let idx = pts.findIndex(([x, y]) => Math.abs(x - p[0]) < 10 && Math.abs(y - p[1]) < 10);
    let list: CurvePoints = pts.map((q) => [q[0], q[1]]);
    if (idx < 0) {
      list.push(p);
      list.sort((a, b) => a[0] - b[0]);
      idx = list.findIndex((q) => q[0] === p[0] && q[1] === p[1]);
      onChange({ ...value, [ch]: list });
    }
    const move = (ev: PointerEvent) => {
      const np = toPt(ev.clientX, ev.clientY);
      const outside = ev.clientX < r.left - 30 || ev.clientX > r.right + 30 || ev.clientY < r.top - 30 || ev.clientY > r.bottom + 30;
      const base = list.filter((_, k) => k !== idx);
      if (outside && list.length > 2) {
        onChange({ ...value, [ch]: base });
        return;
      }
      // keep x between neighbours
      const prev = list[idx - 1]?.[0] ?? -1;
      const next = list[idx + 1]?.[0] ?? 256;
      np[0] = Math.max(prev + 1, Math.min(next - 1, np[0]));
      list = list.map((q, k) => (k === idx ? np : q));
      onChange({ ...value, [ch]: list });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const outside = ev.clientX < r.left - 30 || ev.clientX > r.right + 30 || ev.clientY < r.top - 30 || ev.clientY > r.bottom + 30;
      const final = outside && list.length > 2 ? list.filter((_, k) => k !== idx) : list;
      const v = { ...value, [ch]: final };
      onChange(v);
      onCommit?.(v);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Tabs
        value={ch}
        onChange={setCh}
        tabs={[
          { value: 'rgb', label: 'RGB' },
          { value: 'r', label: 'Red' },
          { value: 'g', label: 'Green' },
          { value: 'b', label: 'Blue' },
        ]}
      />
      <canvas
        ref={ref}
        style={{ width: size, height: size, borderRadius: 3, border: '1px solid #333', cursor: 'crosshair' }}
        onPointerDown={onDown}
      />
    </div>
  );
}
