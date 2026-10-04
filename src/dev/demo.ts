/**
 * Demo document for development/visual checks: a few layers of each kind.
 * Open with `?demo=1` (any mode) or call `openDemoDocument()` from __app.
 */
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d } from '../core/canvas';
import {
  createDocument,
  insertLayerDraft,
  makeAdjustmentLayer,
  makeFillLayer,
  makeGroupLayer,
  makeRasterLayer,
  makeShapeLayer,
  makeTextLayer,
} from '../core/document';
import type { Document } from '../core/types';
import { renderPlaceholderCharacter } from '../roblox/placeholder';
import { useEditor } from '../state/editor';

export function buildDemoDocument(width = 1920, height = 1080): Document {
  const doc = createDocument({ name: 'Demo Thumbnail', width, height, background: '#ffffff' });
  const add = (l: Parameters<typeof insertLayerDraft>[1], parentId?: string) => insertLayerDraft(doc, l, { parentId: parentId ?? null });

  add(
    makeFillLayer({
      name: 'Backdrop',
      fill: {
        type: 'gradient',
        gradient: {
          kind: 'radial',
          angle: 90,
          scale: 1,
          stops: [
            { offset: 0, color: '#3a3a3a' },
            { offset: 1, color: '#0b0b0b' },
          ],
        },
      },
    }),
  );

  // Paint-like raster layer
  const paint = createCanvas(width, height);
  const pctx = ctx2d(paint);
  const g = pctx.createRadialGradient(width * 0.7, height * 0.5, 10, width * 0.7, height * 0.5, height * 0.6);
  g.addColorStop(0, 'rgba(200,20,30,0.9)');
  g.addColorStop(1, 'rgba(200,20,30,0)');
  pctx.fillStyle = g;
  pctx.fillRect(0, 0, width, height);
  add(makeRasterLayer({ name: 'Red Glow', bitmapId: bitmaps.add(paint), width, height }));

  const group = makeGroupLayer({ name: 'Character' });
  add(group);
  const ch = renderPlaceholderCharacter({ width: 700, height: 900, pose: 'sword', style: 'shaded' });
  const char = makeRasterLayer({
    name: 'Roblox Character',
    bitmapId: bitmaps.add(ch),
    width: ch.width,
    height: ch.height,
    transform: { x: width * 0.55, y: height - 900 },
  });
  char.effects = [
    { id: 'e1', effectId: 'drop-shadow', enabled: true, params: { distance: 18, size: 24, opacity: 0.8 } },
    { id: 'e2', effectId: 'stroke', enabled: true, params: { size: 4, color: '#ffffff' } },
  ];
  add(char, group.id);

  const title = makeTextLayer({
    name: 'Title',
    x: 90,
    y: 760,
    text: { content: 'ARES ACKERMAN', fontFamily: 'Anton', fontSize: 150, fill: { type: 'solid', color: '#ffffff' } },
  });
  add(title);
  const sub = makeTextLayer({
    name: 'Quote',
    x: 96,
    y: 940,
    text: { content: '"FOR THEIR ONE AND ONLY HERO."', fontFamily: 'Cinzel', fontSize: 44, fill: { type: 'solid', color: '#eeeeee' } },
  });
  add(sub);

  const star = makeShapeLayer({
    name: 'Star',
    x: 1700,
    y: 60,
    shape: { kind: 'star', width: 120, height: 120, sides: 5, innerRatio: 0.45, fill: { type: 'solid', color: '#f2f2f2' } },
  });
  add(star);

  const adj = makeAdjustmentLayer({ name: 'Vignette', filterId: 'vignette', params: { amount: 0.6 } });
  add(adj);
  return doc;
}

export function openDemoDocument() {
  const doc = buildDemoDocument();
  useEditor.getState().openDocument(doc, { label: 'Open Demo' });
  return doc.id;
}
