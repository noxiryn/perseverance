import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, ColorField, Dialog, Select, Slider } from '../../ui/controls';
import { assets, useRegistry, type AssetDef } from '../../registry';
import { useEditor } from '../../state/editor';
import { defaultParams } from '../../filters/engine';
import { BLEND_OPTIONS, type FillContents, type FillSpec } from '../fillStroke';
import { readJSON, writeJSON } from '../util';
import '../io.css';

const KEY = 'perseverance.fillDialog';

const CONTENTS: { value: FillContents; label: string }[] = [
  { value: 'foreground', label: 'Foreground Color' },
  { value: 'background', label: 'Background Color' },
  { value: 'color', label: 'Color…' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'black', label: 'Black' },
  { value: 'gray', label: '50% Gray' },
  { value: 'white', label: 'White' },
];

const DEFAULTS: FillSpec = {
  contents: 'foreground',
  color: '#c4141c',
  patternId: null,
  patternScale: 1,
  blendMode: 'normal',
  opacity: 1,
  preserveTransparency: false,
};

const thumbCache = new Map<string, HTMLCanvasElement>();

function PatternThumb({ def }: { def: AssetDef }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let src = thumbCache.get(def.id);
    if (!src) {
      try {
        src = def.thumbnail ? def.thumbnail(64) : def.generate(defaultParams(def.params), { width: 64, height: 64 });
        thumbCache.set(def.id, src);
      } catch {
        return;
      }
    }
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, 64, 64);
    ctx.drawImage(src, 0, 0, 64, 64);
  }, [def]);
  return <canvas ref={ref} />;
}

export function FillDialog({ close }: { close: (r?: FillSpec) => void }) {
  const [spec, setSpec] = useState<FillSpec>(() => ({ ...DEFAULTS, ...readJSON<Partial<FillSpec>>(KEY, {}) }));
  const primary = useEditor((st) => st.primaryColor);
  const secondary = useEditor((st) => st.secondaryColor);
  const allAssets = useRegistry(assets);
  const patterns = useMemo(() => allAssets.filter((a) => a.category !== 'My Assets'), [allAssets]);
  const set = <K extends keyof FillSpec>(k: K, v: FillSpec[K]) => setSpec((p) => ({ ...p, [k]: v }));
  const patternMissing = spec.contents === 'pattern' && (!spec.patternId || !assets.get(spec.patternId));
  const submit = () => {
    if (patternMissing) return;
    writeJSON(KEY, spec);
    close(spec);
  };
  const swatch = spec.contents === 'foreground' ? primary : spec.contents === 'background' ? secondary : null;

  return (
    <Dialog
      title="Fill"
      width={420}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" disabled={patternMissing} onClick={submit}>
            Fill
          </Button>
        </>
      }
    >
      <div className="io-form-grid">
        <span className="ui-label">Contents</span>
        <div className="io-swatch-row">
          <Select value={spec.contents} options={CONTENTS} onChange={(v) => set('contents', v)} width={170} />
          {swatch && <span className="ui-swatch" style={{ width: 20, height: 20 }}><span style={{ background: swatch }} /></span>}
          {spec.contents === 'color' && <ColorField value={spec.color} onChange={(c) => set('color', c)} alpha showHex />}
        </div>
        {spec.contents === 'pattern' && (
          <div className="io-span">
            {patterns.length ? (
              <div className="io-pattern-grid">
                {patterns.map((a) => (
                  <button key={a.id} className={`io-pattern${spec.patternId === a.id ? ' active' : ''}`} title={a.name} onClick={() => set('patternId', a.id)}>
                    <PatternThumb def={a} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="io-note">No patterns are available yet.</div>
            )}
          </div>
        )}
        {spec.contents === 'pattern' && spec.patternId && assets.get(spec.patternId)?.sizing !== 'document' && (
          <>
            <span className="ui-label">Pattern scale</span>
            <Slider value={Math.round(spec.patternScale * 100)} min={10} max={400} unit="%" onChange={(v) => set('patternScale', v / 100)} />
          </>
        )}
      </div>
      <div className="io-sep" />
      <div className="io-form-grid">
        <span className="ui-label">Mode</span>
        <Select value={spec.blendMode} options={BLEND_OPTIONS} onChange={(v) => set('blendMode', v)} width={170} />
        <span className="ui-label">Opacity</span>
        <Slider value={Math.round(spec.opacity * 100)} min={1} max={100} unit="%" onChange={(v) => set('opacity', v / 100)} />
        <span />
        <Checkbox checked={spec.preserveTransparency} onChange={(v) => set('preserveTransparency', v)} label="Preserve Transparency" />
      </div>
    </Dialog>
  );
}
