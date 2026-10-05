/**
 * Layer ▸ New Fill Layer dialogs (solid color / gradient / pattern) with live preview on canvas.
 * Also exports the shared fill editors used by the Properties panel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FillContent, Gradient } from '../core/types';
import { makeFillLayer, nextLayerName } from '../core/document';
import { activeSession, useEditor } from '../state/editor';
import { openDialog, toast } from '../state/ui';
import { assets, useRegistry } from '../registry';
import { Button, ColorPicker, Dialog, Field, GradientEditor, NumberField, Select, TextInput } from '../ui/controls';
import { cancelPreview, commitPreview, editLayers, previewInsertLayer } from './layerOps';
import './panels.css';

export type FillKind = FillContent['type'];

const NAMES: Record<FillKind, string> = { solid: 'Color Fill', gradient: 'Gradient Fill', pattern: 'Pattern Fill' };

export function defaultFill(kind: FillKind): FillContent {
  const st = useEditor.getState();
  if (kind === 'solid') return { type: 'solid', color: st.primaryColor };
  if (kind === 'gradient') {
    const g: Gradient = {
      kind: 'linear',
      angle: 90,
      scale: 1,
      stops: [
        { offset: 0, color: st.primaryColor },
        { offset: 1, color: st.secondaryColor },
      ],
    };
    return { type: 'gradient', gradient: g };
  }
  const first = patternAssets()[0];
  return { type: 'pattern', assetId: first?.id ?? '', scale: 1 };
}

/** Assets usable as fill patterns (document-sized textures first). */
export function patternAssets() {
  const list = assets.list().filter((a) => a.category !== 'My Assets' || a.sizing === 'document');
  return [...list.filter((a) => a.sizing === 'document'), ...list.filter((a) => a.sizing !== 'document')];
}

/* ------------------------------------------------------------------ */
/* Shared editors                                                      */
/* ------------------------------------------------------------------ */

/** Small cached preview of an asset (for the pattern picker). */
function AssetPreview({ assetId, size = 96 }: { assetId: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const def = assets.get(assetId);
    const el = ref.current;
    if (!def || !el) return;
    const t = window.setTimeout(() => {
      try {
        const c = def.thumbnail ? def.thumbnail(size) : def.generate({}, { width: size, height: size });
        const ctx = el.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, el.width, el.height);
        const s = Math.max(el.width / c.width, el.height / c.height);
        ctx.drawImage(c, (el.width - c.width * s) / 2, (el.height - c.height * s) / 2, c.width * s, c.height * s);
      } catch (err) {
        console.warn('[panels] asset preview failed', err);
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [assetId, size]);
  return <canvas ref={ref} width={size} height={size} className="layers-asset-preview" />;
}

export function PatternFillEditor({
  value,
  onChange,
  onCommit,
}: {
  value: Extract<FillContent, { type: 'pattern' }>;
  onChange: (f: FillContent) => void;
  /** `discrete` is true for one-off picks (the asset select), false at the end of a scrub. */
  onCommit: (f: FillContent, discrete: boolean) => void;
}) {
  const list = useRegistry(assets);
  const options = useMemo(() => {
    void list;
    return patternAssets().map((a) => ({ value: a.id, label: a.name }));
  }, [list]);
  if (!options.length) return <div className="ui-empty">No pattern assets are available yet.</div>;
  return (
    <div className="layers-pattern-editor">
      <AssetPreview assetId={value.assetId} />
      <div className="layers-col" style={{ flex: 1, minWidth: 0 }}>
        <Select value={value.assetId} options={options} width="100%" onChange={(assetId) => onCommit({ ...value, assetId, params: undefined }, true)} />
        <div className="ui-row">
          <span className="ui-label">Scale</span>
          <NumberField
            value={value.scale}
            min={0.05}
            max={8}
            step={1}
            displayScale={100}
            unit="%"
            width={72}
            onChange={(v) => onChange({ ...value, scale: v })}
            onCommit={(v) => onCommit({ ...value, scale: v }, false)}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* New Fill Layer dialog                                               */
/* ------------------------------------------------------------------ */

function FillLayerDialog({ close, kind }: { close: (r?: string) => void; kind: FillKind }) {
  const s = activeSession();
  const [name, setName] = useState(() => (s ? nextLayerName(s.doc, NAMES[kind]) : NAMES[kind]));
  const [fill, setFill] = useState<FillContent>(() => defaultFill(kind));
  const layer = useMemo(() => makeFillLayer({ fill, name }), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    previewInsertLayer({ ...layer, fill: structuredClone(fill), name });
    // Insert once; further updates go through update().
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (f: FillContent) => {
    setFill(f);
    editLayers([layer.id], 'New Fill Layer', (l) => {
      if (l.type === 'fill') l.fill = structuredClone(f);
    }, 'preview');
  };

  const ok = () => {
    editLayers([layer.id], 'New Fill Layer', (l) => {
      l.name = name.trim() || NAMES[kind];
    }, 'preview');
    close(layer.id);
  };

  return (
    <Dialog
      title={`New Fill Layer — ${kind === 'solid' ? 'Solid Color' : kind === 'gradient' ? 'Gradient' : 'Pattern'}`}
      onClose={() => close()}
      onSubmit={ok}
      width={kind === 'pattern' ? 380 : 320}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={ok}>
            OK
          </Button>
        </>
      }
    >
      <div className="layers-col" style={{ gap: 12 }}>
        <Field label="Name">
          <TextInput value={name} onChange={setName} />
        </Field>
        {fill.type === 'solid' && <ColorPicker value={fill.color} onChange={(c) => update({ type: 'solid', color: c })} onCommit={(c) => update({ type: 'solid', color: c })} />}
        {fill.type === 'gradient' && (
          <GradientEditor value={fill.gradient} onChange={(g) => update({ type: 'gradient', gradient: g })} onCommit={(g) => update({ type: 'gradient', gradient: g })} />
        )}
        {fill.type === 'pattern' && <PatternFillEditor value={fill} onChange={update} onCommit={(f) => update(f)} />}
      </div>
    </Dialog>
  );
}

/** Open the New Fill Layer dialog; the layer is previewed live and committed on OK. */
export async function openFillLayerDialog(kind: FillKind) {
  if (!activeSession()) return void toast('Open or create a document first', 'info');
  if (kind === 'pattern' && !patternAssets().length) return void toast('No pattern assets are available yet', 'info');
  const res = await openDialog(FillLayerDialog as never, { kind } as never);
  if (typeof res === 'string' && activeSession()?.doc.layers[res]) commitPreview('New Fill Layer', res);
  else cancelPreview();
}
