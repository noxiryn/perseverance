/**
 * Effects panel (id 'effects'): layer style editor for the active layer — list of effects with
 * enable toggles, expandable ParamEditors (live preview + coalesced commits), drag reorder,
 * duplicate/delete, "Add effect" menu, style presets (colours adapt to the layer), the user's own
 * saved styles ("My Styles": effects + optional smart filters) and copy/paste/clear style.
 *
 * Rows are listed in the order the renderer really draws them (top row = drawn last): effects
 * drawn over the content, a "Layer content" divider, then effects drawn behind it. Effect types
 * have a fixed order; only effects of the same type (e.g. a double stroke) can be reordered.
 */
import { useRef, useState } from 'react';
import { BookmarkPlus, ChevronDown, ChevronRight, ClipboardCopy, ClipboardPaste, CopyPlus, Eraser, GripVertical, Pencil, Plus, Replace, RotateCcw, Sparkle, Trash2 } from 'lucide-react';
import type { Layer } from '../core/types';
import { useEditor } from '../state/editor';
import { effects, useRegistry } from '../registry';
import { defaultParams, resolveParams } from '../filters/engine';
import { Checkbox, IconButton, ParamEditor, Section, showContextMenu, showMenuAt, type MenuItem } from '../ui/controls';
import * as ops from './layerOps';
import { STYLE_PRESETS, effectMenuIds, effectName, type StylePreset } from './effectPresets';
import { effectPlacement, effectsTopDown, reorderTarget, type OrderedEffect } from './effectOrder';
import { applyUserStyle, saveLayerStyle, useUserStyles, type UserStyle } from './userStyles';
import { promptSave } from '../looks/SavePresetDialog';
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

/** Pending drop while dragging an effect: place `from` above / below effect `ref` (array indices). */
interface DropState {
  from: number;
  ref: number;
  where: 'above' | 'below';
  to: number;
}

function EffectsEditor({ layer }: { layer: Layer }) {
  const expanded = ops.useLayersUI((s) => s.expandedEffect);
  const clip = ops.useLayersUI((s) => s.styleClipboard);
  const setExpanded = ops.useLayersUI((s) => s.setExpandedEffect);
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; drop: DropState | null } | null>(null);
  const list = layer.effects;
  const n = list.length;
  const rows = effectsTopDown(list);
  const bucketSize = new Map<string, number>();
  for (const r of rows) bucketSize.set(r.bucket, (bucketSize.get(r.bucket) ?? 0) + 1);
  const firstBehind = rows.findIndex((r) => r.place.stage === 'behind');
  const dividerAt = firstBehind < 0 ? rows.length : firstBehind;

  const startDrag = (e: React.PointerEvent, item: OrderedEffect) => {
    if (e.button !== 0 || (bucketSize.get(item.bucket) ?? 0) < 2) return;
    e.preventDefault();
    const from = item.index;
    let drop: DropState | null = null;
    let moved = false;
    const startY = e.clientY;
    setDrag({ from, drop: null });
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 3) return;
      moved = true;
      // Only rows of the same effect type are valid targets.
      const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-fx-index]') ?? [])].filter(
        (el) => el.dataset.fxBucket === item.bucket && Number(el.dataset.fxIndex) !== from,
      );
      drop = null;
      if (els.length) {
        let ref = Number(els[els.length - 1].dataset.fxIndex);
        let where: 'above' | 'below' = 'below';
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            ref = Number(el.dataset.fxIndex);
            where = 'above';
            break;
          }
        }
        const to = reorderTarget(list, effectPlacement, from, ref, where);
        if (to !== null) drop = { from, ref, where, to };
      }
      setDrag({ from, drop });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (moved && drop) ops.moveEffect(layer.id, drop.from, drop.to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

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
        <IconButton
          icon={BookmarkPlus}
          size="sm"
          title="Save Layer Style… — keep these effects (and smart filters) under My Styles"
          disabled={!n && !layer.filters.length}
          onClick={() => void saveLayerStyle()}
        />
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
            {rows.map((item, row) => (
              <div key={item.fx.id} style={{ display: 'contents' }}>
                {row === dividerAt && <ContentDivider />}
                <EffectItem
                  layer={layer}
                  item={item}
                  rows={rows}
                  sortable={(bucketSize.get(item.bucket) ?? 0) > 1}
                  open={expanded === item.fx.id}
                  onToggleOpen={() => setExpanded(expanded === item.fx.id ? null : item.fx.id)}
                  onGrip={(e) => startDrag(e, item)}
                  dragging={drag?.from === item.index}
                  dropBefore={drag?.drop?.ref === item.index && drag.drop.where === 'above'}
                  dropAfter={drag?.drop?.ref === item.index && drag.drop.where === 'below'}
                />
              </div>
            ))}
            {dividerAt === rows.length && <ContentDivider />}
          </div>
        )}
        <MyStyles canSave={n > 0 || layer.filters.length > 0} />
        <Section title="Style Presets">
          <div className="layers-presets">
            {STYLE_PRESETS.map((p) => (
              <PresetTile key={p.id} preset={p} />
            ))}
          </div>
          <div className="layers-note">Click a preset to add its effects to the current style · Alt-click replaces the style. Outline colours adapt to the layer (a dark title gets a light outline).</div>
        </Section>
      </div>
    </div>
  );
}

