import { describe, expect, it } from 'vitest';
import { REPEAT_PLACE_MS, createPlaceGuard } from './clickGuard';

describe('single-click place guard', () => {
  it('places once for a double-click (second click has detail 2)', () => {
    const g = createPlaceGuard();
    expect(g('film-scratches', 1, 1000)).toBe(true);
    expect(g('film-scratches', 2, 1180)).toBe(false);
  });

  it('ignores a quick repeat on the same tile even without a click count', () => {
    const g = createPlaceGuard();
    expect(g('dust', 0, 0)).toBe(true);
    expect(g('dust', 0, REPEAT_PLACE_MS - 1)).toBe(false);
    expect(g('dust', 1, REPEAT_PLACE_MS + 50)).toBe(true);
  });

  it('places different tiles clicked in quick succession', () => {
    const g = createPlaceGuard();
    expect(g('dust', 1, 0)).toBe(true);
    expect(g('creases', 1, 100)).toBe(true);
    expect(g('dust', 1, 200)).toBe(true);
  });
});
