import { useEffect, useRef } from 'react';
import type { Histogram } from './histogram';

/** Robust display max: ignore isolated spikes (e.g. a flat background) so detail stays visible. */
export function displayMax(bins: ArrayLike<number>): number {
  const sorted = Array.from(bins).sort((a, b) => a - b);
  const robust = sorted[Math.floor(sorted.length * 0.985)] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  return Math.max(1, Math.min(max, robust * 1.6));
}

/** Histogram bins clipped to the robust max (for CurvesEditor, which normalizes by the max). */
export function clippedBins(bins: ArrayLike<number>): number[] {
  const m = displayMax(bins);
  return Array.from(bins, (v) => Math.min(v, m));
}

/**
 * Luminance histogram with faint per-channel outlines. Shows a loading shimmer while null.
 */
export function HistogramCanvas({ histogram, width, height = 96, channels = true }: { histogram: Histogram | null; width: number; height?: number; channels?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.max(1, Math.round(height * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, width, height);
    // quarter grid
    ctx.strokeStyle = '#232323';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const x = Math.round((i * width) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    if (!histogram || !histogram.count) return;
    const bw = width / 256;
    const max = displayMax(histogram.lum);
    ctx.fillStyle = '#8f8f8f';
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < 256; i++) {
      const h = Math.min(1, histogram.lum[i] / max) * (height - 4);
      ctx.lineTo(i * bw, height - h);
      ctx.lineTo((i + 1) * bw, height - h);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
    if (channels) {
      const chans: [Uint32Array, string][] = [
        [histogram.r, 'rgba(255,90,90,0.55)'],
        [histogram.g, 'rgba(90,230,130,0.5)'],
        [histogram.b, 'rgba(90,150,255,0.6)'],
      ];
      ctx.lineWidth = 1;
      for (const [bins, color] of chans) {
        const m = displayMax(bins);
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) {
          const h = Math.min(1, bins[i] / m) * (height - 4);
          const x = (i + 0.5) * bw;
          if (i === 0) ctx.moveTo(x, height - h);
          else ctx.lineTo(x, height - h);
        }
        ctx.stroke();
      }
    }
  }, [histogram, width, height, channels]);
  return (
    <canvas
      ref={ref}
      className={`adjustments-histogram${histogram ? '' : ' loading'}`}
      style={{ width, height }}
      title={histogram ? `${histogram.count.toLocaleString()} pixels sampled from the layers below` : 'Computing histogram…'}
    />
  );
}
