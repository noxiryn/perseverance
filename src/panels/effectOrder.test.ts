import { describe, expect, it } from 'vitest';
import type { LayerEffect } from '../core/types';
import { bucketKey, drawOrder, reorderTarget, type EffectPlacement } from './effectOrder';

/** Placement table mirroring the renderer's effects (stage + order per type). */
const PLACE: Record<string, EffectPlacement> = {
  'long-shadow': { stage: 'behind', order: 5 },
  'drop-shadow': { stage: 'behind', order: 10 },
  'outer-glow': { stage: 'behind', order: 20 },
  'color-overlay': { stage: 'above', order: 30 },
  stroke: { stage: 'behind', order: 80 }, // outside stroke
  'stroke-inside': { stage: 'above', order: 80 },
  bevel: { stage: 'above', order: 70 },
};
const placeOf = (e: LayerEffect) => PLACE[e.effectId];
const fx = (id: string, effectId: string): LayerEffect => ({ id, effectId, enabled: true, params: {} });

/** Simulate layerOps.moveEffect (splice out, splice in at the clamped target). */
function move(list: LayerEffect[], from: number, to: number): LayerEffect[] {
  const out = [...list];
  const [e] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, e);
  return out;
}

const ids = (list: { fx: LayerEffect }[] | LayerEffect[]) => list.map((x) => ('fx' in x ? x.fx.id : x.id));

describe('drawOrder', () => {
  it('draws behind effects first, by type order, then above effects', () => {
    const list = [fx('st', 'stroke'), fx('ds', 'drop-shadow'), fx('bv', 'bevel'), fx('co', 'color-overlay'), fx('ls', 'long-shadow')];
    expect(ids(drawOrder(list, placeOf))).toEqual(['ls', 'ds', 'st', 'co', 'bv']);
  });

  it('orders instances of the same type by array index', () => {
    const list = [fx('s1', 'stroke'), fx('ds', 'drop-shadow'), fx('s2', 'stroke')];
    expect(ids(drawOrder(list, placeOf))).toEqual(['ds', 's1', 's2']);
  });

  it('keeps the array index and bucket on each entry', () => {
    const [first] = drawOrder([fx('a', 'bevel'), fx('b', 'drop-shadow')], placeOf);
    expect(first.index).toBe(1);
    expect(first.bucket).toBe(bucketKey(PLACE['drop-shadow']));
  });
});

describe('reorderTarget', () => {
  const list = [fx('s1', 'stroke'), fx('ds', 'drop-shadow'), fx('s2', 'stroke')];

  it('rejects moves between different effect types (no visible change)', () => {
    expect(reorderTarget(list, placeOf, 0, 1, 'above')).toBeNull();
    expect(reorderTarget(list, placeOf, 1, 2, 'below')).toBeNull();
  });

  it('rejects moves that keep the same drawing order', () => {
    expect(reorderTarget(list, placeOf, 0, 0, 'above')).toBeNull();
    // s2 is already drawn above s1.
    expect(reorderTarget(list, placeOf, 2, 0, 'above')).toBeNull();
    expect(reorderTarget(list, placeOf, 0, 2, 'below')).toBeNull();
  });

  it('moves an effect above another of the same type', () => {
    const to = reorderTarget(list, placeOf, 0, 2, 'above');
    expect(to).not.toBeNull();
    const next = move(list, 0, to!);
    expect(ids(drawOrder(next, placeOf))).toEqual(['ds', 's2', 's1']);
  });

  it('moves an effect below another of the same type', () => {
    const to = reorderTarget(list, placeOf, 2, 0, 'below');
    expect(to).not.toBeNull();
    const next = move(list, 2, to!);
    expect(ids(drawOrder(next, placeOf))).toEqual(['ds', 's2', 's1']);
  });

  it('works with three instances', () => {
    const three = [fx('a', 'stroke'), fx('b', 'stroke'), fx('c', 'stroke')];
    // Put a between b and c (drawn above b).
    const to = reorderTarget(three, placeOf, 0, 1, 'above');
    expect(ids(move(three, 0, to!))).toEqual(['b', 'a', 'c']);
    // Put c at the very bottom (below a).
    const to2 = reorderTarget(three, placeOf, 2, 0, 'below');
    expect(ids(move(three, 2, to2!))).toEqual(['c', 'a', 'b']);
  });

  it('treats inside and outside strokes as different buckets', () => {
    const mixed = [fx('out', 'stroke'), fx('in', 'stroke-inside')];
    expect(reorderTarget(mixed, placeOf, 0, 1, 'above')).toBeNull();
  });
});
