import { describe, expect, it } from 'vitest';
import type { TextWarpStyle, Transform } from '../../core/types';
import { warpPoint } from '../../render/warpMath';
import { BUNDLED_FAMILIES } from '../../fonts/generated/faces';
import { DEFAULT_WORKSPACE } from '../../state/ui';
import { apply, invert, keepAnchor, layerMatrix, mul } from './affine';
import { inverseWarp } from './warpInverse';
import { caseMap, paragraphRangeAt, sanitizeTypedText, toDisplay, toSource, wordRangeAt } from './textIndex';
import {
  TYPE_DEFAULTS,
  autoLayerName,
  normalizeOptions,
  optionsFromText,
  optionsPatchFromTextPatch,
  parseWeightValue,
  textPropsFromOptions,
  weightChoices,
  weightLabel,
  weightValue,
} from './options';
import { TEXT_STYLES, getTextStyle, presetEffects } from './styles';
import { LOREM, loremForBox, loremWords } from './lorem';
import { isCharacterPanelOpen } from './panelState';

describe('caseMap (All Caps index mapping)', () => {
  it('is the identity without uppercase', () => {
    const m = caseMap('abc', false);
    expect(m.display).toBe('abc');
    expect([...m.srcToDisp]).toEqual([0, 1, 2, 3]);
    expect([...m.dispToSrc]).toEqual([0, 1, 2, 3]);
  });

  it('maps characters whose uppercase is longer (ß → SS)', () => {
    const m = caseMap('aßb', true);
    expect(m.display).toBe('ASSB');
    expect(m.display).toBe('aßb'.toUpperCase());
    expect(toDisplay(m, 0)).toBe(0);
    expect(toDisplay(m, 1)).toBe(1);
    expect(toDisplay(m, 2)).toBe(3);
    expect(toDisplay(m, 3)).toBe(4);
    expect(toSource(m, 2)).toBe(1); // inside the expansion → the source char
    expect(toSource(m, 3)).toBe(2);
    expect(toSource(m, 4)).toBe(3);
  });

  it('keeps surrogate pairs together and clamps out-of-range indices', () => {
    const s = 'a😀b';
    const m = caseMap(s, true);
    expect(m.display).toBe('A😀B');
    expect(toDisplay(m, 3)).toBe(3);
    expect(toDisplay(m, 99)).toBe(4);
    expect(toSource(m, -5)).toBe(0);
  });
});

