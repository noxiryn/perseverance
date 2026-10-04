/** Temporary isolated dev harness for the fonts-color module (not part of the app build). */
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '../../styles/theme.css';
import '../index';
import '../../presets/index';
import { panels, useRegistry, fonts, palettes, gradientPresets } from '../../registry';
import { useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { DialogHost, MenuHost, FontSelect } from '../../ui/controls';
import { createDocument, insertLayerDraft, makeTextLayer, makeRasterLayer } from '../../core/document';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctx2d } from '../../core/canvas';
import { useState } from 'react';

const params = new URLSearchParams(location.search);

function demo() {
  const doc = createDocument({ name: 'Harness', width: 640, height: 360, background: '#ffffff' });
  const c = createCanvas(640, 360);
  const x = ctx2d(c);
  const g = x.createLinearGradient(0, 0, 640, 360);
  g.addColorStop(0, '#1c0a03'); g.addColorStop(0.5, '#c4500f'); g.addColorStop(1, '#fde9c4');
  x.fillStyle = g; x.fillRect(0, 0, 640, 360);
  x.fillStyle = '#6f63c9'; x.fillRect(40, 40, 120, 120);
  x.fillStyle = '#0b0b0b'; x.fillRect(400, 200, 160, 100);
  insertLayerDraft(doc, makeRasterLayer({ name: 'Backdrop', bitmapId: bitmaps.add(c), width: 640, height: 360 }), {});
  const t = makeTextLayer({ name: 'Title', x: 40, y: 40, text: { content: 'Birdcage', fontFamily: 'UnifrakturMaguntia', fontSize: 80 } });
  insertLayerDraft(doc, t, {});
  useEditor.getState().openDocument(doc, { activeLayerId: t.id });
}
if (params.get('demo')) demo();

(window as unknown as { __app: unknown }).__app = { panels, fonts, palettes, gradientPresets, useEditor, useUI };

function Harness() {
  const list = useRegistry(panels);
  const id = params.get('panel') ?? 'fonts';
  const [font, setFont] = useState('Anton');
  if (id === 'fontselect') {
    return (
      <div style={{ padding: 20, width: 300 }}>
        <div id="fs"><FontSelect value={font} onChange={setFont} width={240} /></div>
        <div style={{ marginTop: 12, color: '#999' }}>chosen: {font}</div>
      </div>
    );
  }
  const p = list.find((x) => x.id === id);
  if (!p) return <div>missing {id}</div>;
  const C = p.component;
  return (
    <div style={{ width: Number(params.get('w') ?? 268), height: '100vh', background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 28, display: 'flex', alignItems: 'center', padding: '0 8px', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{p.title}</div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><C /></div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100%', display: 'flex' }}>
    <Harness />
    <DialogHost />
    <MenuHost />
  </div>,
);
