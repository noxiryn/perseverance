/**
 * Character Styler panel (id 'roblox'): one-click character styles (smart filters + effects
 * tracked in layer.meta.styler), friendly sliders bound to their params (live preview +
 * coalesced commits) and quick buttons for the Roblox tools.
 */
import { useMemo } from 'react';
import { Box, CloudDownload, Eraser, Gamepad2, ImagePlus, PersonStanding, RotateCcw, Scissors, SquareDashed, Monitor } from 'lucide-react';
import { ColorField, Field, IconButton, Slider } from '../../ui/controls';
import { effects, filters, runCommand, useRegistry } from '../../registry';
import { useActiveDoc, useActiveLayer, useEditor } from '../../state/editor';
import { toast, useUI } from '../../state/ui';
import { resolveParams } from '../../filters/engine';
import { uid } from '../../core/ids';
import type { Layer, ParamValue } from '../../core/types';
import { viewport } from '../../editor/viewport';
import '../roblox.css';
import { STYLES, applyBuiltStyleDraft, buildStyle, readStylerMeta, resolveControls, setControlDraft, styleById, type ResolvedControl, type StyleDef } from './styles';

const STYLABLE = new Set(['raster', 'text', 'shape']);

function availability() {
  return { hasFilter: (id: string) => filters.has(id), hasEffect: (id: string) => effects.has(id) };
}

/** Apply (or clear with null) a styler style on a layer — one undo step. */
export function applyStyle(layerId: string, style: StyleDef | null) {
  const st = useEditor.getState();
  const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
  const layer = s?.doc.layers[layerId];
  if (!layer || !STYLABLE.has(layer.type)) return;
  const built = style ? buildStyle(style, availability(), uid) : null;
  if (style && built && !built.filters.length && !built.effects.length) {
    toast(`The filters used by “${style.name}” are not available.`, 'warning');
    return;
  }
  st.commit(style ? `Style: ${style.name}` : 'Clear Character Style', (d) => {
    const l = d.layers[layerId];
    if (l) applyBuiltStyleDraft(l, built);
  });
  viewport.requestRender();
}

function QuickButton({ icon: Icon, label, onClick, active, title }: { icon: typeof Box; label: string; onClick: () => void; active?: boolean; title?: string }) {
  return (
    <button type="button" className={`roblox-quick${active ? ' active' : ''}`} onClick={onClick} title={title ?? label}>
      <Icon size={15} strokeWidth={1.6} />
      <span>{label}</span>
    </button>
  );
}

function ControlRow({ layer, rc }: { layer: Layer; rc: ResolvedControl }) {
  const c = rc.control;
  const inst = c.kind === 'filter' ? layer.filters[rc.index] : layer.effects[rc.index];
  const def = c.kind === 'filter' ? filters.get(rc.defId) : effects.get(rc.defId);
  const values = def ? resolveParams(def, inst?.params) : (inst?.params ?? {});
  const raw = values[rc.param];
  const live = (v: ParamValue) => {
    useEditor.getState().preview((d) => {
      const l = d.layers[layer.id];
      if (l) setControlDraft(l, rc, v);
    });
    viewport.requestRender();
  };
  const commit = (v: ParamValue) => {
    useEditor.getState().commit(
      `Style: ${c.label}`,
      (d) => {
        const l = d.layers[layer.id];
        if (l) setControlDraft(l, rc, v);
      },
      { coalesce: true },
    );
    viewport.requestRender();
  };
  if (c.type === 'color') {
    return (
      <Field label={c.label}>
        <ColorField value={typeof raw === 'string' ? raw : '#000000'} onChange={live} onCommit={commit} showHex />
      </Field>
    );
  }
  const min = c.min ?? 0;
  const max = c.max ?? 100;
  const v = typeof raw === 'number' ? Math.max(min, Math.min(max, raw)) : min;
  return (
    <Field label={c.label}>
      <Slider value={v} min={min} max={max} step={c.step ?? 1} unit={c.unit} displayScale={c.displayScale} onChange={live} onCommit={commit} />
    </Field>
  );
}

