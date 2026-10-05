/**
 * Generic stamp-based painting tool (brush, pencil, eraser, clone stamp): pointer handling,
 * stroke lifecycle, Shift lines, axis lock, airbrush build-up and the live composite session.
 * Each concrete tool supplies a `setup()` that decides the tip, color and composite mode.
 */
import type { ComponentType } from 'react';
import type { Rect } from '../../../core/types';
import type { ToolDef, ToolPointerEvent } from '../../../registry';
import { viewport } from '../../../editor/viewport';
import { activeSession } from '../../../state/editor';
import { toast } from '../../../state/ui';
import { isModifierKey, watchStroke } from '../engine/guard';
import { CompositeSession, type CompositeMode } from '../engine/session';
import { BrushStroke, type StrokeConfig } from '../engine/stroke';
import { resolvePaintTarget, type PaintTarget } from '../engine/target';
import type { Dab } from '../engine/math';
import {
  AxisLock,
  inputPoint,
  installLeaveTracking,
  lastPointFor,
  rememberLastPoint,
  removeLeaveTracking,
  samplePoints,
  trackHover,
} from './common';

export interface StampSetup {
  config: StrokeConfig;
  mode: CompositeMode;
  /** Draw one dab into the stroke buffer; returns the touched local rect. */
  draw: (ctx: CanvasRenderingContext2D, dab: Dab) => Rect;
  airbrush?: boolean;
  /** Called after the stroke is committed or cancelled. */
  dispose?: () => void;
}

export interface StampToolSpec {
  id: string;
  name: string;
  /** History label, e.g. 'Brush Tool'. */
  label: string;
  icon: ToolDef['icon'];
  group: string;
  order: number;
  shortcut: string;
  defaultOptions: Record<string, unknown>;
  OptionsBar: ComponentType;
  cursor: () => string;
  /** Prepare a stroke (return null to refuse — the spec shows its own message). */
  setup(target: PaintTarget, e: ToolPointerEvent): StampSetup | null;
  /** Intercept pointer down before painting (e.g. Alt-click to set the clone source). Return true if handled. */
  preDown?(e: ToolPointerEvent): boolean;
  renderOverlay(ctx: CanvasRenderingContext2D, painting: boolean): void;
  onKeyDown?(e: KeyboardEvent): boolean | void;
  onKeyUp?(e: KeyboardEvent): boolean | void;
  onActivate?(): void;
  onDeactivate?(): void;
  /** Notified on each painted batch (clone uses it to track the source). */
  onStrokeMove?(p: { x: number; y: number }): void;
  onStrokeEnd?(): void;
}

interface ActiveStroke {
  session: CompositeSession;
  stroke: BrushStroke;
  setup: StampSetup;
  target: PaintTarget;
  axis: AxisLock;
  timer: number;
  /** Pointer move events seen (airbrush builds up only while the pointer rests). */
  moves: number;
  /** Stops the history/document watcher (see engine/guard). */
  unwatch: () => void;
}

export function createStampTool(spec: StampToolSpec): ToolDef {
  let active: ActiveStroke | null = null;

  const paint = (a: ActiveStroke, dabs: Dab[]) => {
    if (!dabs.length) return;
    const ctx = a.session.bufferCtx;
    for (const d of dabs) a.session.markDirty(a.setup.draw(ctx, d));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  };

  const finish = (e?: ToolPointerEvent, cancel = false) => {
    const a = active;
    if (!a) return;
    active = null;
    window.clearInterval(a.timer);
    a.unwatch();
    if (!cancel) {
      if (e) paint(a, a.stroke.end(a.axis.apply(inputPoint(e), e.shiftKey, a.stroke.position)));
      else paint(a, a.stroke.end());
      a.session.commit(spec.label);
      const end = a.stroke.resumeState;
      if (end) rememberLastPoint(spec.id, a.target.docId, a.target.layerId, end);
    } else a.session.cancel();
    a.setup.dispose?.();
    spec.onStrokeEnd?.();
    viewport.requestOverlay();
  };

  /** The guard discarded the stroke (history or document changed underneath it). */
  const abort = (a: ActiveStroke, message: string) => {
    if (active !== a) return;
    active = null;
    window.clearInterval(a.timer);
    a.setup.dispose?.();
    spec.onStrokeEnd?.();
    toast(message, 'warning');
    viewport.requestOverlay();
  };

  const tool: ToolDef = {
    id: spec.id,
    name: spec.name,
    shortcut: spec.shortcut,
    icon: spec.icon,
    group: spec.group,
    order: spec.order,
    cursor: spec.cursor,
    OptionsBar: spec.OptionsBar,
    defaultOptions: spec.defaultOptions,

    onActivate() {
      installLeaveTracking();
      spec.onActivate?.();
    },

    onDeactivate() {
      if (active) finish();
      removeLeaveTracking();
      spec.onDeactivate?.();
    },

    onPointerDown(e) {
      trackHover(e);
      if (e.button !== 0) return;
      if (active) finish();
      if (spec.preDown?.(e)) return;
      const target = resolvePaintTarget({ toolName: spec.name });
      if (!target) return;
      const setup = spec.setup(target, e);
      if (!setup) return;
      const session = new CompositeSession(target, setup.mode);
      const stroke = new BrushStroke(setup.config);
      const p = inputPoint(e);
      const a: ActiveStroke = { session, stroke, setup, target, axis: new AxisLock(), timer: 0, moves: 0, unwatch: () => {} };
      active = a;
      a.unwatch = watchStroke(session, (msg) => abort(a, msg));
      const last = e.shiftKey ? lastPointFor(spec.id, target.docId, target.layerId) : null;
      if (last) {
        // Continue the polyline from the previous end point without re-stamping the joint.
        stroke.beginAt({ x: last.x, y: last.y, pressure: p.pressure }, last.carry);
        paint(a, stroke.lineTo(p));
      } else {
        paint(a, stroke.begin(p));
      }
      spec.onStrokeMove?.(p);
      if (setup.airbrush) {
        let seen = 0;
        a.timer = window.setInterval(() => {
          if (active !== a) return;
          if (a.moves === seen) paint(a, a.stroke.stationary());
          seen = a.moves;
        }, 40);
      }
    },

    onPointerMove(e) {
      trackHover(e);
      const a = active;
      if (!a) return;
      a.moves++;
      for (const raw of samplePoints(e)) {
        const p = a.axis.apply(raw, e.shiftKey, a.stroke.position);
        paint(a, a.stroke.move(p));
      }
      const pos = a.stroke.position;
      if (pos) spec.onStrokeMove?.(pos);
    },

    onPointerUp(e) {
      trackHover(e);
      if (active) finish(e);
    },

    onHover(e) {
      trackHover(e);
    },

    onKeyDown(e) {
      if (active && !isModifierKey(e)) {
        if (e.key === 'Escape') {
          finish(undefined, true);
          return true;
        }
        if (spec.onKeyDown?.(e)) return true; // '[' / ']' / digits keep the stroke going
        // Any other key may run a command (undo, clear, switch document…): commit the stroke
        // first so the command sees — and history records — a consistent state.
        finish();
        return false;
      }
      return spec.onKeyDown?.(e);
    },

    onKeyUp(e) {
      return spec.onKeyUp?.(e);
    },

    renderOverlay(ctx) {
      if (!activeSession()) return;
      spec.renderOverlay(ctx, !!active);
    },
  };
  return tool;
}
