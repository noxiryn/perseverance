/**
 * Rectangular & Elliptical Marquee tools (M). Drag to select; Shift = square / add, Alt = from
 * center / subtract, Shift+Alt = intersect; Space while dragging repositions; fixed ratio/size
 * styles; feather + anti-alias; drag inside a selection moves its outline; click deselects.
 */
import { Circle, SquareDashed } from 'lucide-react';
import type { Document, Point, Rect } from '../../core/types';
import { rectIntersect } from '../../core/geometry';
import { latchModifiers, marqueeRect } from '../math/marquee';
import type { ToolDef, ToolPointerEvent } from '../../registry';
import { ellipseMask, rectMask, type SelectionMode } from '../../editor/selection';
import { viewport } from '../../editor/viewport';
import { activeSession, toolOptions, useToolOptions } from '../../state/editor';
import { Checkbox, NumberField, Select, IconButton } from '../../ui/controls';
import { ArrowRightLeft } from 'lucide-react';
import { clearSmartGuides, collectSnapTargets, snapPoint, type SnapTargets } from '../snap';
import { shapeInsideCanvas, strokeAnts } from '../outline';
import { drawLabel } from '../draw';
import { fmtPx, isTemporarilySuspended, vpState } from '../state';
import {
  beginOutlineDrag,
  commitOutlineDrag,
  commitSelectionMask,
  drawOutlineDrag,
  hardenMask,
  modeFromEvent,
  pointInSelection,
  updateOutlineDrag,
  endOutlineDragVisual,
  handleSelectionNudgeKey,
  type OutlineDrag,
} from './selectCommon';
import { deselect } from '../../editor/selection';
import { Label, SelectionModeButtons, Sep, setToolOptionSafe } from '../options/common';

export const MARQUEE_DEFAULTS = {
  mode: 'new' as SelectionMode,
  feather: 0,
  style: 'normal' as 'normal' | 'ratio' | 'size',
  width: 1,
  height: 1,
  antiAlias: true,
};

interface MarqueeDrag {
  a: Point;
  b: Point;
  mode: SelectionMode;
  moved: boolean;
  screen0: Point;
  targets: SnapTargets | null;
  shift: boolean;
  alt: boolean;
  /**
   * Shift/Alt held at mouse-down chose the selection mode (add/subtract) — they only start
   * constraining (square / from center) after being released and pressed again (Photoshop).
   */
  shiftLatch: boolean;
  altLatch: boolean;
  /** Space-drag repositioning: last pointer position. */
  spaceLast: Point | null;
}

const docRect = (doc: Document): Rect => ({ x: 0, y: 0, width: doc.width, height: doc.height });

/** Update the constrain modifiers of a drag from the current key state. */
const applyModifiers = (d: MarqueeDrag, shiftKey: boolean, altKey: boolean) => latchModifiers(d, shiftKey, altKey);

