import { describe, expect, it } from 'vitest';
import { makeShapeLayer } from '../../core/document';
import { clickBox, dragBox, lineGeometry } from './geometry';
import {
  applyOptionToShape,
  boxForAspect,
  swapShapePath,
  dashFor,
  dashPresetOf,
  fillFromOptions,
  keyAppliesToKind,
  optionsFromShape,
  shapeDefaults,
  strokeFromOptions,
} from './options';

describe('shape drag geometry', () => {
  it('spans the drag box in any direction', () => {
    expect(dragBox({ x0: 10, y0: 20, x1: 110, y1: 70, shift: false, alt: false })).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(dragBox({ x0: 110, y0: 70, x1: 10, y1: 20, shift: false, alt: false })).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });

  it('constrains proportions with Shift (custom aspect) and draws from the center with Alt', () => {
    expect(dragBox({ x0: 0, y0: 0, x1: 100, y1: 40, shift: true, alt: false })).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    const b = dragBox({ x0: 0, y0: 0, x1: -30, y1: 100, shift: true, alt: false, aspect: 2 });
    expect(b.w / b.h).toBeCloseTo(2);
    expect(b.x).toBeLessThan(0);
    expect(dragBox({ x0: 50, y0: 50, x1: 70, y1: 60, shift: false, alt: true })).toEqual({ x: 30, y: 40, w: 40, h: 20 });
  });

  it('snaps lines to 45° with Shift and flips for rising lines', () => {
    const g = lineGeometry({ x0: 0, y0: 0, x1: 100, y1: 10, shift: true, alt: false });
    // Exactly horizontal: 0 height, box on the line itself (drawn perfectly on-axis).
    expect(g.h).toBe(0);
    expect(g.y).toBe(0);
    expect(g.w).toBeCloseTo(Math.hypot(100, 10));
    expect(g.p1.y).toBeCloseTo(0);
    const v = lineGeometry({ x0: 50, y0: 10, x1: 52, y1: 210, shift: true, alt: false });
    expect(v.w).toBe(0);
    expect(v.x).toBe(50);
    expect(v.flipX).toBe(false);
    const up = lineGeometry({ x0: 0, y0: 100, x1: 100, y1: 0, shift: false, alt: false });
    expect(up.flipX).toBe(true);
    const down = lineGeometry({ x0: 0, y0: 0, x1: 100, y1: 100, shift: false, alt: false });
    expect(down.flipX).toBe(false);
    const c = lineGeometry({ x0: 50, y0: 50, x1: 80, y1: 50, shift: false, alt: true });
    expect(c.p0.x).toBe(20);
    expect(c.w).toBe(60);
  });

  it('centers click boxes', () => {
    expect(clickBox(100, 100, 50)).toEqual({ x: 75, y: 75, w: 50, h: 50 });
    const wide = clickBox(0, 0, 100, 2);
    expect(wide.w).toBe(100);
    expect(wide.h).toBe(50);
  });
});

