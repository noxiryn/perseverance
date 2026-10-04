/**
 * Effects panel (id 'effects'): layer style editor for the active layer — list of effects with
 * enable toggles, expandable ParamEditors (live preview + coalesced commits), drag reorder,
 * duplicate/delete, "Add effect" menu, style presets and copy/paste/clear style.
 */
import { useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ClipboardPaste,
  CopyPlus,
  Eraser,
  GripVertical,
  Plus,
  RotateCcw,
  Sparkle,
  Trash2,
} from 'lucide-react';
import type { Layer, LayerEffect } from '../core/types';
import { useEditor } from '../state/editor';
import { effects, useRegistry } from '../registry';
import { defaultParams, resolveParams } from '../filters/engine';
import { Checkbox, IconButton, ParamEditor, Section, showContextMenu, showMenuAt, type MenuItem } from '../ui/controls';
import * as ops from './layerOps';
import { STYLE_PRESETS, effectMenuIds, effectName } from './effectPresets';
import './panels.css';

const cls = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function EffectsPanel() {
  const doc = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.doc ?? null) : null));
  const layer = useEditor((st) => {
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    return s && s.activeLayerId ? (s.doc.layers[s.activeLayerId] ?? null) : null;
  });
  useRegistry(effects);

  if (!doc) return <Empty title="No document open" note="Open a document and select a layer to edit its layer style." />;
  if (!layer) return <Empty title="No layer selected" note="Select a layer in the Layers panel to add strokes, shadows and glows." />;
  if (layer.type === 'adjustment') return <Empty title="Adjustment layer" note="Adjustment layers can't have layer styles. Select a pixel, text, shape, fill layer or group." />;
  return <EffectsEditor layer={layer} />;
}

function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="layers-fx">
      <div className="layers-empty">
        <Sparkle size={22} strokeWidth={1.4} />
        <div>{title}</div>
        <div className="layers-note">{note}</div>
      </div>
    </div>
  );
}

function addEffectItems(): MenuItem[] {
  return effectMenuIds().map((id) => ({ label: effectName(id), run: () => void ops.addEffect(id, undefined, { showPanel: false }) }));
}

function EffectsEditor({ layer }: { layer: Layer }) {
  const expanded = ops.useLayersUI((s) => s.expandedEffect);
  const clip = ops.useLayersUI((s) => s.styleClipboard);
  const setExpanded = ops.useLayersUI((s) => s.setExpandedEffect);
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const list = layer.effects;

  const startDrag = (e: React.PointerEvent, from: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let to = from;
    setDrag({ from, to });
    const move = (ev: PointerEvent) => {
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-fx-index]') ?? [])];
      let idx = items.length;
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          idx = i;
          break;
        }
      }
      // Convert an insertion slot into a final index.
      to = idx > from ? idx - 1 : idx;
      setDrag({ from, to });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (to !== from) ops.moveEffect(layer.id, from, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="layers-fx">
      <div className="layers-fx-head">
        <span className="layers-fx-target" title={layer.name}>
          Style of <b>{layer.name}</b>
        </span>
        <IconButton icon={Plus} size="sm" title="Add effect" onClick={(e) => showMenuAt(e.currentTarget, addEffectItems(), 170)} />
        <IconButton icon={ClipboardCopy} size="sm" title="Copy layer style" disabled={!list.length} onClick={ops.copyStyle} />
        <IconButton icon={ClipboardPaste} size="sm" title="Paste layer style" disabled={!clip} onClick={ops.pasteStyle} />
        <IconButton icon={Eraser} size="sm" title="Clear layer style" disabled={!list.length} onClick={ops.clearStyle} />
      </div>
      <div className="layers-props-scroll">
        {list.length === 0 ? (
          <div className="layers-empty" style={{ paddingBottom: 12 }}>
            <div>No effects on this layer</div>
            <button className="ui-btn small" onClick={(e) => showMenuAt(e.currentTarget, addEffectItems(), 170)}>
              <Plus size={13} /> Add Effect
            </button>
          </div>
        ) : (
          <div className="layers-fx-list" ref={listRef}>
            {list.map((fx, i) => (
              <EffectItem
                key={fx.id}
                layer={layer}
                fx={fx}
                index={i}
                open={expanded === fx.id}
                onToggleOpen={() => setExpanded(expanded === fx.id ? null : fx.id)}
                onGrip={(e) => startDrag(e, i)}
                dragging={drag?.from === i}
                dropBefore={!!drag && drag.to !== drag.from && drag.to === i && drag.to < drag.from}
                dropAfter={!!drag && drag.to !== drag.from && drag.to === i && drag.to > drag.from}
              />
            ))}
          </div>
        )}
        <Section title="Style Presets">
          <div className="layers-presets">
            {STYLE_PRESETS.map((p) => (
              <button
                key={p.id}
                className="layers-preset"
                title={`${p.description}\nClick to add · Alt-click to replace the current style`}
                onClick={(e) => ops.applyStylePreset(p, e.altKey)}
              >
                <span className="layers-preset-chip" style={{ background: p.swatch[1], color: p.swatch[0], boxShadow: `inset 0 0 0 2px ${p.swatch[0]}` }}>
                  A
                </span>
                <span>{p.name}</span>
              </button>
            ))}
          </div>
          <div className="layers-note">Presets add their effects to the current style. Alt-click replaces it.</div>
        </Section>
      </div>
    </div>
  );
}

