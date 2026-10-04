/**
 * Retouch tools: Blur, Sharpen, Smudge (R) and Dodge, Burn, Sponge (O). Each dab runs a pixel
 * op on the small region under the brush through a PixelSession (CPU, tile-cached).
 */
import { CircleDashed, Droplet, Flame, Pointer, SunDim, Triangle } from 'lucide-react';
import type { ToolDef, ToolPointerEvent } from '../../../registry';
import { parseColor } from '../../../core/color';
import { activeSession, toolOptions } from '../../../state/editor';
import { viewport } from '../../../editor/viewport';
import { BrushStroke } from '../engine/stroke';
import { matrixScale } from '../engine/dabs';
import { PixelSession } from '../engine/pixelSession';
import {
  blurSharpenDab,
  createSmudgeState,
  dabRect,
  primeSmudge,
  smudgeDab,
  toneDab,
  type DabArea,
  type SmudgeState,
  type ToneOp,
} from '../engine/pixelOps';
import { docToLocal, maskGray, resolvePaintTarget } from '../engine/target';
import type { Dab } from '../engine/math';
import { retouchDefaults, type RetouchToolOptions } from '../options';
import { RetouchOptionsBar } from '../ui/OptionsBars';
import {
  AxisLock,
  brushCursor,
  colors,
  drawBrushOutline,
  handleBrushKeys,
  inputPoint,
  installLeaveTracking,
  removeLeaveTracking,
  samplePoints,
  stabilizerRadius,
  trackHover,
} from './common';

type RetouchKind = 'blur' | 'sharpen' | 'smudge' | 'dodge' | 'burn' | 'sponge';

interface RetouchSpec {
  id: string;
  name: string;
  label: string;
  kind: RetouchKind;
  icon: ToolDef['icon'];
  group: string;
  order: number;
  shortcut: string;
}

/** The option the digit keys set for each kind. */
function digitKey(kind: RetouchKind): string {
  if (kind === 'dodge' || kind === 'burn') return 'exposure';
  if (kind === 'sponge') return 'flow';
  return 'strength';
}