describe('word / paragraph ranges', () => {
  const text = 'Hello, brave new world!\nSecond line';
  it('selects the word under the index', () => {
    expect(wordRangeAt(text, 2)).toEqual([0, 5]);
    expect(wordRangeAt(text, 9)).toEqual([7, 12]);
    // right after a word → that word
    expect(wordRangeAt(text, 12)[0]).toBeLessThanOrEqual(12);
    expect(text.slice(...wordRangeAt(text, 32))).toBe('line');
    expect(text.slice(...wordRangeAt(text, 30))).toBe(' ');
    expect(text.slice(...wordRangeAt(text, text.length))).toBe('line');
  });

  it('handles empty text and paragraphs', () => {
    expect(wordRangeAt('', 0)).toEqual([0, 0]);
    expect(paragraphRangeAt(text, 3)).toEqual([0, 23]);
    expect(text.slice(...paragraphRangeAt(text, 26))).toBe('Second line');
  });

  it('sanitizes typed text', () => {
    expect(sanitizeTypedText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(sanitizeTypedText('x\u0000y\u0007z\tw')).toBe('xyz\tw');
  });
});

describe('affine helpers', () => {
  const t: Transform = { x: 100, y: 50, scaleX: 2, scaleY: 1.5, rotation: 30, skewX: 10 };

  it('inverts the layer matrix', () => {
    const M = layerMatrix(t, 300, 120);
    const inv = invert(M)!;
    const id = mul(M, inv);
    expect(id[0]).toBeCloseTo(1);
    expect(id[1]).toBeCloseTo(0);
    expect(id[2]).toBeCloseTo(0);
    expect(id[3]).toBeCloseTo(1);
    expect(id[4]).toBeCloseTo(0);
    expect(id[5]).toBeCloseTo(0);
  });

  it('pivots on the box center', () => {
    const M = layerMatrix({ x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 90 }, 100, 40);
    const c = apply(M, { x: 50, y: 20 });
    expect(c.x).toBeCloseTo(60);
    expect(c.y).toBeCloseTo(40);
  });

  it('keeps an anchor fixed when the box size changes (rotated/scaled/skewed)', () => {
    const before = apply(layerMatrix(t, 300, 120), { x: 150, y: 90 });
    const pos = keepAnchor(t, 300, 120, { x: 150, y: 90 }, 420, 130, { x: 210, y: 95 });
    const after = apply(layerMatrix({ ...t, ...pos }, 420, 130), { x: 210, y: 95 });
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
});

describe('inverseWarp', () => {
  const styles: TextWarpStyle[] = ['arc', 'arch', 'bulge', 'flag', 'wave', 'rise', 'fisheye', 'squeeze'];
  it('round-trips points for every style', () => {
    const a = 300;
    const c = 60;
    for (const style of styles) {
      for (const bend of [-80, -30, 25, 70]) {
        for (const [h, v] of [
          [0, 0],
          [20, -15],
        ]) {
          const w = { style, bend, horizontal: h, vertical: v };
          for (const [x, y] of [
            [0, 0],
            [-250, -40],
            [180, 35],
            [290, -55],
          ]) {
            const [X, Y] = warpPoint(w, x, y, a, c);
            const [ix, iy] = inverseWarp(w, X, Y, a, c);
            expect(Math.abs(ix - x), `${style} ${bend} ${h}/${v} (${x},${y})`).toBeLessThan(0.05);
            expect(Math.abs(iy - y), `${style} ${bend} ${h}/${v} (${x},${y})`).toBeLessThan(0.05);
          }
        }
      }
    }
  });
});

describe('type tool options', () => {
  it('builds text props from options with the primary color', () => {
    const t = textPropsFromOptions({ ...TYPE_DEFAULTS, fontFamily: 'Cinzel', fontSize: 40, strokeOn: true, strokeWidth: 3, strokeColor: '#ff0000' }, '#123456', '#ffffff', 'Hi');
    expect(t.content).toBe('Hi');
    expect(t.fontFamily).toBe('Cinzel');
    expect(t.fill).toEqual({ type: 'solid', color: '#123456' });
    expect(t.stroke).toEqual({ color: '#ff0000', width: 3 });
    expect(t.boxWidth).toBeNull();
  });

  it('uses a gradient fill when chosen (deep-copied)', () => {
    const o = { ...TYPE_DEFAULTS, fillType: 'gradient' as const };
    const t = textPropsFromOptions(o, '#000000', '#ffffff');
    expect(t.fill.type).toBe('gradient');
    if (t.fill.type === 'gradient') {
      expect(t.fill.gradient.stops[0].color).toBe('#000000');
      expect(t.fill.gradient.stops[1].color).toBe('#ffffff');
    }
  });

  it('normalizes junk stored options', () => {
    const o = normalizeOptions({ fontSize: -5, fontWeight: Number.NaN, align: 'middle' as never, fontFamily: '  ', warp: null as never, scaleX: 0 });
    expect(o.fontSize).toBe(1);
    expect(o.fontWeight).toBe(400);
    expect(o.align).toBe('left');
    expect(o.fontFamily).toBe(TYPE_DEFAULTS.fontFamily);
    expect(o.warp.style).toBe('none');
    expect(o.scaleX).toBe(1);
  });

  it('mirrors text props into option patches (fill color excluded)', () => {
    const p = optionsPatchFromTextPatch({ fontSize: 22, stroke: null, fill: { type: 'solid', color: '#ff0000' }, uppercase: true });
    expect(p).toEqual({ fontSize: 22, uppercase: true, strokeOn: false, fillType: 'solid' });
    const t = textPropsFromOptions(TYPE_DEFAULTS, '#000000', '#ffffff');
    const back = optionsFromText({ ...t, stroke: { color: '#00ff00', width: 9 } });
    expect(back.strokeOn).toBe(true);
    expect(back.strokeWidth).toBe(9);
    expect(back.fontFamily).toBe(t.fontFamily);
  });

  it('lists weight/style choices and round-trips their values', () => {
    expect(weightChoices([700, 400], true).map((c) => c.value)).toEqual(['400', '400i', '700', '700i']);
    expect(weightChoices(undefined, false).map((c) => c.label)).toEqual(['Regular', 'Bold']);
    expect(weightLabel(400, true)).toBe('Italic');
    expect(weightLabel(900)).toBe('Black');
    expect(parseWeightValue(weightValue(600, 'italic'))).toEqual({ fontWeight: 600, fontStyle: 'italic' });
    expect(parseWeightValue('bogus')).toEqual({ fontWeight: 400, fontStyle: 'normal' });
  });

  it('derives layer names from content', () => {
    expect(autoLayerName('  Hello world\nsecond')).toBe('Hello world');
    expect(autoLayerName('')).toBe('Text');
    expect(autoLayerName('x'.repeat(50)).length).toBe(32);
  });
});

describe('text style presets', () => {
  const EFFECT_KEYS: Record<string, string[]> = {
    'drop-shadow': ['color', 'opacity', 'angle', 'distance', 'spread', 'size', 'blendMode'],
    'outer-glow': ['color', 'opacity', 'size', 'spread', 'blendMode'],
    stroke: ['color', 'size', 'position', 'opacity', 'blendMode', 'fillType', 'gradient'],
    'long-shadow': ['color', 'angle', 'length', 'opacity', 'fade'],
  };
  const families = new Set(BUNDLED_FAMILIES.map((f) => f.family));

  it('includes the required looks with unique ids', () => {
    const ids = TEXT_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['gothic-title', 'condensed-impact', 'signature', 'serif-quote', 'comic', 'horror-drip', 'kanji-watermark', 'cartoon-sim', 'newspaper-headline']) {
      expect(getTextStyle(id), id).toBeDefined();
    }
    expect(getTextStyle('kanji-watermark')!.opacity).toBe(0.15);
    expect(getTextStyle('comic')!.effects(100).filter((e) => e.effectId === 'stroke')).toHaveLength(2);
  });

  it('uses bundled fonts and valid effect params that scale with size', () => {
    for (const s of TEXT_STYLES) {
      expect(families.has(s.text.fontFamily!), `${s.id} font ${s.text.fontFamily}`).toBe(true);
      const def = BUNDLED_FAMILIES.find((f) => f.family === s.text.fontFamily)!;
      expect(def.weights, s.id).toContain(s.text.fontWeight ?? 400);
      for (const e of s.effects(120)) {
        expect(EFFECT_KEYS[e.effectId], `${s.id} ${e.effectId}`).toBeDefined();
        for (const k of Object.keys(e.params)) expect(EFFECT_KEYS[e.effectId], `${s.id} ${e.effectId}.${k}`).toContain(k);
      }
      const small = presetEffects(s, 20);
      const big = presetEffects(s, 200);
      small.forEach((e, i) => {
        expect(e.id).toMatch(/^fx_/);
        expect(e.enabled).toBe(true);
        const sz = Number(e.params.size ?? e.params.distance ?? e.params.length ?? 0);
        const bz = Number(big[i].params.size ?? big[i].params.distance ?? big[i].params.length ?? 0);
        expect(bz).toBeGreaterThanOrEqual(sz);
      });
    }
  });
});

describe('misc', () => {
  it('generates lorem ipsum', () => {
    expect(loremWords(5).split(' ')).toHaveLength(5);
    expect(loremWords(5)).toMatch(/^[A-Z].*\.$/);
    expect(loremForBox(2000, 10, 30)).toBe(LOREM);
  });

  it('detects the Character panel visibility', () => {
    expect(isCharacterPanelOpen({ workspace: DEFAULT_WORKSPACE, flyoutPanel: null })).toBe(false);
    expect(isCharacterPanelOpen({ workspace: DEFAULT_WORKSPACE, flyoutPanel: 'character' })).toBe(true);
    const ws = { ...DEFAULT_WORKSPACE, groups: DEFAULT_WORKSPACE.groups.map((g, i) => (i === 0 ? { ...g, tabs: [...g.tabs, 'character'], active: 'character' } : g)) };
    expect(isCharacterPanelOpen({ workspace: ws, flyoutPanel: null })).toBe(true);
  });
});
