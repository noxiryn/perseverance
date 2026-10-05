import { describe, expect, it } from 'vitest';
import { poseExtents } from './placeholder';

describe('placeholder pose extents', () => {
  it('reports the reach of raised arms and the sword so wide poses can be fitted', () => {
    const idle = poseExtents({ armL: 5, armR: 5, legL: 0, legR: 0, head: 0 });
    const action = poseExtents({ armL: 38, armR: 112, legL: 13, legR: 13, head: -4 });
    // Idle fits the classic 6.6-stud design box (half-width 3.3 around the shifted center).
    expect(idle.right).toBeLessThan(3.3);
    expect(idle.left).toBeLessThan(3.3);
    // The raised front arm of 'action' reaches past it (it used to be clipped).
    expect(action.right).toBeGreaterThan(3.3);
    const sword = poseExtents({ armL: 16, armR: 140, legL: 9, legR: 9, head: -6, sword: true });
    expect(sword.right).toBeGreaterThan(idle.right);
  });
});
