import { describe, expect, it } from 'vitest';
import { createDocument, insertLayerDraft, makeAdjustmentLayer, makeFilterInstance, makeGroupLayer, makeRasterLayer } from '../core/document';
import { USER_LOOK_CATEGORY, captureLook, isUserLook, parseUserLooks, type MaskEncoder } from './userLooks';
import { decodeMaskBytes, encodeMaskBytes, type ImageMaskSpec } from './masks';

function scene() {
  const doc = createDocument({ name: 'Series', width: 100, height: 50 });
  const bg = makeRasterLayer({ name: 'Smoke behind', bitmapId: 'b0', width: 100, height: 50 });
  bg.generator = { kind: 'asset:billow-smoke', params: { color: '#c4141c' } };
  const ch = makeRasterLayer({ name: 'Hero', bitmapId: 'b1', width: 40, height: 40 });
  ch.filters.push(makeFilterInstance('gradient-map', { gradient: { kind: 'linear', angle: 0, scale: 1, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ff0000' }] } }));
  const off = makeFilterInstance('halftone');
  off.enabled = false;
  ch.filters.push(off);
  ch.effects.push({ id: 'e', effectId: 'outer-glow', enabled: true, params: { color: '#ff1a1a' } });
  const grain = makeRasterLayer({ name: 'Scratches', bitmapId: 'b2', width: 100, height: 50 });
  grain.generator = { kind: 'asset:film-scratches', params: { density: 0.5 } };
  grain.blendMode = 'screen';
  grain.opacity = 0.6;
  const user = makeRasterLayer({ name: 'Painted', bitmapId: 'b3', width: 10, height: 10 });
  const adj = makeAdjustmentLayer({ name: 'Contrast', filterId: 'brightness-contrast', params: { contrast: 18 } });
  for (const l of [bg, ch, grain, user, adj]) insertLayerDraft(doc, l);
  const behind = makeGroupLayer({ name: 'Look (behind)' });
  behind.meta = { lookId: 'x', lookPart: 'behind' };
  insertLayerDraft(doc, behind, { parentId: null, index: 1 });
  const fog = makeRasterLayer({ name: 'Fog', bitmapId: 'b4', width: 100, height: 50 });
  fog.generator = { kind: 'asset:fog', params: {} };
  insertLayerDraft(doc, fog, { parentId: behind.id });
  return { doc, chId: ch.id };
}

describe('Save as Look', () => {
  it('captures the target treatment, the look groups and the generated layers above it', () => {
    const { doc, chId } = scene();
    const { look, counts } = captureLook(doc, chId, 'Crimson series', 'user-look:1');
    expect(look.category).toBe(USER_LOOK_CATEGORY);
    expect(look.layerFilters?.map((f) => f.filterId)).toEqual(['gradient-map']); // disabled halftone left out
    expect(look.layerEffects?.map((e) => e.effectId)).toEqual(['outer-glow']);
    expect(look.overlays?.map((o) => [o.assetId, o.placement ?? 'top'])).toEqual([
      ['fog', 'behind'],
      ['film-scratches', 'top'],
    ]);
    expect(look.overlays?.[1]).toMatchObject({ blendMode: 'screen', opacity: 0.6, params: { density: 0.5 } });
    expect(look.adjustments?.map((a) => a.filterId)).toEqual(['brightness-contrast']);
    expect(counts).toEqual({ filters: 1, effects: 1, overlays: 2, adjustments: 1, masked: 0 });
    expect(look.layerFilters?.[0].scope).toBe('character');
    // the smoke BELOW the character and the hand-painted layer are not part of the look
    expect(look.overlays?.some((o) => o.assetId === 'billow-smoke')).toBe(false);
    expect(look.swatch.length).toBeGreaterThan(0);
  });

  it('without a target only the look groups are captured', () => {
    const { doc } = scene();
    const { counts } = captureLook(doc, null, 'x');
    expect(counts).toEqual({ filters: 0, effects: 0, overlays: 1, adjustments: 0, masked: 0 });
  });

  it('parses stored looks defensively', () => {
    expect(isUserLook('user-look:abc')).toBe(true);
    expect(parseUserLooks([{ id: 'gothic-paper', name: 'x' }, { id: 'user-look:a', name: 'Mine', swatch: [] }, 3])).toEqual([
      { id: 'user-look:a', name: 'Mine', swatch: ['#2a2a2a', '#8a8a8a'], category: USER_LOOK_CATEGORY },
    ]);
  });

  it('keeps the masks of masked overlays (a masked “smoke in front” stays confined)', () => {
    const { doc, chId } = scene();
    const smokeFront = Object.values(doc.layers).find((l) => l.name === 'Scratches')!;
    smokeFront.mask = { bitmapId: 'm1', enabled: true, density: 1, feather: 12, inverted: false };
    const spec: ImageMaskSpec = { kind: 'image', width: 2, height: 1, data: encodeMaskBytes(new Uint8Array([0, 255])) };
    const encoder: MaskEncoder = (m) => (m.bitmapId === 'm1' ? spec : null);
    const { look, counts, maskSkipped } = captureLook(doc, chId, 'x', 'user-look:2', encoder);
    expect(look.overlays?.find((o) => o.assetId === 'film-scratches')?.mask).toEqual(spec);
    expect(counts.masked).toBe(1);
    expect(maskSkipped).toEqual([]);
  });

  it('leaves out masked layers whose mask cannot be captured instead of saving them full-canvas', () => {
    const { doc, chId } = scene();
    const scratches = Object.values(doc.layers).find((l) => l.name === 'Scratches')!;
    scratches.mask = { bitmapId: 'gone', enabled: true, density: 1, feather: 0, inverted: false };
    const { look, maskSkipped } = captureLook(doc, chId, 'x', 'user-look:3', () => null);
    expect(look.overlays?.some((o) => o.assetId === 'film-scratches')).toBe(false);
    expect(maskSkipped).toEqual(['Scratches']);
    // a disabled mask doesn't confine anything: captured unmasked
    scratches.mask = { ...scratches.mask, enabled: false };
    const again = captureLook(doc, chId, 'x', 'user-look:4', () => null);
    expect(again.look.overlays?.find((o) => o.assetId === 'film-scratches')?.mask).toBeUndefined();
  });

  it('mask bytes round-trip through base64', () => {
    const bytes = new Uint8Array(70000).map((_, i) => i % 256);
    const b64 = encodeMaskBytes(bytes);
    expect(decodeMaskBytes(b64, bytes.length)).toEqual(bytes);
    expect(decodeMaskBytes(b64, 5)).toBeNull();
    expect(decodeMaskBytes('%%%', 1)).toBeNull();
  });
});