function createRetouchTool(spec: RetouchSpec): ToolDef {
  const defaults = retouchDefaults(spec.id);
  const opts = () => toolOptions(spec.id, defaults) as RetouchToolOptions;

  interface Active {
    session: PixelSession;
    stroke: BrushStroke;
    o: RetouchToolOptions;
    scale: number;
    smudge: SmudgeState | null;
    tone: ToneOp | null;
    axis: AxisLock;
    finger: [number, number, number] | null;
    /** Previous dab center (local px) — smudge pickup is distance based. */
    lastDab: { x: number; y: number } | null;
  }
  let active: Active | null = null;

  const applyDab = (a: Active, d: Dab) => {
    const t = a.session.target;
    const c = docToLocal(t, d.x, d.y);
    const radius = Math.max(0.75, (d.size / 2) * a.scale);
    const area: DabArea = {
      cx: c.x,
      cy: c.y,
      radius,
      hardness: a.o.hardness,
      sel: a.session.sel,
      lockAlpha: t.lockTransparency || t.kind === 'mask',
    };
    const reach = dabRect(a.session.buf, c.x, c.y, radius, 10);
    if (!reach) return;
    a.session.ensure(reach);
    const strength = d.alpha; // flow × pressure-strength
    let rect = null;
    switch (spec.kind) {
      case 'blur':
        rect = blurSharpenDab(a.session.buf, area, strength * 0.55, false);
        break;
      case 'sharpen':
        rect = blurSharpenDab(a.session.buf, area, strength * 0.22, true);
        break;
      case 'smudge': {
        if (!a.smudge) {
          a.smudge = createSmudgeState(radius);
          primeSmudge(a.smudge, a.session.buf, c.x, c.y, radius, a.finger ?? undefined);
          a.lastDab = c;
          return;
        }
        // Strength = color kept per quarter-radius of travel, so the smear length does not
        // depend on dab spacing or how the pointer was sampled.
        const step = a.lastDab ? Math.hypot(c.x - a.lastDab.x, c.y - a.lastDab.y) : 0;
        a.lastDab = c;
        if (step < 0.05) return;
        const keep = Math.pow(Math.min(0.98, strength), Math.min(4, step / Math.max(1, radius * 0.25)));
        rect = smudgeDab(a.session.buf, a.smudge, area, keep);
        break;
      }
      default:
        rect = toneDab(a.session.buf, a.session.orig, a.session.coverage(), area, 0.35 * strength, a.tone!);
    }
    if (rect) a.session.markDirty(rect);
  };

  const paint = (a: Active, dabs: Dab[]) => {
    for (const d of dabs) applyDab(a, d);
  };

  const finish = (e?: ToolPointerEvent, cancel = false) => {
    const a = active;
    if (!a) return;
    active = null;
    if (cancel) a.session.cancel();
    else {
      paint(a, a.stroke.end(e ? a.axis.apply(inputPoint(e), e.shiftKey, a.stroke.position) : undefined));
      a.session.commit(spec.label);
    }
    viewport.requestOverlay();
  };

  return {
    id: spec.id,
    name: spec.name,
    shortcut: spec.shortcut,
    icon: spec.icon,
    group: spec.group,
    order: spec.order,
    defaultOptions: defaults,
    OptionsBar: RetouchOptionsBar,
    cursor: () => brushCursor(opts().size),

    onActivate() {
      installLeaveTracking();
    },
    onDeactivate() {
      if (active) finish();
      removeLeaveTracking();
    },

    onPointerDown(e) {
      trackHover(e);
      if (e.button !== 0) return;
      if (active) finish();
      const target = resolvePaintTarget({ toolName: spec.name });
      if (!target) return;
      const o = opts();
      const strengthValue = spec.kind === 'dodge' || spec.kind === 'burn' ? 1 : spec.kind === 'sponge' ? 1 : o.strength;
      const stroke = new BrushStroke({
        size: Math.max(1, o.size),
        flow: strengthValue,
        angle: 0,
        roundness: 1,
        sizeJitter: 0,
        angleJitter: 0,
        scatter: 0,
        opacityJitter: 0,
        pressureSize: o.pressureSize,
        pressureOpacity: o.pressureStrength,
        followDirection: false,
        spacing: Math.max(0.02, o.spacing),
        stabilizer: stabilizerRadius(o.smoothing),
      });
      let tone: ToneOp | null = null;
      if (spec.kind === 'dodge' || spec.kind === 'burn') tone = { kind: spec.kind, range: o.range, exposure: o.exposure, protect: o.protectTones };
      else if (spec.kind === 'sponge') tone = { kind: 'sponge', mode: o.spongeMode, flow: o.flow, vibrance: o.vibrance };
      let finger: [number, number, number] | null = null;
      if (spec.kind === 'smudge' && o.fingerPainting) {
        const col = parseColor(target.kind === 'mask' ? maskGray(colors().primary) : colors().primary);
        finger = [col.r, col.g, col.b];
      }
      const a: Active = {
        session: new PixelSession(target),
        stroke,
        o,
        scale: matrixScale(target.toLocal),
        smudge: null,
        tone,
        axis: new AxisLock(),
        finger,
        lastDab: null,
      };
      active = a;
      paint(a, stroke.begin(inputPoint(e)));
    },

    onPointerMove(e) {
      trackHover(e);
      const a = active;
      if (!a) return;
      for (const raw of samplePoints(e)) paint(a, a.stroke.move(a.axis.apply(raw, e.shiftKey, a.stroke.position)));
    },

    onPointerUp(e) {
      trackHover(e);
      if (active) finish(e);
    },

    onHover(e) {
      trackHover(e);
    },

    onKeyDown(e) {
      if (e.key === 'Escape' && active) {
        finish(undefined, true);
        return true;
      }
      return handleBrushKeys(spec.id, e, { size: 'size', hardness: 'hardness', digits: digitKey(spec.kind) });
    },

    renderOverlay(ctx) {
      if (!activeSession()) return;
      drawBrushOutline(ctx, { size: opts().size });
    },
  };
}

export const retouchTools: ToolDef[] = [
  createRetouchTool({ id: 'blur-brush', name: 'Blur', label: 'Blur Tool', kind: 'blur', icon: Droplet, group: 'blur', order: 110, shortcut: 'R' }),
  createRetouchTool({ id: 'sharpen-brush', name: 'Sharpen', label: 'Sharpen Tool', kind: 'sharpen', icon: Triangle, group: 'blur', order: 110, shortcut: 'R' }),
  createRetouchTool({ id: 'smudge', name: 'Smudge', label: 'Smudge Tool', kind: 'smudge', icon: Pointer, group: 'blur', order: 110, shortcut: 'R' }),
  createRetouchTool({ id: 'dodge', name: 'Dodge', label: 'Dodge Tool', kind: 'dodge', icon: SunDim, group: 'dodge', order: 120, shortcut: 'O' }),
  createRetouchTool({ id: 'burn', name: 'Burn', label: 'Burn Tool', kind: 'burn', icon: Flame, group: 'dodge', order: 120, shortcut: 'O' }),
  createRetouchTool({ id: 'sponge', name: 'Sponge', label: 'Sponge Tool', kind: 'sponge', icon: CircleDashed, group: 'dodge', order: 120, shortcut: 'O' }),
];
