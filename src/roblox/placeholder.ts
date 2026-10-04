/**
 * Placeholder Roblox-style character renderer (contract used by templates & the Roblox module).
 * Draws a blocky R6-like avatar silhouette into a transparent canvas. The Roblox module may
 * replace the implementation (e.g. a three.js render) but must keep this signature synchronous.
 */
import { createCanvas, ctx2d } from '../core/canvas';

export type PlaceholderPose = 'idle' | 'action' | 'back' | 'sword' | 'arms-crossed' | 'hero';

export interface PlaceholderOptions {
  width: number;
  height: number;
  pose?: PlaceholderPose;
  /** 'flat' = single-color silhouette; 'shaded' = simple 3-tone shading. */
  style?: 'flat' | 'shaded';
  skin?: string;
  shirt?: string;
  pants?: string;
  hair?: string;
  /** Silhouette color for style 'flat'. */
  silhouette?: string;
}

export function renderPlaceholderCharacter(opts: PlaceholderOptions): HTMLCanvasElement {
  const { width, height } = opts;
  const c = createCanvas(width, height);
  const ctx = ctx2d(c);
  const flat = opts.style === 'flat';
  const col = (v: string | undefined, d: string) => (flat ? (opts.silhouette ?? '#111111') : (v ?? d));
  const skin = col(opts.skin, '#d8b48a');
  const shirt = col(opts.shirt, '#1d1d22');
  const pants = col(opts.pants, '#26262c');
  const hair = col(opts.hair, '#2a2a33');

  // R6 proportions in "studs": head 2x1(+), torso 2x2, arms/legs 1x2.
  const u = Math.min(width / 5.2, height / 6.4);
  const cx = width / 2;
  const top = height - u * 6.1;
  const box = (x: number, y: number, w: number, h: number, fill: string, r = u * 0.08) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    if (!flat) {
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.roundRect(x + w * 0.62, y, w * 0.38, h, r);
      ctx.fill();
    }
  };
  const pose = opts.pose ?? 'idle';
  // legs
  box(cx - u, top + u * 4.1, u * 0.98, u * 2, pants);
  box(cx + u * 0.02, top + u * 4.1, u * 0.98, u * 2, pants);
  // torso
  box(cx - u, top + u * 2.1, u * 2, u * 2, shirt);
  // arms
  ctx.save();
  if (pose === 'action' || pose === 'sword' || pose === 'hero') {
    ctx.translate(cx + u * 1.5, top + u * 2.2);
    ctx.rotate(-1.1);
    box(-u * 0.5, 0, u, u * 2, shirt);
    ctx.restore();
    ctx.save();
    ctx.translate(cx - u * 1.5, top + u * 2.2);
    ctx.rotate(0.35);
    box(-u * 0.5, 0, u, u * 2, shirt);
  } else if (pose === 'arms-crossed') {
    box(cx - u * 1.0, top + u * 2.6, u * 2, u * 0.8, shirt);
    box(cx - u * 2, top + u * 2.1, u, u * 1.4, shirt);
    box(cx + u, top + u * 2.1, u, u * 1.4, shirt);
  } else {
    box(cx - u * 2.02, top + u * 2.1, u, u * 2, shirt);
    box(cx + u * 1.02, top + u * 2.1, u, u * 2, shirt);
  }
  ctx.restore();
  if (pose === 'sword') {
    ctx.save();
    ctx.translate(cx + u * 2.4, top + u * 1.6);
    ctx.rotate(-0.6);
    ctx.fillStyle = flat ? (opts.silhouette ?? '#111') : '#c9ccd4';
    ctx.fillRect(-u * 0.08, -u * 3.4, u * 0.16, u * 3.4);
    ctx.fillStyle = flat ? (opts.silhouette ?? '#111') : '#3a2a1a';
    ctx.fillRect(-u * 0.4, 0, u * 0.8, u * 0.14);
    ctx.restore();
  }
  // head
  box(cx - u * 0.62, top + u * 0.75, u * 1.24, u * 1.3, skin, u * 0.32);
  // hair
  ctx.fillStyle = hair;
  ctx.beginPath();
  const hx = cx - u * 0.82,
    hy = top + u * 0.45;
  ctx.moveTo(hx, hy + u * 0.9);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const x = hx + t * u * 1.64;
    const spike = i % 2 === 0 ? -u * 0.35 : u * 0.05;
    ctx.lineTo(x, hy + spike + Math.sin(t * Math.PI) * -u * 0.15);
  }
  ctx.lineTo(hx + u * 1.64, hy + u * 1.0);
  for (let i = 6; i >= 0; i--) {
    const t = i / 6;
    ctx.lineTo(hx + u * 0.1 + t * u * 1.44, hy + u * (0.75 + (i % 2) * 0.35));
  }
  ctx.closePath();
  ctx.fill();
  return c;
}
