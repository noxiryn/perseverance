/**
 * DabPainter: draws resolved dabs (document space) into a canvas through an optional
 * doc → local matrix. Stamps are pre-tinted GPU canvases, so a dab is a single drawImage.
 */
import type { Rect } from '../../../core/types';
import { brushPresets } from '../../../registry';
import { pencilTip, roundTip, textureTip, tinted } from './tips';
import { dabBounds, type Dab } from './math';

export type TipSpec =
  | { kind: 'round'; hardness: number }
  | { kind: 'texture'; presetId: string }
  | { kind: 'pencil'; square: boolean };

/** Choose the tip for a preset id + hardness (textured presets win over round). */
export function tipForPreset(presetId: string, hardness: number): TipSpec {
  const p = brushPresets.get(presetId);
  if (p?.tip) return { kind: 'texture', presetId };
  return { kind: 'round', hardness };
}

/** Uniform scale factor of an affine matrix (sqrt |det|). */
export function matrixScale(m: DOMMatrix | null): number {
  if (!m) return 1;
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
}

/** AABB of a doc-space rect after an affine transform. */
export function transformRect(r: Rect, m: DOMMatrix | null): Rect {
  if (!m) return r;
  const xs = [r.x, r.x + r.width];
  const ys = [r.y, r.y + r.height];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const x of xs)
    for (const y of ys) {
      const tx = m.a * x + m.c * y + m.e;
      const ty = m.b * x + m.d * y + m.f;
      if (tx < minX) minX = tx;
      if (ty < minY) minY = ty;
      if (tx > maxX) maxX = tx;
      if (ty > maxY) maxY = ty;
    }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface DabPainterOptions {
  tip: TipSpec;
  /** CSS color (alpha allowed). */
  color: string;
  /** Doc → canvas matrix (null = identity). */
  base: DOMMatrix | null;
  /** Largest dab diameter expected (doc px) — picks the stamp resolution. */
  maxSize: number;
}

export class DabPainter {
  readonly base: DOMMatrix | null;
  private scale: number;
  private stamp: HTMLCanvasElement | null = null;
  private white: HTMLCanvasElement | null = null;

  constructor(private opts: DabPainterOptions) {
    this.base = opts.base;
    this.scale = matrixScale(opts.base);
    if (opts.tip.kind !== 'pencil') {
      const res = Math.max(2, opts.maxSize * this.scale);
      if (opts.tip.kind === 'round') this.white = roundTip(res, opts.tip.hardness);
      else {
        const preset = brushPresets.get(opts.tip.presetId);
        this.white = (preset && textureTip(preset, res)) || roundTip(res, 1);
      }
      this.stamp = tinted(this.white, opts.color);
    }
  }

  /** The untinted (white alpha) stamp, for tools that mask other content with the tip. */
  get whiteStamp(): HTMLCanvasElement | null {
    return this.white;
  }

  get isPencil(): boolean {
    return this.opts.tip.kind === 'pencil';
  }

  /** Canvas-space bounds a dab will touch. */
  bounds(d: Dab): Rect {
    if (this.opts.tip.kind === 'pencil') {
      const p = this.toLocal(d.x, d.y);
      const n = Math.max(1, Math.round(d.size * this.scale));
      return { x: Math.round(p.x - n / 2) - 1, y: Math.round(p.y - n / 2) - 1, width: n + 2, height: n + 2 };
    }
    return transformRect(dabBounds(d), this.base);
  }

  toLocal(x: number, y: number): { x: number; y: number } {
    const m = this.base;
    if (!m) return { x, y };
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }

  /** Set ctx transform = base · T(x,y) · R(angle) · S(1, roundness). */
  applyDabTransform(ctx: CanvasRenderingContext2D, d: Dab) {
    const rad = (d.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const ma = cos,
      mb = sin,
      mc = -sin * d.roundness,
      md = cos * d.roundness,
      me = d.x,
      mf = d.y;
    const b = this.base;
    if (!b) {
      ctx.setTransform(ma, mb, mc, md, me, mf);
      return;
    }
    ctx.setTransform(
      b.a * ma + b.c * mb,
      b.b * ma + b.d * mb,
      b.a * mc + b.c * md,
      b.b * mc + b.d * md,
      b.a * me + b.c * mf + b.e,
      b.b * me + b.d * mf + b.f,
    );
  }

  /** Draw one dab; returns the touched canvas-space rect. */
  draw(ctx: CanvasRenderingContext2D, d: Dab): Rect {
    if (this.opts.tip.kind === 'pencil') {
      const p = this.toLocal(d.x, d.y);
      const n = Math.max(1, Math.round(d.size * this.scale));
      const tip = tinted(pencilTip(n, this.opts.tip.square), this.opts.color);
      const x = Math.round(p.x - n / 2);
      const y = Math.round(p.y - n / 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = d.alpha;
      ctx.drawImage(tip, x, y);
      ctx.imageSmoothingEnabled = true;
      return { x, y, width: n, height: n };
    }
    this.applyDabTransform(ctx, d);
    ctx.globalAlpha = d.alpha;
    const s = d.size;
    ctx.drawImage(this.stamp!, -s / 2, -s / 2, s, s);
    return this.bounds(d);
  }
}
