/**
 * Shared tool plumbing: pointer → paint input, hover tracking + brush-outline cursor,
 * '[' / ']' / digit keys, and Shift-click line memory.
 */
import type { ToolPointerEvent } from '../../../registry';
import { brushPresets } from '../../../registry';
import { viewport } from '../../../editor/viewport';
import { activeSession, toolOptions, useEditor } from '../../../state/editor';
import { eventKey } from '../../../ui/shortcuts';
import { clamp } from '../../../core/geometry';
import { nextBrushSize, smoothingRadius, type InputPoint } from '../engine/math';
import { defaultsFor, effectivePressure, setOpt } from '../options';
import type { PaintBrushPreset } from '../presets/presets';

/* ---------------- input sampling ---------------- */

export function inputPoint(e: { docX: number; docY: number; pressure: number; pointerType: string }): InputPoint {
  return { x: e.docX, y: e.docY, pressure: effectivePressure(e.pointerType, e.pressure) };
}

/**
 * All pointer samples of a move event (coalesced events give smooth curves when the pointer
 * reports faster than the display refreshes). Falls back to the event itself.
 */
export function samplePoints(e: ToolPointerEvent): InputPoint[] {
  const native = e.native as PointerEvent | undefined;
  let list: PointerEvent[] = [];
  try {
    list = native && typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
  } catch {
    list = [];
  }
  if (list.length <= 1 || !native) return [inputPoint(e)];
  const offX = e.screenX - native.clientX;
  const offY = e.screenY - native.clientY;
  const out: InputPoint[] = [];
  for (const ce of list) {
    const p = viewport.screenToDoc({ x: ce.clientX + offX, y: ce.clientY + offY });
    out.push({ x: p.x, y: p.y, pressure: effectivePressure(ce.pointerType || e.pointerType, ce.pressure) });
  }
  // Make sure the last sample matches the dispatched event exactly.
  out[out.length - 1] = inputPoint(e);
  return out;
}

/** Stabilizer radius (doc px) for a smoothing % at the current zoom. */
export function stabilizerRadius(smoothing: number): number {
  return smoothingRadius(smoothing) / viewport.zoom();
}

/* ---------------- hover + cursor ---------------- */

export const hover = { x: 0, y: 0, inside: false };

let leaveCleanup: (() => void) | null = null;

export function trackHover(e: { docX: number; docY: number }) {
  hover.x = e.docX;
  hover.y = e.docY;
  hover.inside = true;
  viewport.requestOverlay();
}

/** Hide the outline when the pointer leaves the viewport (installed on tool activation). */
export function installLeaveTracking() {
  leaveCleanup?.();
  const el = viewport.element();
  if (!el) return;
  const leave = () => {
    hover.inside = false;
    viewport.requestOverlay();
  };
  el.addEventListener('pointerleave', leave);
  leaveCleanup = () => el.removeEventListener('pointerleave', leave);
}

export function removeLeaveTracking() {
  leaveCleanup?.();
  leaveCleanup = null;
  hover.inside = false;
}

/** Brush outlines smaller than this (screen px) fall back to a crosshair cursor. */
const MIN_OUTLINE = 7;

export function outlineVisible(size: number): boolean {
  return size * viewport.zoom() >= MIN_OUTLINE;
}

/** CSS cursor for a brush-like tool. */
export function brushCursor(size: number): string {
  return outlineVisible(size) ? 'none' : 'crosshair';
}

export interface OutlineOptions {
  /** Diameter in doc px. */
  size: number;
  angle?: number;
  roundness?: number;
  square?: boolean;
  /** Doc point (defaults to the hover position). */
  at?: { x: number; y: number };
}