export function StylerPanel() {
  const doc = useActiveDoc();
  const layer = useActiveLayer();
  const safeZones = useUI((s) => s.view.safeZones);
  // Re-render when other modules register filters/effects.
  const filterList = useRegistry(filters);
  const effectList = useRegistry(effects);

  const stylable = !!layer && STYLABLE.has(layer.type);
  const meta = stylable ? readStylerMeta(layer) : null;
  const style = styleById(meta?.style);
  const controls = useMemo(() => (layer && style ? resolveControls(style, layer) : []), [layer, style]);
  const avail = useMemo(() => {
    void filterList;
    void effectList;
    const a = availability();
    return (s: StyleDef) => s.filters.some((f) => f.options.some((o) => a.hasFilter(o.filterId)));
  }, [filterList, effectList]);

  return (
    <div className="roblox-styler">
      <div className="roblox-styler-quick">
        <QuickButton icon={Scissors} label="Remove BG" onClick={() => runCommand('roblox.removeBackground')} title="Remove the background of the active layer" />
        <QuickButton icon={PersonStanding} label="Pose Studio" onClick={() => runCommand('roblox.poseStudio')} title="Pose and render a 3D Roblox character" />
        <QuickButton icon={Box} label="Import Model" onClick={() => runCommand('roblox.importModel')} title="Render an .obj/.glb/.fbx exported from Roblox Studio" />
        <QuickButton icon={CloudDownload} label="Fetch Avatar" onClick={() => runCommand('roblox.fetchAvatar')} title="Download a player's avatar render by username" />
        <QuickButton icon={Gamepad2} label="Preview" onClick={() => runCommand('roblox.preview')} title="See your icon/thumbnail in mock game cards" />
        <QuickButton icon={SquareDashed} label="Safe Zones" active={safeZones} onClick={() => runCommand('roblox.safeZones')} title="Show icon/thumbnail safe areas on the canvas" />
      </div>

      {!doc ? (
        <div className="roblox-styler-empty">
          <div>No document open.</div>
          <div className="roblox-styler-quick" style={{ gridTemplateColumns: '1fr 1fr', border: 'none', padding: 0 }}>
            <QuickButton icon={ImagePlus} label="New Icon" onClick={() => runCommand('roblox.newIcon')} title="512×512 game icon" />
            <QuickButton icon={Monitor} label="New Thumbnail" onClick={() => runCommand('roblox.newThumbnail')} title="1920×1080 thumbnail" />
          </div>
        </div>
      ) : !layer ? (
        <div className="roblox-styler-empty">Select your character layer to style it.</div>
      ) : !stylable ? (
        <div className="roblox-styler-empty">
          “{layer.name}” is a {layer.type} layer. Select the character (pixel) layer to apply a style.
        </div>
      ) : (
        <>
          <div className="roblox-styler-head">
            <span className="name" title={layer.name}>
              {layer.name}
            </span>
            {style && (
              <>
                <IconButton size="sm" icon={RotateCcw} title={`Reset “${style.name}” to its defaults`} onClick={() => applyStyle(layer.id, style)} />
                <IconButton size="sm" icon={Eraser} title="Remove the character style" onClick={() => applyStyle(layer.id, null)} />
              </>
            )}
          </div>
          <div className="roblox-styler-grid">
            {STYLES.map((s) => {
              const ok = avail(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={!ok}
                  className={`roblox-style-card${style?.id === s.id ? ' active' : ''}`}
                  onClick={() => applyStyle(layer.id, s)}
                  title={ok ? s.description : `${s.description} (filters unavailable)`}
                >
                  <span className="sw" style={{ background: `linear-gradient(135deg, ${s.swatch[0]} 0%, ${s.swatch[0]} 34%, ${s.swatch[1]} 34%, ${s.swatch[1]} 67%, ${s.swatch[2]} 67%)` }} />
                  <span className="label">{s.name}</span>
                </button>
              );
            })}
          </div>
          {style ? (
            <div className="roblox-styler-controls">
              <div className="roblox-group-head" style={{ marginBottom: 2 }}>
                <span>Adjust {style.name}</span>
              </div>
              {controls.length ? controls.map((rc) => <ControlRow key={rc.control.id} layer={layer} rc={rc} />) : <div className="roblox-hint">This style's filters were removed from the layer.</div>}
              <div className="roblox-hint">Styles add smart filters and layer effects — fine-tune them in the Layers and Effects panels too.</div>
            </div>
          ) : (
            <div className="roblox-styler-controls">
              <div className="roblox-hint">
                Pick a style to turn your character into a toon, comic, noir, crimson, gothic or neon look. Switching styles replaces only what the styler added.
                {meta === null && layer.type === 'raster' && ' Tip: remove the background first so outlines and rims follow the character.'}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
