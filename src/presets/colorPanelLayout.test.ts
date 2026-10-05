import { describe, expect, it } from 'vitest';
import { colorFieldHeight } from './ColorPanel';

describe('colorFieldHeight', () => {
  const rest = 150; // chips + tabs + three sliders

  it('fills the room left in the panel, up to 180px', () => {
    expect(colorFieldHeight(300, rest)).toBe(300 - rest - 24);
    expect(colorFieldHeight(900, rest)).toBe(180);
  });

  it('hides the field when less than 48px would be left, so the sliders stay visible', () => {
    expect(colorFieldHeight(160, rest)).toBe(0); // 190px dock group (160px body)
    expect(colorFieldHeight(rest + 24 + 47, rest)).toBe(0);
    expect(colorFieldHeight(rest + 24 + 48, rest)).toBe(48);
  });
});
