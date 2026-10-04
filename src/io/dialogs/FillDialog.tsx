import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, ColorField, Dialog, Select, Slider } from '../../ui/controls';
import { assets, useRegistry, type AssetDef } from '../../registry';
import { useEditor } from '../../state/editor';
import { defaultParams } from '../../filters/engine';
import { BLEND_OPTIONS, type FillContents, type FillSpec } from '../fillStroke';
import { readJSON, writeJSON } from '../util';
import { useDeferredSubmit } from './useDeferredSubmit';
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

/* ---------------- pattern thumbnails (generated lazily, a few per frame) ---------------- */

const THUMB = 64;
const thumbCache = new Map<string, HTMLCanvasElement | null>();
const queue: { def: AssetDef; done: (c: HTMLCanvasElement | null) => void }[] = [];
let pumping = false;

function renderThumb(def: AssetDef): HTMLCanvasElement | null {
  try {
    return def.thumbnail ? def.thumbnail(THUMB) : def.generate(defaultParams(def.params), { width: THUMB, height: THUMB });
  } catch (e) {
    console.warn(`[io] pattern thumbnail ${def.id} failed`, e);
    return null;
  }
}

function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const t0 = performance.now();
    // ~10ms of work per frame keeps the dialog responsive while thumbnails stream in.
    while (queue.length && performance.now() - t0 < 10) {
      const job = queue.shift()!;
      let c = thumbCache.get(job.def.id);
      if (c === undefined) {
        c = renderThumb(job.def);
        thumbCache.set(job.def.id, c);
      }
      job.done(c);
    }
    if (queue.length) requestAnimationFrame(step);
    else pumping = false;
  };
  requestAnimationFrame(step);
}

function requestThumb(def: AssetDef, done: (c: HTMLCanvasElement | null) => void): () => void {
  const hit = thumbCache.get(def.id);
  if (hit !== undefined) {
    done(hit);
    return () => undefined;
  }
  const job = { def, done };
  queue.push(job);
  pump();
  return () => {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
  };
}

function PatternThumb({ def }: { def: AssetDef }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(
    () =>
      requestThumb(def, (src) => {
        const c = ref.current;
        if (!c || !src) return;
        c.width = THUMB;
        c.height = THUMB;
        const ctx = c.getContext('2d')!;
        ctx.clearRect(0, 0, THUMB, THUMB);
        ctx.drawImage(src, 0, 0, THUMB, THUMB);
        setReady(true);
      }),
    [def],
  );
  return <canvas ref={ref} className={ready ? 'ready' : undefined} />;
}

/* ---------------- dialog ---------------- */

export function FillDialog({ close }: { close: (r?: FillSpec) => void }) {
  const [spec, setSpec] = useState<FillSpec>(() => ({ ...DEFAULTS, ...readJSON<Partial<FillSpec>>(KEY, {}) }));
  const primary = useEditor((st) => st.primaryColor);
  const secondary = useEditor((st) => st.secondaryColor);
  const allAssets = useRegistry(assets);
  const patterns = useMemo(() => allAssets.filter((a) => a.category !== 'My Assets'), [allAssets]);
  const categories = useMemo(() => [...new Set(patterns.map((p) => p.category))], [patterns]);
  const [cat, setCat] = useState<string>(() => (spec.patternId && assets.get(spec.patternId)?.category) || 'all');
  const shown = cat === 'all' ? patterns : patterns.filter((p) => p.category === cat);
  const set = <K extends keyof FillSpec>(k: K, v: FillSpec[K]) => setSpec((p) => ({ ...p, [k]: v }));
  const pattern = spec.patternId ? assets.get(spec.patternId) : undefined;
  const patternMissing = spec.contents === 'pattern' && !pattern;
  const submit = useDeferredSubmit(() => {
    if (patternMissing) return;
    writeJSON(KEY, spec);
    close(spec);
  });
  const swatch = spec.contents === 'foreground' ? primary : spec.contents === 'background' ? secondary : null;

  return (
    <Dialog
      title="Fill"
      width={spec.contents === 'pattern' ? 500 : 420}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          {patternMissing && (
            <span className="io-faint" style={{ marginRight: 'auto', fontSize: 'var(--fs-sm)' }}>
              Choose a pattern
            </span>
          )}
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
          {swatch && (
            <span className="ui-swatch" style={{ width: 20, height: 20 }} title={swatch}>
              <span style={{ background: swatch }} />
            </span>
          )}
          {spec.contents === 'color' && <ColorField value={spec.color} onChange={(c) => set('color', c)} alpha showHex />}
        </div>
        {spec.contents === 'pattern' && (
          <>
            <span className="ui-label">Library</span>
            <div className="io-swatch-row">
              <Select
                value={cat}
                options={[{ value: 'all', label: `All patterns (${patterns.length})` }, ...categories.map((c) => ({ value: c, label: c }))]}
                onChange={setCat}
                width={190}
              />
              {pattern && <span className="io-pattern-name">{pattern.name}</span>}
            </div>
            <div className="io-span">
              {shown.length ? (
                <div className="io-pattern-grid">
                  {shown.map((a) => (
                    <button
                      key={a.id}
                      className={`io-pattern${spec.patternId === a.id ? ' active' : ''}`}
                      title={`${a.name} — ${a.category}`}
                      onClick={() => set('patternId', a.id)}
                      onDoubleClick={() => {
                        const next = { ...spec, patternId: a.id };
                        writeJSON(KEY, next);
                        close(next);
                      }}
                    >
                      <PatternThumb def={a} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="io-note">No patterns are available yet.</div>
              )}
            </div>
            {pattern && pattern.sizing !== 'document' && (
              <>
                <span className="ui-label">Pattern scale</span>
                <Slider value={Math.round(spec.patternScale * 100)} min={10} max={400} unit="%" onChange={(v) => set('patternScale', v / 100)} />
              </>
            )}
            {pattern && pattern.sizing === 'document' && (
              <span className="io-span io-note">Full-canvas texture — generated at the document size.</span>
            )}
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
