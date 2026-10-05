import { describe, expect, it } from 'vitest';
import { STYLE_PRESETS, adaptPresetToFill, paintLuminance } from './effectPresets';

const preset = (id: string) => STYLE_PRESETS.find((p) => p.id === id)!;

describe('colour-aware style presets', () => {
  it('gives a black title a white outline so the long shadow stays separate', () => {
    const { effects, changes } = adaptPresetToFill(preset('long-shadow-title').effects, paintLuminance({ type: 'solid', color: '#0b0b0b' }));
    expect(effects.find((e) => e.effectId === 'stroke')?.params.color).toBe('#ffffff');
    // The shadow keeps its colour: the white outline already separates it from the text.
    expect(effects.find((e) => e.effectId === 'long-shadow')?.params.color).toBe('#000000');
    expect(changes).toEqual(['outline → white']);
  });

  it('keeps preset colours that already contrast with the fill', () => {
    const { effects, changes } = adaptPresetToFill(preset('long-shadow-title').effects, paintLuminance({ type: 'solid', color: '#f2b84b' }));
    expect(effects.find((e) => e.effectId === 'stroke')?.params.color).toBe('#000000');
    expect(changes).toEqual([]);
  });

  it('turns a white outline black on white text', () => {
    const { effects } = adaptPresetToFill(preset('white-outline-shadow').effects, 1);
    expect(effects.find((e) => e.effectId === 'stroke')?.params.color).toBe('#000000');
  });

  it('lifts a long shadow that would merge with the fill when nothing separates them', () => {
    const { effects, changes } = adaptPresetToFill([{ effectId: 'long-shadow', params: { color: '#000000', length: 90 } }], 0.02);
    expect(effects[0].params.color).toBe('#8c8c8c');
    expect(changes).toEqual(['long shadow → mid tone']);
  });

  it('leaves layers without a single fill colour alone and never mutates the preset', () => {
    const src = preset('thick-black-stroke').effects;
    expect(adaptPresetToFill(src, null).changes).toEqual([]);
    adaptPresetToFill(src, 0);
    expect(src[0].params.color).toBe('#000000');
  });

  it('measures gradient fills by their stops', () => {
    const l = paintLuminance({ type: 'gradient', gradient: { kind: 'linear', angle: 0, scale: 1, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } });
    expect(l).toBeCloseTo(0.5, 2);
  });
});