function makeMarquee(kind: 'rect' | 'ellipse'): ToolDef {
  const id = kind === 'rect' ? 'marquee-rect' : 'marquee-ellipse';
  let drag: MarqueeDrag | null = null;
  let outline: OutlineDrag | null = null;

  const currentRect = (d: MarqueeDrag): Rect => {
    const o = toolOptions(id, MARQUEE_DEFAULTS);
    let r = marqueeRect(d.a, d.b, { shift: d.shift, alt: d.alt, style: o.style, width: o.width, height: o.height });
    if (kind === 'rect') {
      // pixel aligned
      const x0 = Math.round(r.x);
      const y0 = Math.round(r.y);
      const x1 = Math.round(r.x + r.width);
      const y1 = Math.round(r.y + r.height);
      r = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    return r;
  };

  const onPointerDown = (e: ToolPointerEvent) => {
    const s = activeSession();
    if (!s || e.button !== 0) return;
    const o = toolOptions(id, MARQUEE_DEFAULTS);
    const mode = modeFromEvent(e, o.mode);
    if (mode === 'new' && o.mode === 'new' && o.style !== 'size' && pointInSelection(s.doc, e.docX, e.docY)) {
      outline = beginOutlineDrag(e);
      return;
    }
    const targets = collectSnapTargets(s.doc);
    let a = { x: e.docX, y: e.docY };
    const sp = snapPoint(a, { targets });
    a = { x: sp.x, y: sp.y };
    // With an existing selection, modifiers held at mouse-down pick add/subtract/intersect.
    const hadSelection = !!s.doc.selection;
    drag = {
      a,
      b: a,
      mode,
      moved: o.style === 'size',
      screen0: { x: e.screenX, y: e.screenY },
      targets,
      shift: false,
      alt: false,
      shiftLatch: e.shiftKey && hadSelection,
      altLatch: e.altKey && hadSelection && o.style !== 'size',
      spaceLast: null,
    };
    applyModifiers(drag, e.shiftKey, e.altKey);
    viewport.requestOverlay();
  };

  const onPointerMove = (e: ToolPointerEvent) => {
    if (outline) {
      updateOutlineDrag(outline, e);
      return;
    }
    const d = drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.screenX - d.screen0.x, e.screenY - d.screen0.y) < 3) return;
    d.moved = true;
    let b = { x: e.docX, y: e.docY };
    if (vpState.spaceHeld) {
      // reposition the whole marquee while Space is held
      if (d.spaceLast) {
        const dx = b.x - d.spaceLast.x;
        const dy = b.y - d.spaceLast.y;
        d.a = { x: d.a.x + dx, y: d.a.y + dy };
        d.b = { x: d.b.x + dx, y: d.b.y + dy };
      }
      d.spaceLast = b;
      viewport.requestOverlay();
      return;
    }
    d.spaceLast = null;
    if (d.targets) {
      const sp = snapPoint(b, { targets: d.targets });
      b = { x: sp.x, y: sp.y };
    }
    d.b = b;
    applyModifiers(d, e.shiftKey, e.altKey);
    viewport.requestOverlay();
  };

  const onPointerUp = () => {
    clearSmartGuides();
    vpState.spaceHeld = false;
    if (outline) {
      const o = outline;
      outline = null;
      if (!commitOutlineDrag(o)) {
        // a click inside the selection without dragging deselects (Photoshop behaviour)
        deselect();
      }
      viewport.requestOverlay();
      return;
    }
    const d = drag;
    drag = null;
    viewport.requestOverlay();
    const s = activeSession();
    if (!d || !s) return;
    const r = currentRect(d);
    // The selection never extends past the canvas: clip the marquee to it.
    const clipped = r.width >= 1 && r.height >= 1 ? rectIntersect(r, docRect(s.doc)) : null;
    if (!d.moved || !clipped || clipped.width < 1 || clipped.height < 1) {
      if (d.mode === 'new') deselect();
      return;
    }
    const o = toolOptions(id, MARQUEE_DEFAULTS);
    let mask = kind === 'rect' ? rectMask(s.doc, clipped) : ellipseMask(s.doc, r);
    if (kind === 'ellipse' && !o.antiAlias) mask = hardenMask(mask);
    // The vector shape must describe the (clipped) mask exactly: a rect is clipped with it; an
    // ellipse reaching past the canvas edge is no longer an ellipse, so it is stored as a plain mask.
    const shape: Rect | null = kind === 'rect' ? clipped : shapeInsideCanvas({ type: 'ellipse', rect: r }, s.doc.width, s.doc.height) ? r : null;
    commitSelectionMask(s.doc, mask, d.mode, kind === 'rect' ? 'Rectangular Marquee' : 'Elliptical Marquee', {
      feather: o.feather,
      shape: shape ? { type: kind, rect: shape } : null,
    });
  };

  const renderOverlay = (ctx: CanvasRenderingContext2D) => {
    if (outline) {
      drawOutlineDrag(ctx, outline);
      return;
    }
    const d = drag;
    const doc = activeSession()?.doc;
    if (!d || !d.moved || !doc) return;
    const full = currentRect(d);
    // Preview exactly what will be selected: the marquee clipped to the canvas.
    const r = kind === 'rect' ? rectIntersect(full, docRect(doc)) : full;
    if (r) {
      const p0 = viewport.docToScreen({ x: r.x, y: r.y });
      const p1 = viewport.docToScreen({ x: r.x + r.width, y: r.y + r.height });
      const path = new Path2D();
      ctx.save();
      if (kind === 'rect') {
        const x0 = Math.round(p0.x) + 0.5;
        const y0 = Math.round(p0.y) + 0.5;
        path.rect(x0, y0, Math.round(p1.x) - Math.round(p0.x), Math.round(p1.y) - Math.round(p0.y));
      } else {
        const c0 = viewport.docToScreen({ x: 0, y: 0 });
        const c1 = viewport.docToScreen({ x: doc.width, y: doc.height });
        ctx.beginPath();
        ctx.rect(Math.round(c0.x), Math.round(c0.y), Math.round(c1.x) - Math.round(c0.x) + 1, Math.round(c1.y) - Math.round(c0.y) + 1);
        ctx.clip();
        path.ellipse((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, Math.abs(p1.x - p0.x) / 2, Math.abs(p1.y - p0.y) / 2, 0, 0, Math.PI * 2);
      }
      strokeAnts(ctx, path);
      ctx.restore();
    }
    const size = r ?? { width: 0, height: 0 };
    drawLabel(ctx, [`W: ${fmtPx(size.width)} px`, `H: ${fmtPx(size.height)} px`], viewport.docToScreen(d.b));
  };

  const onDeactivate = () => {
    if (isTemporarilySuspended(id)) return;
    drag = null;
    outline = null;
    vpState.spaceHeld = false;
    endOutlineDragVisual();
    clearSmartGuides();
  };

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (drag && e.code === 'Space') {
      // Space while dragging repositions the marquee (instead of the temporary Hand tool).
      vpState.spaceHeld = true;
      return true;
    }
    if (drag && (e.key === 'Shift' || e.key === 'Alt')) {
      // Constrain / from-center react immediately, without waiting for the next mouse move.
      applyModifiers(drag, e.shiftKey, e.altKey);
      viewport.requestOverlay();
      return true;
    }
    if (e.key === 'Escape' && (drag || outline)) {
      drag = null;
      outline = null;
      vpState.spaceHeld = false;
      endOutlineDragVisual();
      clearSmartGuides();
      viewport.requestOverlay();
      return true;
    }
    if (!drag && !outline) return handleSelectionNudgeKey(e);
    return false;
  };

  const onKeyUp = (e: KeyboardEvent): boolean => {
    if (e.code === 'Space' && vpState.spaceHeld) {
      vpState.spaceHeld = false;
      if (drag) drag.spaceLast = null;
      return true;
    }
    if (drag && (e.key === 'Shift' || e.key === 'Alt')) {
      applyModifiers(drag, e.shiftKey, e.altKey);
      viewport.requestOverlay();
      return true;
    }
    return false;
  };

  const onHover = (e: ToolPointerEvent) => {
    const s = activeSession();
    const o = toolOptions(id, MARQUEE_DEFAULTS);
    const mode = modeFromEvent(e, o.mode);
    const inside = s && mode === 'new' && o.mode === 'new' && o.style !== 'size' && pointInSelection(s.doc, e.docX, e.docY);
    viewport.setCursor(inside ? 'move' : null);
  };

  return {
    id,
    name: kind === 'rect' ? 'Rectangular Marquee Tool' : 'Elliptical Marquee Tool',
    shortcut: 'M',
    icon: kind === 'rect' ? SquareDashed : Circle,
    group: 'marquee',
    order: 20,
    cursor: 'crosshair',
    OptionsBar: () => <MarqueeOptions id={id} ellipse={kind === 'ellipse'} />,
    defaultOptions: { ...MARQUEE_DEFAULTS },
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onHover,
    onKeyDown,
    onKeyUp,
    onDeactivate,
    renderOverlay,
  };
}