function EffectItem({
  layer,
  fx,
  index,
  open,
  onToggleOpen,
  onGrip,
  dragging,
  dropBefore,
  dropAfter,
}: {
  layer: Layer;
  fx: LayerEffect;
  index: number;
  open: boolean;
  onToggleOpen: () => void;
  onGrip: (e: React.PointerEvent) => void;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
}) {
  const def = effects.get(fx.effectId);
  const name = effectName(fx.effectId);
  const values = def ? resolveParams(def, fx.params) : fx.params;
  const color = typeof values.color === 'string' ? values.color : null;
  const label = `Edit ${name}`;
  const n = layer.effects.length;

  const menu = (): MenuItem[] => [
    { label: open ? 'Collapse' : 'Edit Parameters', run: onToggleOpen },
    { label: fx.enabled ? 'Hide Effect' : 'Show Effect', run: () => ops.toggleEffect(layer.id, fx.id) },
    { label: 'Duplicate', icon: CopyPlus, run: () => ops.duplicateEffect(layer.id, fx.id) },
    {
      label: 'Reset to Defaults',
      icon: RotateCcw,
      disabled: !def,
      run: () => def && ops.updateEffect(layer.id, fx.id, (e) => (e.params = defaultParams(def.params)), 'commit', `Reset ${name}`),
    },
    { separator: true },
    { label: 'Move Up', disabled: index === 0, run: () => ops.moveEffect(layer.id, index, index - 1) },
    { label: 'Move Down', disabled: index >= n - 1, run: () => ops.moveEffect(layer.id, index, index + 1) },
    { separator: true },
    { label: 'Delete', icon: Trash2, run: () => ops.removeEffect(layer.id, fx.id) },
  ];

  return (
    <div
      className={cls('layers-fx-item', open && 'open', !fx.enabled && 'off', dragging && 'dragging', dropBefore && 'drop-before', dropAfter && 'drop-after')}
      data-fx-index={index}
      onContextMenu={(e) => showContextMenu(e, menu())}
    >
      <div className="layers-fx-item-head">
        <span className="layers-fx-grip" title="Drag to reorder" onPointerDown={onGrip}>
          <GripVertical size={13} />
        </span>
        <Checkbox checked={fx.enabled} onChange={() => ops.toggleEffect(layer.id, fx.id)} title={fx.enabled ? 'Hide effect' : 'Show effect'} />
        {color && <span className="layers-fx-swatch" style={{ background: color }} />}
        <span className="layers-fx-name" onClick={onToggleOpen} title={def ? `Click to ${open ? 'collapse' : 'edit'}` : 'Effect not available in this build'}>
          {name}
        </span>
        <IconButton icon={CopyPlus} size="sm" title="Duplicate effect" onClick={() => ops.duplicateEffect(layer.id, fx.id)} />
        <IconButton icon={Trash2} size="sm" title="Delete effect" onClick={() => ops.removeEffect(layer.id, fx.id)} />
        <IconButton icon={open ? ChevronDown : ChevronRight} size="sm" title={open ? 'Collapse' : 'Edit parameters'} onClick={onToggleOpen} />
      </div>
      {open && (
        <div className="layers-fx-body">
          {def ? (
            <ParamEditor
              defs={def.params}
              values={values}
              compact
              onChange={(_k, _v, all) => ops.updateEffect(layer.id, fx.id, (e) => (e.params = all), 'preview', label)}
              onCommit={(_k, _v, all) => ops.updateEffect(layer.id, fx.id, (e) => (e.params = all), 'commit', label)}
            />
          ) : (
            <div className="layers-note">“{name}” is not available in this build — it is kept with the layer and will render once the effect is installed.</div>
          )}
        </div>
      )}
    </div>
  );
}
