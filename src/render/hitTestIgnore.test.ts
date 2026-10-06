/**
 * gate-first-user-1: the Move tool's double-click picks the text to edit with a pixel hit test. Full
 * canvas textures that templates lay over their titles (Halftone / Fold Creases in Multiply or
 * Overlay, Ink Spray, Grain…) stopped that pick, so double-clicking the Sunburst / Noir title did
 * nothing. `hitTestLayer(doc, x, y, isSeeThroughOverlay)` looks through blend-mode and faint layers;
 * opaque Normal layers still stop it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Document, Layer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas } from '../core/canvas';
import { createDocument, insertLayerDraft, isFaintLayer, isSeeThroughOverlay, makeGroupLayer, makeRasterLayer, makeTextLayer } from '../core/document';
import { installSoftCanvas } from './softCanvas';
import { hitTestLayer } from './compositor';
import { pickLayer } from '../viewport/layers';

let uninstall: () => void = () => {};
beforeAll(() => {
  uninstall = installSoftCanvas();
});
afterAll(() => uninstall());

const W = 40;
const H = 30;

function raster(name: string, color: string, rect: [number, number, number, number] = [0, 0, W, H], o: Partial<Layer> = {}): Layer {
  const c = createCanvas(W, H);
  const k = c.getContext('2d')!;
  k.fillStyle = color;
  k.fillRect(...rect);
  return { ...makeRasterLayer({ name, bitmapId: bitmaps.add(c), width: W, height: H }), ...o } as Layer;
}

function doc(layers: Layer[]): Document {
  const d = createDocument({ name: 'T', width: W, height: H, background: '#ffffff' });
  for (const l of layers) insertLayerDraft(d, l, { parentId: null });
  return d;
}

describe('see-through overlays for picking', () => {
  it('isSeeThroughOverlay: blend-mode and faint non-text layers; never text or groups', () => {
    const txt = makeTextLayer({ name: 'Kanji', text: { content: 'x' } as never, x: 0, y: 0 });
    expect(isSeeThroughOverlay(raster('Halftone', '#000', undefined, { blendMode: 'multiply' }))).toBe(true);
    expect(isSeeThroughOverlay(raster('Fold Lines', '#888', undefined, { blendMode: 'overlay' }))).toBe(true);
    expect(isSeeThroughOverlay(raster('Faint', '#000', undefined, { opacity: 0.4 }))).toBe(true);
    expect(isSeeThroughOverlay(raster('Low fill', '#000', undefined, { fillOpacity: 0.3 }))).toBe(true);
    expect(isSeeThroughOverlay(raster('Character', '#000'))).toBe(false);
    expect(isSeeThroughOverlay({ ...txt, opacity: 0.42 } as Layer)).toBe(false);
    expect(isFaintLayer({ ...txt, opacity: 0.42 } as Layer)).toBe(true);
    expect(isSeeThroughOverlay({ ...makeGroupLayer({ name: 'G' }), blendMode: 'multiply' } as Layer)).toBe(false);
  });

  it('a full-canvas Multiply texture above the title stops the plain hit test, not the see-through one', () => {
    const title = raster('Title', '#141414', [10, 8, 20, 10]);
    const halftone = raster('Halftone', '#2a0d00', undefined, { blendMode: 'multiply', opacity: 0.32 });
    const creases = raster('Fold Creases', '#808080', undefined, { blendMode: 'overlay' });
    const d = doc([raster('Background', '#f2801f'), title, halftone, creases]);
    expect(hitTestLayer(d, 15, 12)).toBe(creases.id);
    expect(hitTestLayer(d, 15, 12, isSeeThroughOverlay)).toBe(title.id);
    expect(pickLayer(d, 15, 12, isSeeThroughOverlay)).toBe(title.id);
    // Outside the title the pick reaches the opaque background, never an overlay.
    expect(hitTestLayer(d, 2, 2, isSeeThroughOverlay)).not.toBe(halftone.id);
  });

  it('an opaque Normal layer above the title still stops it (hidden text is not opened)', () => {
    const title = raster('Title', '#141414', [10, 8, 20, 10]);
    const character = raster('Character', '#d0a070', [5, 5, 30, 20]);
    const d = doc([title, character]);
    expect(hitTestLayer(d, 15, 12, isSeeThroughOverlay)).toBe(character.id);
  });

  it('without the predicate nothing changes (auto-select / hover outline still pick textures)', () => {
    const title = raster('Title', '#141414', [10, 8, 20, 10]);
    const spray = raster('Ink Spray', '#111111', undefined, { blendMode: 'multiply', opacity: 0.85 });
    const d = doc([title, spray]);
    expect(pickLayer(d, 15, 12)).toBe(spray.id);
  });
});
