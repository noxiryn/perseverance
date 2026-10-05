import { describe, expect, it, vi } from 'vitest';
import { claimPlacedImage, registerPlacedImageHandler } from './placeHooks';

const ctx = () => ({ canvas: { width: 4, height: 4 } as HTMLCanvasElement, name: 'render', source: 'place' as const });

describe('placed-image handlers', () => {
  it('lets the first claiming handler take the image; failing handlers are skipped', async () => {
    const later = vi.fn(() => true);
    const offs = [
      registerPlacedImageHandler({ id: 't-throws', claim: () => Promise.reject(new Error('boom')) }),
      registerPlacedImageHandler({ id: 't-declines', claim: () => false }),
      registerPlacedImageHandler({ id: 't-claims', claim: async () => true }),
      registerPlacedImageHandler({ id: 't-later', claim: later }),
    ];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await claimPlacedImage(ctx())).toBe(true);
    expect(later).not.toHaveBeenCalled();
    err.mockRestore();
    offs.forEach((off) => off());
    expect(await claimPlacedImage(ctx())).toBe(false);
  });
});