function MarqueeOptions({ id, ellipse }: { id: string; ellipse: boolean }) {
  const o = useToolOptions(id, MARQUEE_DEFAULTS);
  return (
    <div className="viewport-opts">
      <SelectionModeButtons toolId={id} value={o.mode} />
      <Sep />
      <NumberField scrubLabel="Feather" value={o.feather} min={0} max={250} step={1} unit="px" width={56} onChange={(v) => setToolOptionSafe(id, 'feather', v)} />
      <Checkbox
        checked={ellipse ? o.antiAlias : true}
        disabled={!ellipse}
        onChange={(v) => setToolOptionSafe(id, 'antiAlias', v)}
        label="Anti-alias"
        title={ellipse ? 'Smooth the curved edge of the selection' : 'Rectangular selections are pixel-aligned (always crisp)'}
      />
      <Sep />
      <Label>Style</Label>
      <Select
        value={o.style}
        width={104}
        options={[
          { value: 'normal', label: 'Normal' },
          { value: 'ratio', label: 'Fixed Ratio' },
          { value: 'size', label: 'Fixed Size' },
        ]}
        onChange={(v) => {
          setToolOptionSafe(id, 'style', v);
          if (v === 'size' && o.width <= 1 && o.height <= 1) {
            setToolOptionSafe(id, 'width', 512);
            setToolOptionSafe(id, 'height', 512);
          }
        }}
      />
      {o.style !== 'normal' && (
        <>
          <NumberField scrubLabel="W" value={o.width} min={o.style === 'size' ? 1 : 0.01} max={30000} step={o.style === 'size' ? 1 : 0.01} unit={o.style === 'size' ? 'px' : undefined} width={60} onChange={(v) => setToolOptionSafe(id, 'width', v)} />
          <IconButton
            icon={ArrowRightLeft}
            size="sm"
            title="Swap width and height"
            onClick={() => {
              setToolOptionSafe(id, 'width', o.height);
              setToolOptionSafe(id, 'height', o.width);
            }}
          />
          <NumberField scrubLabel="H" value={o.height} min={o.style === 'size' ? 1 : 0.01} max={30000} step={o.style === 'size' ? 1 : 0.01} unit={o.style === 'size' ? 'px' : undefined} width={60} onChange={(v) => setToolOptionSafe(id, 'height', v)} />
        </>
      )}
    </div>
  );
}

export const marqueeRectTool = makeMarquee('rect');
export const marqueeEllipseTool = makeMarquee('ellipse');
