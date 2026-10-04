/**
 * Effects panel (id 'effects'): layer style editor for the active layer — list of effects with
 * enable toggles, expandable ParamEditors (live preview + coalesced commits), drag reorder,
 * duplicate/delete, "Add effect" menu, style presets and copy/paste/clear style.
 *
 * The list is shown like the layer stack: the TOP row is drawn last (on top). LayerEffect arrays
 * are stored bottom → top, so rows are rendered in reverse array order.
 */
import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardCopy, ClipboardPaste, CopyPlus, Eraser, GripVertical, Plus, RotateCcw, Sparkle, Trash2 } from 'lucide-react';
import type { Layer, LayerEffect } from '../core/types';
import { useEditor } from '../state/editor';
import { effects, useRegistry } from '../registry';
import { defaultParams, resolveParams } from '../filters/engine';
import { Checkbox, IconButton, ParamEditor, Section, showContextMenu, showMenuAt, type MenuItem } from '../ui/controls';
import * as ops from './layerOps';
import { STYLE_PRESETS, effectMenuIds, effectName, type StylePreset } from './effectPresets';
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
  if (layer.type === 'adjustment')
    return <Empty title="Adjustment layer" note="Adjustment layers can't have layer styles. Select a pixel, text, shape, fill layer or group." />;
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

/** Drag state in DISPLAY rows (0 = top row). */
interface DragRows {
  from: number;
  to: number;
}

function EffectsEditor({ layer }: { layer: Layer }) {
  const expanded = ops.useLayersUI((s) => s.expandedEffect);
  const clip = ops.useLayersUI((s) => s.styleClipboard);
  const setExpanded = ops.useLayersUI((s) => s.setExpandedEffect);
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragRows | null>(null);
  const list = layer.effects;
  const n = list.length;
  /** display row ↔ array index */
  const toIndex = (row: number) => n - 1 - row;

  const startDrag = (e: React.PointerEvent, from: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let to = from;
    let moved = false;
    const startY = e.clientY;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 3) return;
      moved = true;
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-fx-row]') ?? [])];
      let slot = items.length;
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          slot = i;
          break;
        }
      }
      // Insertion slot → final row.
      to = slot > from ? slot - 1 : slot;
      setDrag({ from, to });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (moved && to !== from) ops.moveEffect(layer.id, toIndex(from), toIndex(to));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const rows = list.map((fx, i) => ({ fx, index: i })).reverse();

  return (
    <div className="layers-fx">
      <div className="layers-fx-head">
        <span className="layers-fx-target" title={layer.name}>
          Style of <b>{layer.name}</b>
        </span>
        <IconButton icon={Plus} size="sm" title="Add effect" onClick={(e) => showMenuAt(e.currentTarget, addEffectItems(), 170)} />
        <IconButton icon={ClipboardCopy} size="sm" title="Copy layer style" disabled={!n} onClick={ops.copyStyle} />
        <IconButton icon={ClipboardPaste} size="sm" title="Paste layer style" disabled={!clip} onClick={ops.pasteStyle} />
        <IconButton icon={Eraser} size="sm" title="Clear layer style" disabled={!n} onClick={ops.clearStyle} />
      </div>
      <div className="layers-props-scroll">
        {n === 0 ? (
          <div className="layers-empty" style={{ paddingBottom: 12 }}>
            <div>No effects on this layer</div>
            <button className="ui-btn small" onClick={(e) => showMenuAt(e.currentTarget, addEffectItems(), 170)}>
              <Plus size={13} /> Add Effect
            </button>
          </div>
        ) : (
          <div className="layers-fx-list" ref={listRef}>
            {rows.map(({ fx, index }, row) => (
              <EffectItem
                key={fx.id}
                layer={layer}
                fx={fx}
                index={index}
                row={row}
                open={expanded === fx.id}
                onToggleOpen={() => setExpanded(expanded === fx.id ? null : fx.id)}
                onGrip={(e) => startDrag(e, row)}
                dragging={drag?.from === row}
                dropBefore={!!drag && drag.to !== drag.from && drag.to === row && drag.to < drag.from}
                dropAfter={!!drag && drag.to !== drag.from && drag.to === row && drag.to > drag.from}
              />
            ))}
          </div>
        )}
        <Section title="Style Presets">
          <div className="layers-presets">
            {STYLE_PRESETS.map((p) => (
              <PresetTile key={p.id} preset={p} />
            ))}
          </div>
          <div className="layers-note">Click a preset to add its effects to the current style · Alt-click replaces the style.</div>
        </Section>
      </div>
    </div>
  );
}

function PresetTile({ preset: p }: { preset: StylePreset }) {
  const missing = effects.list().length > 0 && p.effects.some((e) => !effects.has(e.effectId));
  return (
    <button
      className="layers-preset"
      title={`${p.name}\n${p.description}${missing ? '\n(Some effects of this preset are not available in this build.)' : ''}\nClick: add · Alt-click: replace the current style`}
      onClick={(e) => ops.applyStylePreset(p, e.altKey)}
    >
      <span className="layers-preset-sample" style={{ background: p.preview.background }}>
        <span style={{ color: p.preview.color, textShadow: p.preview.textShadow }}>Aa</span>
      </span>
      <span className="layers-preset-name">{p.name}</span>
    </button>
  );
}

function EffectItem({
  layer,
  fx,
  index,
  row,
  open,
  onToggleOpen,
  onGrip,
  dragging,
  dropBefore,
  dropAfter,
}: {
  layer: Layer;
  fx: LayerEffect;
  /** Index in layer.effects (0 = bottom). */
  index: number;
  /** Display row (0 = top). */
  row: number;
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
    { label: 'Move Up', disabled: index >= n - 1, run: () => ops.moveEffect(layer.id, index, index + 1) },
    { label: 'Move Down', disabled: index <= 0, run: () => ops.moveEffect(layer.id, index, index - 1) },
    { separator: true },
    { label: 'Delete', icon: Trash2, run: () => ops.removeEffect(layer.id, fx.id) },
  ];

  return (
    <div
      className={cls('layers-fx-item', open && 'open', !fx.enabled && 'off', dragging && 'dragging', dropBefore && 'drop-before', dropAfter && 'drop-after')}
      data-fx-row={row}
      onContextMenu={(e) => showContextMenu(e, menu())}
    >
      <div className="layers-fx-item-head">
        <span className="layers-fx-grip" title="Drag to reorder (rows higher in the list are drawn on top)" onPointerDown={onGrip}>
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