/** Draw the brush outline (ellipse / rect for angle, roundness, square) at the hover point, in screen space. */
export function drawBrushOutline(ctx: CanvasRenderingContext2D, o: OutlineOptions) {
  const at = o.at ?? hover;
  if (!o.at && !hover.inside) return;
  if (!activeSession()) return;
  const angle = o.angle ?? 0;
  const roundness = o.roundness ?? 1;
  const p = viewport.docToScreen(at);
  const r = (o.size / 2) * viewport.zoom();
  ctx.save();
  ctx.translate(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
  if (r >= MIN_OUTLINE / 2) {
    ctx.save();
    ctx.rotate((angle * Math.PI) / 180);
    ctx.beginPath();
    if (o.square) ctx.rect(-r, -r * roundness, r * 2, r * 2 * roundness);
    else ctx.ellipse(0, 0, r, Math.max(0.5, r * roundness), 0, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.restore();
  }
  // Small center cross.
  const c = r >= MIN_OUTLINE / 2 ? 3 : 6;
  ctx.beginPath();
  ctx.moveTo(-c, 0);
  ctx.lineTo(c, 0);
  ctx.moveTo(0, -c);
  ctx.lineTo(0, c);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.stroke();
  ctx.restore();
}

/** True when a preset paints with the Square tip (directly or as a user preset saved from it). */
export function isSquareTip(presetId: string): boolean {
  if (presetId === 'square') return true;
  return (brushPresets.get(presetId) as PaintBrushPreset | undefined)?.tipFrom === 'square';
}

/** Crosshair marker in screen space (clone source, gradient endpoints…). */
export function drawCrosshair(ctx: CanvasRenderingContext2D, docPt: { x: number; y: number }, size = 9) {
  const p = viewport.docToScreen(docPt);
  ctx.save();
  ctx.translate(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
  ctx.beginPath();
  ctx.moveTo(-size, 0);
  ctx.lineTo(size, 0);
  ctx.moveTo(0, -size);
  ctx.lineTo(0, size);
  ctx.arc(0, 0, size * 0.55, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.restore();
}

/* ---------------- keyboard ---------------- */

let digitBuffer = '';
let digitTime = 0;

export interface KeyTargets {
  /** Option key for size ('size'), or null. */
  size?: string | null;
  /** Option key for hardness, or null. */
  hardness?: string | null;
  /** Option key the digit keys set (0..1), e.g. 'opacity', 'strength'. */
  digits?: string | null;
}

/**
 * Photoshop keys: '[' / ']' size, Shift+'[' / ']' hardness ±25%, digits set opacity
 * (1 = 10% … 0 = 100%, two quick digits = exact %). Returns true when handled.
 */
export function handleBrushKeys(toolId: string, e: KeyboardEvent, keys: KeyTargets): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const k = eventKey(e);
  const opts = toolOptions(toolId, defaultsFor(toolId)) as Record<string, unknown>;
  if ((k === '[' || k === ']') && (keys.size || keys.hardness)) {
    const dir = k === ']' ? 1 : -1;
    if (e.shiftKey && keys.hardness) {
      const h = Number(opts[keys.hardness] ?? 1);
      setOpt(toolId, keys.hardness, clamp(Math.round((h + dir * 0.25) * 100) / 100, 0, 1));
    } else if (!e.shiftKey && keys.size) {
      setOpt(toolId, keys.size, nextBrushSize(Number(opts[keys.size] ?? 10), dir as 1 | -1));
    } else return false;
    viewport.requestOverlay();
    return true;
  }
  if (keys.digits && !e.shiftKey && /^[0-9]$/.test(k)) {
    const now = performance.now();
    if (now - digitTime < 450 && digitBuffer.length === 1) {
      digitBuffer += k;
      const v = Number(digitBuffer);
      setOpt(toolId, keys.digits, clamp((v === 0 ? 100 : v) / 100, 0.01, 1));
      digitBuffer = '';
    } else {
      digitBuffer = k;
      const v = Number(k);
      setOpt(toolId, keys.digits, v === 0 ? 1 : v / 10);
    }
    digitTime = now;
    return true;
  }
  return false;
}

/* ---------------- Shift-click line memory ---------------- */

/** End of a tool's last stroke; `carry` = distance travelled since its last dab (even joint spacing). */
export interface LastPoint {
  x: number;
  y: number;
  carry: number;
}

const lastPoints = new Map<string, LastPoint & { docId: string; layerId: string }>();

export function rememberLastPoint(toolId: string, docId: string, layerId: string, p: { x: number; y: number; carry?: number }) {
  lastPoints.set(toolId, { docId, layerId, x: p.x, y: p.y, carry: p.carry ?? 0 });
}

export function lastPointFor(toolId: string, docId: string, layerId: string): LastPoint | null {
  const p = lastPoints.get(toolId);
  if (!p || p.docId !== docId || p.layerId !== layerId) return null;
  return { x: p.x, y: p.y, carry: p.carry };
}

/* ---------------- axis lock (Shift while dragging) ---------------- */

export class AxisLock {
  private anchor: { x: number; y: number } | null = null;
  private axis: 'x' | 'y' | null = null;

  apply(p: InputPoint, shift: boolean, current: { x: number; y: number } | null): InputPoint {
    if (!shift) {
      this.anchor = null;
      this.axis = null;
      return p;
    }
    if (!this.anchor) this.anchor = current ? { ...current } : { x: p.x, y: p.y };
    const dx = p.x - this.anchor.x;
    const dy = p.y - this.anchor.y;
    if (!this.axis) {
      // Decide the axis only after a clear initial movement (6 screen px).
      if (Math.hypot(dx, dy) < 6 / viewport.zoom()) return { ...p, x: this.anchor.x, y: this.anchor.y };
      this.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    }
    return this.axis === 'x' ? { ...p, y: this.anchor.y } : { ...p, x: this.anchor.x };
  }
}

/** Primary / secondary colors. */
export function colors() {
  const st = useEditor.getState();
  return { primary: st.primaryColor, secondary: st.secondaryColor };
}