/** First colour param of a saved style (for its tile swatch). */
function styleSwatch(st: UserStyle): string[] {
  const colors = [...st.effects, ...st.filters].map((x) => x.params.color).filter((c): c is string => typeof c === 'string');
  return colors.length ? colors.slice(0, 3) : ['#3a3a3a'];
}

/** "My Styles": styles the user saved from layers (effects + optional smart filters). */
function MyStyles({ canSave }: { canSave: boolean }) {
  const styles = useUserStyles((s) => s.styles);
  const menu = (st: UserStyle): MenuItem[] => [
    { label: 'Add to Layer Style', run: () => applyUserStyle(st) },
    { label: 'Replace Layer Style', icon: Replace, run: () => applyUserStyle(st, true) },
    { separator: true },
    {
      label: 'Rename…',
      icon: Pencil,
      run: () =>
        void promptSave({ title: 'Rename Style', confirm: 'Rename', defaultName: st.name }).then((r) => {
          if (r) useUserStyles.getState().rename(st.id, r.name);
        }),
    },
    { label: 'Delete Style', icon: Trash2, run: () => useUserStyles.getState().remove(st.id) },
  ];
  return (
    <Section
      title="My Styles"
      actions={<IconButton icon={BookmarkPlus} size="sm" title="Save the current layer style…" disabled={!canSave} onClick={() => void saveLayerStyle()} />}
    >
      {styles.length ? (
        <>
          <div className="layers-presets">
            {styles.map((st) => {
              const sw = styleSwatch(st);
              return (
                <button
                  key={st.id}
                  className="layers-preset"
                  title={`${st.name}\n${st.effects.length} effect${st.effects.length === 1 ? '' : 's'}${st.filters.length ? ` · ${st.filters.length} smart filter${st.filters.length === 1 ? '' : 's'}` : ''}\nClick: add · Alt-click: replace · right-click: rename/delete`}
                  onClick={(e) => applyUserStyle(st, e.altKey)}
                  onContextMenu={(e) => showContextMenu(e, menu(st))}
                >
                  <span className="layers-preset-sample" style={{ background: sw.length > 1 ? `linear-gradient(135deg, ${sw.join(', ')})` : sw[0] }}>
                    <span style={{ color: '#f4f4f4', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>Aa</span>
                  </span>
                  <span className="layers-preset-name">{st.name}</span>
                </button>
              );
            })}
          </div>
          <div className="layers-note">Your saved styles · right-click to rename or delete.</div>
        </>
      ) : (
        <div className="layers-note">Save a layer’s effects and smart filters here to reuse them on your next thumbnail.</div>
      )}
    </Section>
  );
}

/** Marks where the layer's own pixels sit between the effects drawn above and behind them. */
function ContentDivider() {
  return (
    <div className="layers-fx-content" title="Effects listed above this line are drawn over the layer content; effects below it are drawn behind it">
      <span>Layer content</span>
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

/** Array index of the same-type effect displayed directly above (-1) or below (+1) `item`. */
function neighbor(rows: OrderedEffect[], item: OrderedEffect, dir: -1 | 1): OrderedEffect | null {
  const at = rows.indexOf(item);
  for (let i = at + dir; i >= 0 && i < rows.length; i += dir) if (rows[i].bucket === item.bucket) return rows[i];
  return null;
}

function EffectItem({
  layer,
  item,
  rows,
  sortable,
  open,
  onToggleOpen,
  onGrip,
  dragging,
  dropBefore,
  dropAfter,
}: {
  layer: Layer;
  item: OrderedEffect;
  rows: OrderedEffect[];
  /** Another effect of the same type exists (only those can be reordered). */
  sortable: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onGrip: (e: React.PointerEvent) => void;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
}) {
  const { fx, index } = item;
  const def = effects.get(fx.effectId);
  const name = effectName(fx.effectId);
  const values = def ? resolveParams(def, fx.params) : fx.params;
  const color = typeof values.color === 'string' ? values.color : null;
  const up = neighbor(rows, item, -1);
  const down = neighbor(rows, item, 1);
  const moveNext = (ref: OrderedEffect | null, where: 'above' | 'below') => {
    if (!ref) return;
    const to = reorderTarget(layer.effects, effectPlacement, index, ref.index, where);
    if (to !== null) ops.moveEffect(layer.id, index, to);
  };

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
    { label: 'Move Up', disabled: !up, run: () => moveNext(up, 'above') },
    { label: 'Move Down', disabled: !down, run: () => moveNext(down, 'below') },
    { separator: true },
    { label: 'Delete', icon: Trash2, run: () => ops.removeEffect(layer.id, fx.id) },
  ];

  return (
    <div
      className={cls('layers-fx-item', open && 'open', !fx.enabled && 'off', dragging && 'dragging', dropBefore && 'drop-before', dropAfter && 'drop-after')}
      data-fx-index={index}
      data-fx-bucket={item.bucket}
      onContextMenu={(e) => showContextMenu(e, menu())}
    >
      <div className="layers-fx-item-head">
        <span
          className={cls('layers-fx-grip', !sortable && 'fixed')}
          title={
            sortable
              ? `Drag to change which ${name} is drawn on top (the upper row is drawn over the lower one)`
              : 'Effects are drawn in a fixed order by type — only effects of the same type can be reordered'
          }
          onPointerDown={onGrip}
        >
          <GripVertical size={13} />
        </span>
        <Checkbox checked={fx.enabled} onChange={() => ops.toggleEffect(layer.id, fx.id)} title={fx.enabled ? 'Hide effect' : 'Show effect'} />
        <span className="layers-fx-name" onClick={onToggleOpen} title={def ? `Click to ${open ? 'collapse' : 'edit'}` : 'Effect not available in this build'}>
          <span className="layers-fx-name-text">{name}</span>
          {color && <span className="layers-fx-dot" style={{ background: color }} title={`Color ${color}`} />}
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
              onChange={(k, _v, all) => ops.updateEffect(layer.id, fx.id, (e) => (e.params = all), 'preview', ops.paramLabel(name, def.params, k))}
              onCommit={(k, _v, all) =>
                ops.updateEffect(layer.id, fx.id, (e) => (e.params = all), ops.paramCommitPhase(def.params, k), ops.paramLabel(name, def.params, k))
              }
            />
          ) : (
            <div className="layers-note">“{name}” is not available in this build — it is kept with the layer and will render once the effect is installed.</div>
          )}
        </div>
      )}
    </div>
  );
}