describe('shape options ↔ props', () => {
  it('derives fill and stroke paints', () => {
    const o = shapeDefaults('shape-rect');
    expect(fillFromOptions(o, '#111111', '#eeeeee')).toEqual({ type: 'solid', color: '#111111' });
    expect(fillFromOptions({ ...o, fillMode: 'none' }, '#111111', '#eeeeee')).toBeNull();
    const g = fillFromOptions({ ...o, fillMode: 'gradient' }, '#111111', '#eeeeee');
    expect(g?.type).toBe('gradient');
    expect(strokeFromOptions(o)).toBeNull();
    const s = strokeFromOptions({ ...o, strokeOn: true, strokeWidth: 5, strokeDash: 'dotted', strokeColor: '#ff0000' });
    expect(s).toMatchObject({ width: 5, align: 'outside', dash: [0, 2], cap: 'round', paint: { type: 'solid', color: '#ff0000' } });
  });

  it('recognizes dash presets', () => {
    for (const d of ['solid', 'dashed', 'dotted'] as const) {
      expect(dashPresetOf({ paint: { type: 'solid', color: '#000' }, width: 2, align: 'center', ...dashFor(d) })).toBe(d);
    }
    expect(dashPresetOf(null)).toBe('solid');
  });

  it('applies only the keys relevant to a shape kind', () => {
    expect(keyAppliesToKind('cornerRadius', 'ellipse')).toBe(false);
    expect(keyAppliesToKind('innerRatio', 'star')).toBe(true);
    expect(keyAppliesToKind('strokeWidth', 'path')).toBe(true);
    const layer = makeShapeLayer({ shape: { kind: 'ellipse', cornerRadius: 0 } });
    const o = { ...shapeDefaults('shape-rect'), cornerRadius: 30 };
    applyOptionToShape(layer, 'cornerRadius', o, '#000', '#fff');
    expect(layer.shape.cornerRadius).toBe(0);
    const star = makeShapeLayer({ shape: { kind: 'star', sides: 5 } });
    applyOptionToShape(star, 'sides', { ...o, sides: 1 }, '#000', '#fff');
    expect(star.shape.sides).toBe(2);
  });

  it('turns the stroke on and sets its width in one merged change', () => {
    const layer = makeShapeLayer({ shape: { kind: 'rect', stroke: null } });
    const view = { ...shapeDefaults('shape-rect'), strokeOn: false };
    const next = { ...view, strokeOn: true, strokeWidth: 12 };
    for (const k of ['strokeWidth', 'strokeOn'] as const) applyOptionToShape(layer, k, next, '#000', '#fff');
    expect(layer.shape.stroke).toMatchObject({ width: 12, align: 'outside' });
  });

  it('keeps joins/caps of an existing stroke when only the width changes', () => {
    const existing = { paint: { type: 'solid' as const, color: '#123456' }, width: 3, align: 'center' as const, join: 'round' as CanvasLineJoin, cap: 'round' as CanvasLineCap };
    const o = { ...shapeDefaults('shape-rect'), strokeOn: true, strokeWidth: 9, strokeAlign: 'center' as const, strokeColor: '#123456', strokeDash: 'solid' as const };
    expect(strokeFromOptions(o, existing)).toMatchObject({ width: 9, join: 'round', cap: 'round' });
    // A different dash preset applies that preset's caps/joins.
    expect(strokeFromOptions({ ...o, strokeDash: 'dashed' }, existing)).toMatchObject({ dash: [3, 2], cap: 'butt', join: 'miter' });
  });

  it('gives a swapped custom shape the new proportions around the same center', () => {
    expect(boxForAspect(200, 300, 100, 100)).toEqual({ w: Math.sqrt(60000), h: Math.sqrt(60000) });
    expect(boxForAspect(200, 100, 200, 100)).toEqual({ w: 200, h: 100 });
    // Area is kept: switching back returns the original box.
    const a = boxForAspect(200, 300, 100, 100);
    const b = boxForAspect(a.w, a.h, 200, 300);
    expect(b.w).toBeCloseTo(200);
    expect(b.h).toBeCloseTo(300);

    const l = makeShapeLayer({ shape: { kind: 'path', width: 200, height: 300, path: 'M0 0H10V10Z', viewBox: [0, 0, 10, 10] } });
    l.transform = { ...l.transform, x: 100, y: 50, rotation: 30 };
    swapShapePath(l, 'M0 0H20V10Z', [0, 0, 20, 10], 'wide');
    expect(l.shape.presetId).toBe('wide');
    expect(l.shape.width / l.shape.height).toBeCloseTo(2);
    expect(l.shape.width * l.shape.height).toBeCloseTo(60000);
    // Center unchanged (rotation pivots on the center).
    expect(l.transform.x + l.shape.width / 2).toBeCloseTo(100 + 100);
    expect(l.transform.y + l.shape.height / 2).toBeCloseTo(50 + 150);
  });

  it('reads tool options back from a shape', () => {
    const l = makeShapeLayer({ shape: { kind: 'rect', cornerRadius: 12, fill: null, stroke: { paint: { type: 'solid', color: '#00ff00' }, width: 7, align: 'inside', dash: [3, 2] } } });
    const o = optionsFromShape(l.shape);
    expect(o).toMatchObject({ fillMode: 'none', strokeOn: true, strokeColor: '#00ff00', strokeWidth: 7, strokeAlign: 'inside', strokeDash: 'dashed', cornerRadius: 12 });
  });
});
