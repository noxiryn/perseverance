import { describe, expect, it } from 'vitest';
import type { Gradient, LayerEffect } from '../core/types';
import { effectsFromPsd, effectsToPsd, fillFromPsd, fillToPsd, fromPsdColor, fromPsdGradient, toPsdGradient } from './psdEffects';

const fx = (effectId: string, params: LayerEffect['params'], enabled = true): LayerEffect => ({ id: `e_${effectId}`, effectId, enabled, params });

/** Our → PSD → our, ignoring generated ids. */
const roundTrip = (list: LayerEffect[]) =>
  effectsFromPsd(effectsToPsd(list).info).map((e) => ({ effectId: e.effectId, enabled: e.enabled, params: e.params }));

describe('psd layer effects', () => {
  it('round-trips shadows, glows, bevel, satin, overlays and strokes', () => {
    const list: LayerEffect[] = [
      fx('drop-shadow', { color: '#102030', blendMode: 'multiply', opacity: 0.6, angle: 135, distance: 14, spread: 0.25, size: 20 }),
      fx('inner-shadow', { color: '#000000', blendMode: 'normal', opacity: 0.5, angle: -45, distance: 3, choke: 0.1, size: 6 }, false),
      fx('outer-glow', { color: '#ffcc00', blendMode: 'screen', opacity: 0.8, spread: 0.2, size: 30 }),
      fx('inner-glow', { color: '#ffffff', blendMode: 'overlay', opacity: 0.4, choke: 0, size: 12, source: 'center' }),
      fx('bevel', { style: 'emboss', depth: 2.5, size: 9, soften: 2, angle: 110, altitude: 40, highlightColor: '#ffffee', highlightOpacity: 0.7, shadowColor: '#220000', shadowOpacity: 0.6 }),
      fx('satin', { color: '#333333', blendMode: 'multiply', opacity: 0.45, angle: 19, distance: 11, size: 14, invert: false }),
      fx('color-overlay', { color: '#c4141c', blendMode: 'color', opacity: 0.9 }),
      fx('stroke', { size: 6, position: 'inside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#ffffff' }),
      fx('stroke', { size: 3, position: 'outside', blendMode: 'normal', opacity: 0.5, fillType: 'color', color: '#000000' }),
    ];
    const back = roundTrip(list);
    const byId = (id: string) => back.filter((e) => e.effectId === id);
    expect(back).toHaveLength(list.length);
    expect(byId('drop-shadow')[0].params).toEqual(list[0].params);
    expect(byId('inner-shadow')[0]).toEqual({ effectId: 'inner-shadow', enabled: false, params: list[1].params });
    expect(byId('outer-glow')[0].params).toEqual(list[2].params);
    expect(byId('inner-glow')[0].params).toEqual(list[3].params);
    expect(byId('bevel')[0].params).toEqual(list[4].params);
    expect(byId('satin')[0].params).toEqual(list[5].params);
    expect(byId('color-overlay')[0].params).toEqual(list[6].params);
    expect(byId('stroke').map((s) => s.params)).toEqual([list[7].params, list[8].params]);
  });

  it('writes Photoshop units (percent spread, pixel sizes, no global light)', () => {
    const { info } = effectsToPsd([fx('drop-shadow', { spread: 0.3, size: 12, distance: 10, angle: 120, opacity: 0.75 })]);
    const ds = info!.dropShadow![0];
    expect(ds.choke).toEqual({ units: 'Pixels', value: 30 });
    expect(ds.size).toEqual({ units: 'Pixels', value: 12 });
    expect(ds.useGlobalLight).toBe(false);
    expect(ds.color).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('reports enabled effects without a Photoshop equivalent and extra singleton instances', () => {
    const r = effectsToPsd([
      fx('long-shadow', { length: 60 }),
      fx('pattern-overlay', {}, false),
      fx('outer-glow', { size: 10 }),
      fx('outer-glow', { size: 20 }),
    ]);
    expect(r.unsupported.map((e) => e.effectId)).toEqual(['long-shadow', 'outer-glow']);
    expect(r.info?.outerGlow?.size).toEqual({ units: 'Pixels', value: 10 });
    expect(effectsToPsd([]).info).toBeUndefined();
  });

  it('converts gradient overlays (angle sign flip, alpha ↔ opacity stops)', () => {
    const g: Gradient = {
      kind: 'radial',
      angle: 90,
      scale: 1,
      reverse: true,
      stops: [
        { offset: 0, color: '#ff000080' },
        { offset: 1, color: '#0000ff' },
      ],
    };
    const { info } = effectsToPsd([fx('gradient-overlay', { gradient: g, blendMode: 'overlay', opacity: 0.7, angle: 30, scale: 1.2 })]);
    const go = info!.gradientOverlay![0];
    expect(go.angle).toBe(-30);
    expect(go.type).toBe('radial');
    expect(go.blendMode).toBe('overlay');
    const back = effectsFromPsd(info)[0];
    expect(back.params.angle).toBe(30);
    expect(back.params.scale).toBe(1.2);
    const bg = back.params.gradient as Gradient;
    expect(bg.kind).toBe('radial');
    expect(bg.reverse).toBe(true);
    expect(bg.stops).toEqual([
      { offset: 0, color: '#ff000080' },
      { offset: 1, color: '#0000ff' },
    ]);
  });

  it('merges separate color and opacity stops', () => {
    const g = fromPsdGradient({
      type: 'solid',
      colorStops: [
        { color: { r: 0, g: 0, b: 0 }, location: 0, midpoint: 0.5 },
        { color: { r: 255, g: 255, b: 255 }, location: 1, midpoint: 0.5 },
      ],
      opacityStops: [
        { opacity: 1, location: 0, midpoint: 0.5 },
        { opacity: 0, location: 0.5, midpoint: 0.5 },
      ],
    });
    expect(g.stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
    expect(g.stops[1].color).toBe('#80808000');
    expect(g.stops[2].color).toBe('#ffffff00');
    expect(toPsdGradient(g).opacityStops.map((s) => s.opacity)).toEqual([1, 0, 0]);
  });

  it('reads every Photoshop color model', () => {
    expect(fromPsdColor({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
    expect(fromPsdColor({ fr: 1, fg: 0, fb: 0.5 })).toBe('#ff0080');
    expect(fromPsdColor({ k: 0 })).toBe('#ffffff');
    expect(fromPsdColor({ c: 0, m: 100, y: 100, k: 0 })).toBe('#ff0000');
    expect(fromPsdColor({ h: 1 / 3, s: 100, b: 100 })).toBe('#00ff00');
    expect(fromPsdColor(undefined, '#123456')).toBe('#123456');
  });

  it('ignores a switched-off style and unknown effect ids', () => {
    const { info } = effectsToPsd([fx('drop-shadow', {}), fx('stroke', { size: 2 })]);
    expect(effectsFromPsd({ ...info!, disabled: true })).toEqual([]);
    expect(effectsFromPsd(info, (id) => id !== 'stroke').map((e) => e.effectId)).toEqual(['drop-shadow']);
  });

  it('round-trips solid and gradient fill layers; patterns stay pixels', () => {
    expect(fillFromPsd(fillToPsd({ type: 'solid', color: '#c4141c' })!)).toEqual({ type: 'solid', color: '#c4141c' });
    const g: Gradient = { kind: 'reflected', angle: 45, scale: 0.8, reverse: false, stops: [{ offset: 0, color: '#000000' }, { offset: 0.6, color: '#ff8800' }] };
    const back = fillFromPsd(fillToPsd({ type: 'gradient', gradient: g })!);
    expect(back).toEqual({ type: 'gradient', gradient: g });
    expect(fillToPsd({ type: 'pattern', assetId: 'paper-texture', scale: 1 })).toBeNull();
    expect(fillFromPsd(undefined)).toBeNull();
  });
});
