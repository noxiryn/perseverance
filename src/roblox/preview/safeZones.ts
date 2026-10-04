/**
 * Roblox safe-zone overlay (viewOverlays id 'roblox-safe-zones').
 *  - Square docs (icons/badges): rounded-corner icon mask preview (dims what the rounded tile
 *    hides), badge / game-pass circle, inner "keep important content" box.
 *  - 16:9 docs (thumbnails): title-safe 90% box, edge margins, and areas Roblox UI may overlap
 *    (carousel arrows, page dots, featured-tile title band).
 *  - Other ratios: title-safe box and the centered square / 16:9 crops.
 * Geometry is pure (unit-tested); rendering happens in screen space via viewport.docToScreen.
 */
import type { Rect } from '../../core/types';
import type { ViewOverlayDef } from '../../registry';
import { viewport } from '../../editor/viewport';
import { activeDoc } from '../../state/editor';
import { useUI } from '../../state/ui';

export type SafeZoneFormat = 'icon' | 'thumbnail' | 'other';

export interface SafeZoneShape {
  kind: 'rect' | 'roundRect' | 'circle';
  rect: Rect;
  radius?: number;
  label: string;
  role: 'mask' | 'keep' | 'title' | 'ui' | 'badge' | 'crop';
  /** Dim everything outside this shape. */
  dimOutside?: boolean;
  /** Filled (hatched) area rather than an outline. */
  fill?: boolean;
}

export interface SafeZoneLayout {
  format: SafeZoneFormat;
  shapes: SafeZoneShape[];
}

export function safeZoneFormat(w: number, h: number): SafeZoneFormat {
  const r = w / h;
  if (Math.abs(r - 1) < 0.02) return 'icon';
  if (Math.abs(r - 16 / 9) < 0.04) return 'thumbnail';
  return 'other';
}

/** Rounded-corner radius used by Roblox game tiles, as a fraction of the icon size. */
export const ICON_CORNER = 0.1;

export function safeZoneLayout(w: number, h: number): SafeZoneLayout {
  const format = safeZoneFormat(w, h);
  const shapes: SafeZoneShape[] = [];
  if (format === 'icon') {
    const s = Math.min(w, h);
    shapes.push({ kind: 'roundRect', rect: { x: 0, y: 0, width: w, height: h }, radius: s * ICON_CORNER, label: 'Icon tile (rounded corners)', role: 'mask', dimOutside: true });
    shapes.push({ kind: 'circle', rect: { x: 0, y: 0, width: w, height: h }, label: 'Badge / game pass circle', role: 'badge' });
    const m = s * 0.1;
    shapes.push({ kind: 'rect', rect: { x: m, y: m, width: w - 2 * m, height: h - 2 * m }, label: 'Keep important content inside', role: 'keep' });
  } else if (format === 'thumbnail') {
    const mx = w * 0.05,
      my = h * 0.05;
    shapes.push({ kind: 'rect', rect: { x: mx, y: my, width: w - 2 * mx, height: h - 2 * my }, label: 'Title safe (90%)', role: 'title' });
    const ax = w * 0.025,
      ay = h * 0.025;
    shapes.push({ kind: 'rect', rect: { x: ax, y: ay, width: w - 2 * ax, height: h - 2 * ay }, label: 'Edge margin', role: 'keep' });
    // Carousel arrows (game page) at mid-height near both edges.
    const ar = h * 0.075;
    shapes.push({ kind: 'circle', rect: { x: w * 0.012, y: h / 2 - ar, width: ar * 2, height: ar * 2 }, label: 'Arrow', role: 'ui', fill: true });
    shapes.push({ kind: 'circle', rect: { x: w - w * 0.012 - ar * 2, y: h / 2 - ar, width: ar * 2, height: ar * 2 }, label: 'Arrow', role: 'ui', fill: true });
    // Page indicator dots, bottom center.
    shapes.push({ kind: 'roundRect', rect: { x: w * 0.42, y: h * 0.915, width: w * 0.16, height: h * 0.05 }, radius: h * 0.025, label: 'Page dots', role: 'ui', fill: true });
    // Featured / sponsored tiles overlay the game title and rating on the bottom band.
    shapes.push({ kind: 'rect', rect: { x: 0, y: h * 0.8, width: w * 0.62, height: h * 0.2 }, label: 'Title & rating overlay (featured tiles)', role: 'ui', fill: true });
  } else {
    const mx = w * 0.05,
      my = h * 0.05;
    shapes.push({ kind: 'rect', rect: { x: mx, y: my, width: w - 2 * mx, height: h - 2 * my }, label: 'Title safe (90%)', role: 'title' });
    const s = Math.min(w, h);
    shapes.push({ kind: 'roundRect', rect: { x: (w - s) / 2, y: (h - s) / 2, width: s, height: s }, radius: s * ICON_CORNER, label: 'Square icon crop', role: 'crop' });
    let cw = w,
      ch = (w * 9) / 16;
    if (ch > h) {
      ch = h;
      cw = (h * 16) / 9;
    }
    shapes.push({ kind: 'rect', rect: { x: (w - cw) / 2, y: (h - ch) / 2, width: cw, height: ch }, label: '16:9 thumbnail crop', role: 'crop' });
  }
  return { format, shapes };
}

const COLORS: Record<SafeZoneShape['role'], string> = {
  mask: 'rgba(255,255,255,0.85)',
  keep: '#34d6ff',
  title: '#4fc98a',
  ui: '#f2b84b',
  badge: '#b4a8ff',
  crop: '#ff7ab8',
};

function shapePath(ctx: CanvasRenderingContext2D, s: SafeZoneShape, map: (x: number, y: number) => { x: number; y: number }, z: number) {
  const p = map(s.rect.x, s.rect.y);
  const w = s.rect.width * z,
    h = s.rect.height * z;
  if (s.kind === 'circle') ctx.ellipse(p.x + w / 2, p.y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (s.kind === 'roundRect') ctx.roundRect(p.x, p.y, w, h, (s.radius ?? 0) * z);
  else ctx.rect(p.x, p.y, w, h);
}

let hatch: CanvasPattern | null = null;
function hatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (hatch) return hatch;
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const g = c.getContext('2d');
  if (!g) return null;
  g.strokeStyle = 'rgba(242,184,75,0.55)';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(-2, 10);
  g.lineTo(10, -2);
  g.moveTo(6, 10);
  g.lineTo(10, 6);
  g.moveTo(-2, 2);
  g.lineTo(2, -2);
  g.stroke();
  hatch = ctx.createPattern(c, 'repeat');
  return hatch;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  ctx.font = '500 10px Inter, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = 'rgba(12,12,12,0.78)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, 15, 3);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 4, y + 8);
}

/** Draw the overlay for a doc of size (w × h) in screen space. */
export function drawSafeZones(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const layout = safeZoneLayout(w, h);
  const z = viewport.zoom();
  const map = (x: number, y: number) => viewport.docToScreen({ x, y });
  const o = map(0, 0);
  const showLabels = Math.min(w, h) * z > 180;
  ctx.save();
  ctx.lineWidth = 1;
  // Dim outside the icon mask.
  for (const s of layout.shapes) {
    if (!s.dimOutside) continue;
    ctx.beginPath();
    ctx.rect(o.x, o.y, w * z, h * z);
    shapePath(ctx, s, map, z);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
  }
  for (const s of layout.shapes) {
    const color = COLORS[s.role];
    ctx.beginPath();
    shapePath(ctx, s, map, z);
    if (s.fill) {
      const pat = hatchPattern(ctx);
      ctx.fillStyle = pat ?? 'rgba(242,184,75,0.18)';
      ctx.fill();
      ctx.setLineDash([]);
    } else ctx.setLineDash(s.role === 'badge' || s.role === 'crop' ? [6, 4] : s.role === 'title' ? [10, 4] : []);
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (showLabels) {
    const placed: { x: number; y: number }[] = [];
    for (const s of layout.shapes) {
      if (s.label === 'Arrow' || s.role === 'mask') continue;
      const p = map(s.rect.x, s.rect.y);
      let x = p.x + 6,
        y = p.y + 6;
      if (s.kind === 'circle' && s.role === 'badge') {
        x = p.x + (s.rect.width * z) / 2 - 60;
        y = p.y + s.rect.height * z - 24;
      }
      while (placed.some((q) => Math.abs(q.y - y) < 16 && Math.abs(q.x - x) < 140)) y += 17;
      placed.push({ x, y });
      label(ctx, s.label, x, y, COLORS[s.role]);
    }
  }
  ctx.restore();
}

export const safeZoneOverlay: ViewOverlayDef = {
  id: 'roblox-safe-zones',
  order: 80,
  enabled: () => !!useUI.getState().view.safeZones && !!activeDoc(),
  render(ctx) {
    const doc = activeDoc();
    if (doc) drawSafeZones(ctx, doc.width, doc.height);
  },
};

export function toggleSafeZones(value?: boolean) {
  useUI.getState().toggleView('safeZones', value);
  viewport.requestOverlay();
  viewport.requestRender();
}
