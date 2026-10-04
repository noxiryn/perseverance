/**
 * Properties panel (id 'properties'): document properties when no layer is active; otherwise the
 * active layer's header, transform, appearance, registered propertiesSections, fill editor, mask
 * and smart filter sections. Every edit previews live and commits one (coalesced) history step.
 */
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FileImage,
  FlipHorizontal2,
  FlipVertical2,
  Link,
  Plus,
  RotateCcw,
  Sparkles,
  SquareDashedMousePointer,
  Trash2,
  Unlink,
} from 'lucide-react';
import type { BlendMode, Document, FillContent, Gradient, GradientKind, Layer, TransformableLayer } from '../core/types';
import { isTransformable } from '../core/document';
import { useEditor } from '../state/editor';
import { useUI } from '../state/ui';
import { commands, filters, propertiesSections, runCommand, useRegistry, type FilterCategory } from '../registry';
import { resolveParams } from '../filters/engine';
import { getLayerSize } from '../render/compositor';
import { openFilterDialog } from '../filters/ui/filterDialog';
import {
  AngleDial,
  Button,
  Checkbox,
  ColorField,
  Field,
  GradientField,
  IconButton,
  NumberField,
  ParamEditor,
  Section,
  Select,
  Slider,
  showContextMenu,
  showMenuAt,
  type MenuItem,
} from '../ui/controls';
import * as ops from './layerOps';
import { flippedTransform, normalizeAngle, resetTransform, visualBox, withVisualPosition, withVisualSize } from './geometryMath';
import { layerTypeIcon, layerTypeLabel } from './icons';
import { BLEND_MODES, GROUP_BLEND_MODES } from './LayersPanel';
import { PatternFillEditor, defaultFill } from './dialogs';
import { effectName } from './effectPresets';
import { filterContextMenu } from './menus';
import './panels.css';

export function PropertiesPanel() {
  const doc = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.doc ?? null) : null));
  const activeId = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.activeLayerId ?? null) : null));
  if (!doc) {
    return (
      <div className="layers-props">
        <div className="layers-empty">
          <FileImage size={22} strokeWidth={1.4} />
          <div>No document open</div>
          <div className="layers-note">Document and layer properties appear here.</div>
        </div>
      </div>
    );
  }
  const layer = activeId ? doc.layers[activeId] : undefined;
  return (
    <div className="layers-props">
      <div className="layers-props-scroll">{layer ? <LayerProps key={layer.id} doc={doc} layer={layer} /> : <DocProps doc={doc} />}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Error boundary for third-party sections                             */
/* ------------------------------------------------------------------ */

class SectionBoundary extends Component<{ children: ReactNode; name: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[properties] section “${this.props.name}” crashed`, error);
  }
  render() {
    if (this.state.error) return <div className="layers-note">This section failed to render: {this.state.error.message}</div>;
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/* Document properties                                                 */
/* ------------------------------------------------------------------ */

function DocProps({ doc }: { doc: Document }) {
  const showGuides = useUI((s) => s.view.guides);
  const toggleView = useUI((s) => s.toggleView);
  const [name, setName] = useState(doc.name);
  useEffect(() => setName(doc.name), [doc.name]);
  const layerCount = Object.keys(doc.layers).length;
  const bg = doc.background;
  return (
    <>
      <div className="layers-props-head">
        <div className="layers-props-icon">
          <FileImage size={15} />
        </div>
        <div className="layers-props-title">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setName(doc.name);
            }}
            onBlur={() => {
              const n = name.trim();
              if (n && n !== doc.name) ops.editDoc('Rename Document', (d) => void (d.name = n));
              else setName(doc.name);
            }}
          />
          <span className="layers-props-sub">Document · no layer selected</span>
        </div>
      </div>
      <Section title="Canvas">
        <div className="layers-kv">
          <span>Size</span>
          <span>
            {doc.width} × {doc.height} px
          </span>
          <span>Resolution</span>
          <span>{doc.dpi} ppi</span>
          <span>Layers</span>
          <span>{layerCount}</span>
          {doc.selection && (
            <>
              <span>Selection</span>
              <span>
                {Math.round(doc.selection.bounds.width)} × {Math.round(doc.selection.bounds.height)} at {Math.round(doc.selection.bounds.x)},{' '}
                {Math.round(doc.selection.bounds.y)}
              </span>
            </>
          )}
        </div>
        <div className="layers-btnrow">
          {commands.has('image.imageSize') && (
            <Button size="small" onClick={() => runCommand('image.imageSize')}>
              Image Size…
            </Button>
          )}
          {commands.has('image.canvasSize') && (
            <Button size="small" onClick={() => runCommand('image.canvasSize')}>
              Canvas Size…
            </Button>
          )}
        </div>
      </Section>
      <Section title="Background">
        <Field label="Color">
          <div className="ui-row">
            <ColorField
              value={bg ?? '#ffffff'}
              onChange={(c) => ops.editDoc('Background Color', (d) => void (d.background = c), 'preview')}
              onCommit={(c) => ops.editDoc('Background Color', (d) => void (d.background = c))}
              showHex
            />
          </div>
        </Field>
        <Field label="">
          <Checkbox
            checked={bg === null}
            label="Transparent background"
            onChange={(v) => ops.editDoc('Background Color', (d) => void (d.background = v ? null : '#ffffff'))}
          />
        </Field>
      </Section>
      <Section title="Guides">
        <div className="layers-kv">
          <span>Guides</span>
          <span>{doc.guides.length === 0 ? 'None' : `${doc.guides.filter((g) => g.orientation === 'vertical').length} vertical, ${doc.guides.filter((g) => g.orientation === 'horizontal').length} horizontal`}</span>
        </div>
        <div className="layers-btnrow">
          <Checkbox checked={showGuides} label="Show guides" onChange={(v) => toggleView('guides', v)} />
          <span style={{ flex: 1 }} />
          <Button size="small" disabled={!doc.guides.length} onClick={() => ops.editDoc('Clear Guides', (d) => void (d.guides = []))}>
            Clear Guides
          </Button>
        </div>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Layer properties                                                    */
/* ------------------------------------------------------------------ */

function LayerProps({ doc, layer }: { doc: Document; layer: Layer }) {
  const sections = useRegistry(propertiesSections);
  const applicable = useMemo(
    () =>
      sections
        .filter((s) => {
          try {
            return s.appliesTo(layer.id);
          } catch {
            return false;
          }
        })
        .sort((a, b) => a.order - b.order),
    // Re-evaluate when the layer changes (appliesTo reads the store).
    [sections, layer],
  );
  const Icon = layerTypeIcon(layer);
  const [name, setName] = useState(layer.name);
  useEffect(() => setName(layer.name), [layer.name]);

  return (
    <>
      <div className="layers-props-head">
        <div className="layers-props-icon">
          <Icon size={15} />
        </div>
        <div className="layers-props-title">
          <input
            value={name}
            title="Layer name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setName(layer.name);
            }}
            onBlur={() => (name.trim() ? ops.renameLayer(layer.id, name) : setName(layer.name))}
          />
          <span className="layers-props-sub">{layerTypeLabel(layer)}</span>
        </div>
        <IconButton icon={layer.visible ? Eye : EyeOff} title={layer.visible ? 'Hide layer' : 'Show layer'} onClick={() => ops.toggleVisibility(layer.id)} />
      </div>
      {isTransformable(layer) && <TransformSection layer={layer} />}
      <AppearanceSection layer={layer} />
      {applicable.map((s) => {
        const C = s.component;
        return (
          <Section key={s.id} title={s.title}>
            <SectionBoundary name={s.id}>
              <C layerId={layer.id} />
            </SectionBoundary>
          </Section>
        );
      })}
      {layer.type === 'fill' && <FillSection layer={layer} />}
      {layer.type === 'adjustment' && !applicable.length && (
        <Section title="Adjustment">
          <AdjustmentFallback layer={layer} />
        </Section>
      )}
      <MaskSection doc={doc} layer={layer} />
      {layer.type !== 'adjustment' && layer.type !== 'group' && <SmartFiltersSection layer={layer} />}
      {layer.type !== 'adjustment' && <EffectsSummary layer={layer} />}
    </>
  );
}

/* ---------------- Transform ---------------- */

function TransformSection({ layer }: { layer: TransformableLayer }) {
  const [linked, setLinked] = useState(true);
  const size = useMemo(() => getLayerSize(layer), [layer]);
  const w = Math.max(1e-6, size.width);
  const h = Math.max(1e-6, size.height);
  const t = layer.transform;
  const box = visualBox(t, w, h);
  const locked = layer.locks.position || layer.locks.all;
  const id = layer.id;

  const edit = (fn: (tl: TransformableLayer) => void) => ({
    preview: () => ops.editLayers([id], 'Transform', (l) => isTransformable(l) && fn(l), 'preview'),
    commit: () => ops.editLayers([id], 'Transform', (l) => isTransformable(l) && fn(l), 'commit'),
  });
  const field = (fn: (tl: TransformableLayer, v: number) => void) => ({
    onChange: (v: number) => !locked && edit((l) => fn(l, v)).preview(),
    onCommit: (v: number) => !locked && edit((l) => fn(l, v)).commit(),
  });
  const scaleX = Math.round(Math.abs(t.scaleX) * 1000) / 10;
  const scaleY = Math.round(Math.abs(t.scaleY) * 1000) / 10;

  return (
    <Section
      title="Transform"
      actions={<IconButton icon={RotateCcw} size="sm" title="Reset transform (scale, rotation, flip)" disabled={locked} onClick={() => edit((l) => (l.transform = resetTransform(l.transform))).commit()} />}
    >
      {locked && <div className="layers-note">Position is locked for this layer.</div>}
      <div className="layers-grid2" style={locked ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
        <NumberField value={box.x} step={1} unit="px" scrubLabel="X" title="Left edge (px)" {...field((l, v) => (l.transform = withVisualPosition(l.transform, w, h, { x: v })))} />
        <NumberField value={box.y} step={1} unit="px" scrubLabel="Y" title="Top edge (px)" {...field((l, v) => (l.transform = withVisualPosition(l.transform, w, h, { y: v })))} />
      </div>
      <div className="layers-wh" style={locked ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
        <NumberField
          value={box.width}
          min={1}
          step={1}
          unit="px"
          scrubLabel="W"
          title={`Width (${scaleX}%)`}
          {...field((l, v) => (l.transform = withVisualSize(l.transform, w, h, { width: v }, linked)))}
        />
        <IconButton icon={linked ? Link : Unlink} size="sm" active={linked} title={linked ? 'Aspect ratio linked' : 'Link aspect ratio'} onClick={() => setLinked(!linked)} />
        <NumberField
          value={box.height}
          min={1}
          step={1}
          unit="px"
          scrubLabel="H"
          title={`Height (${scaleY}%)`}
          {...field((l, v) => (l.transform = withVisualSize(l.transform, w, h, { height: v }, linked)))}
        />
      </div>
      <div className="ui-row" style={locked ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
        <AngleDial
          value={-t.rotation}
          onChange={(a) => edit((l) => (l.transform = { ...l.transform, rotation: normalizeAngle(-a) })).preview()}
          onCommit={(a) => edit((l) => (l.transform = { ...l.transform, rotation: normalizeAngle(-a) })).commit()}
        />
        <NumberField
          value={t.rotation}
          min={-360}
          max={360}
          step={0.1}
          unit="°"
          width={66}
          title="Rotation (degrees, clockwise)"
          {...field((l, v) => (l.transform = { ...l.transform, rotation: normalizeAngle(v) }))}
        />
        <span style={{ flex: 1 }} />
        <IconButton icon={FlipVertical2} title="Flip horizontal" active={t.scaleX < 0} onClick={() => edit((l) => (l.transform = flippedTransform(l.transform, 'h'))).commit()} />
        <IconButton icon={FlipHorizontal2} title="Flip vertical" active={t.scaleY < 0} onClick={() => edit((l) => (l.transform = flippedTransform(l.transform, 'v'))).commit()} />
      </div>
      <div className="layers-note">
        Scale {scaleX}% × {scaleY}% · content {Math.round(size.width)} × {Math.round(size.height)} px
      </div>
    </Section>
  );
}

/* ---------------- Appearance ---------------- */

function AppearanceSection({ layer }: { layer: Layer }) {
  const id = layer.id;
  const isGroup = layer.type === 'group';
  return (
    <Section title="Appearance">
      <Field label="Blend">
        <Select<string>
          value={layer.blendMode}
          options={isGroup ? GROUP_BLEND_MODES : BLEND_MODES}
          width="100%"
          onChange={(v) => ops.editLayers([id], 'Blend Mode', (l) => void ((l as { blendMode: string }).blendMode = v))}
        />
      </Field>
      <Field label="Opacity">
        <Slider
          value={layer.opacity}
          min={0}
          max={1}
          step={1}
          displayScale={100}
          unit="%"
          onChange={(v) => ops.editLayers([id], 'Opacity', (l) => void (l.opacity = v), 'preview')}
          onCommit={(v) => ops.editLayers([id], 'Opacity', (l) => void (l.opacity = v))}
        />
      </Field>
      {!isGroup && layer.type !== 'adjustment' && (
        <Field label="Fill" hint="Fill opacity affects the content but not layer effects">
          <Slider
            value={layer.fillOpacity}
            min={0}
            max={1}
            step={1}
            displayScale={100}
            unit="%"
            onChange={(v) => ops.editLayers([id], 'Fill Opacity', (l) => void (l.fillOpacity = v), 'preview')}
            onCommit={(v) => ops.editLayers([id], 'Fill Opacity', (l) => void (l.fillOpacity = v))}
          />
        </Field>
      )}
      <Field label="">
        <Checkbox
          checked={layer.clipped}
          label="Clip to layer below"
          onChange={(v) => {
            useEditor.getState().setActiveLayer(id);
            ops.setClipped(v);
          }}
        />
      </Field>
    </Section>
  );
}

/* ---------------- Fill layer editor ---------------- */

const GRADIENT_KINDS: { value: GradientKind; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'angle', label: 'Angle' },
  { value: 'reflected', label: 'Reflected' },
  { value: 'diamond', label: 'Diamond' },
];

function FillSection({ layer }: { layer: Extract<Layer, { type: 'fill' }> }) {
  const id = layer.id;
  const fill = layer.fill;
  const set = (f: FillContent, phase: ops.Phase) =>
    ops.editLayers([id], 'Edit Fill', (l) => {
      if (l.type === 'fill') l.fill = structuredClone(f);
    }, phase);
  const setGradient = (g: Gradient, phase: ops.Phase) => set({ type: 'gradient', gradient: g }, phase);

  return (
    <Section title="Fill">
      <div className="layers-fill-tabs">
        {(['solid', 'gradient', 'pattern'] as const).map((k) => (
          <button
            key={k}
            className={`ui-tab${fill.type === k ? ' active' : ''}`}
            onClick={() => {
              if (fill.type === k) return;
              const next = defaultFill(k);
              if (k === 'pattern' && !(next as { assetId: string }).assetId) return;
              // Carry the current color over where it makes sense.
              if (k === 'gradient' && fill.type === 'solid' && next.type === 'gradient') next.gradient.stops[0].color = fill.color;
              if (k === 'solid' && fill.type === 'gradient' && next.type === 'solid') next.color = fill.gradient.stops[0]?.color ?? next.color;
              set(next, 'commit');
            }}
          >
            {k === 'solid' ? 'Color' : k === 'gradient' ? 'Gradient' : 'Pattern'}
          </button>
        ))}
      </div>
      {fill.type === 'solid' && (
        <Field label="Color">
          <ColorField value={fill.color} showHex alpha onChange={(c) => set({ type: 'solid', color: c }, 'preview')} onCommit={(c) => set({ type: 'solid', color: c }, 'commit')} />
        </Field>
      )}
      {fill.type === 'gradient' && (
        <>
          <Field label="Gradient">
            <GradientField value={fill.gradient} onChange={(g) => setGradient(g, 'preview')} onCommit={(g) => setGradient(g, 'commit')} />
          </Field>
          <Field label="Style">
            <Select value={fill.gradient.kind} options={GRADIENT_KINDS} width="100%" onChange={(k) => setGradient({ ...fill.gradient, kind: k }, 'commit')} />
          </Field>
          <Field label="Angle">
            <div className="ui-row">
              <AngleDial
                value={-fill.gradient.angle}
                onChange={(a) => setGradient({ ...fill.gradient, angle: normalizeAngle(-a) }, 'preview')}
                onCommit={(a) => setGradient({ ...fill.gradient, angle: normalizeAngle(-a) }, 'commit')}
              />
              <NumberField
                value={fill.gradient.angle}
                min={-360}
                max={360}
                unit="°"
                width={60}
                onChange={(v) => setGradient({ ...fill.gradient, angle: v }, 'preview')}
                onCommit={(v) => setGradient({ ...fill.gradient, angle: v }, 'commit')}
              />
            </div>
          </Field>
          <Field label="Scale">
            <Slider
              value={fill.gradient.scale}
              min={0.1}
              max={3}
              step={1}
              displayScale={100}
              unit="%"
              onChange={(v) => setGradient({ ...fill.gradient, scale: v }, 'preview')}
              onCommit={(v) => setGradient({ ...fill.gradient, scale: v }, 'commit')}
            />
          </Field>
          <Field label="">
            <Checkbox checked={!!fill.gradient.reverse} label="Reverse" onChange={(v) => setGradient({ ...fill.gradient, reverse: v }, 'commit')} />
          </Field>
        </>
      )}
      {fill.type === 'pattern' && <PatternFillEditor value={fill} onChange={(f) => set(f, 'preview')} onCommit={(f) => set(f, 'commit')} />}
    </Section>
  );
}

/** Minimal param editor for adjustment layers when the adjustments module hasn't registered its section. */
function AdjustmentFallback({ layer }: { layer: Extract<Layer, { type: 'adjustment' }> }) {
  const def = filters.get(layer.adjustment.filterId);
  if (!def) return <div className="layers-note">The “{layer.adjustment.filterId}” adjustment is not available in this build.</div>;
  const values = resolveParams(def, layer.adjustment.params);
  const set = (all: typeof values, phase: ops.Phase) =>
    ops.editLayers([layer.id], `Edit ${def.name}`, (l) => {
      if (l.type === 'adjustment') l.adjustment.params = all;
    }, phase);
  return <ParamEditor defs={def.params} values={values} onChange={(_k, _v, all) => set(all, 'preview')} onCommit={(_k, _v, all) => set(all, 'commit')} />;
}

/* ---------------- Mask ---------------- */

function MaskSection({ doc, layer }: { doc: Document; layer: Layer }) {
  const editTarget = useEditor((st) => (st.activeDocId ? st.sessions[st.activeDocId]?.editTarget : 'content'));
  const mask = layer.mask;
  const id = layer.id;
  if (!mask) {
    return (
      <Section title="Layer Mask" defaultOpen={false}>
        <div className="layers-btnrow">
          <Button size="small" icon={Plus} onClick={() => ops.addMask('reveal')}>
            Reveal All
          </Button>
          <Button size="small" onClick={() => ops.addMask('hide')}>
            Hide All
          </Button>
          <Button size="small" disabled={!doc.selection} onClick={() => ops.addMask('revealSelection')}>
            From Selection
          </Button>
        </div>
      </Section>
    );
  }
  return (
    <Section
      title="Layer Mask"
      actions={<IconButton icon={Trash2} size="sm" title="Delete layer mask" onClick={() => ops.deleteMask()} />}
    >
      <Field label="Density">
        <Slider
          value={mask.density}
          min={0}
          max={1}
          step={1}
          displayScale={100}
          unit="%"
          onChange={(v) => ops.setMaskProps(id, { density: v }, 'preview', 'Mask Density')}
          onCommit={(v) => ops.setMaskProps(id, { density: v }, 'commit', 'Mask Density')}
        />
      </Field>
      <Field label="Feather">
        <Slider
          value={mask.feather}
          min={0}
          max={250}
          step={0.5}
          unit="px"
          onChange={(v) => ops.setMaskProps(id, { feather: v }, 'preview', 'Mask Feather')}
          onCommit={(v) => ops.setMaskProps(id, { feather: v }, 'commit', 'Mask Feather')}
        />
      </Field>
      <Field label="">
        <div className="layers-btnrow">
          <Checkbox checked={mask.enabled} label="Enabled" onChange={() => ops.toggleMaskEnabled(id)} />
          <Checkbox checked={mask.inverted} label="Invert" onChange={() => ops.invertMask(id)} />
        </div>
      </Field>
      <div className="layers-btnrow">
        <Button size="small" variant={editTarget === 'mask' ? 'primary' : undefined} onClick={() => (editTarget === 'mask' ? ops.editContentOf(id) : ops.editMaskOf(id))}>
          {editTarget === 'mask' ? 'Editing Mask' : 'Edit Mask'}
        </Button>
        <IconButton icon={SquareDashedMousePointer} title="Load mask as selection" onClick={() => ops.loadSelectionFromMask(id)} />
        <span style={{ flex: 1 }} />
        <Button size="small" disabled={layer.type === 'group' || layer.type === 'adjustment'} onClick={() => ops.applyMask()}>
          Apply
        </Button>
      </div>
    </Section>
  );
}

/* ---------------- Smart filters ---------------- */

const CATEGORY_ORDER: FilterCategory[] = [
  'Blur',
  'Sharpen',
  'Noise & Grain',
  'Stylize',
  'Comic & Print',
  'Distort',
  'Light',
  'Artistic',
  'Retro & Glitch',
  'Roblox',
  'Color',
  'Adjustments',
  'Other',
];

function addSmartFilterMenu(): MenuItem[] {
  const all = filters.list();
  if (!all.length) return [{ label: 'No filters available', disabled: true }];
  const cats = CATEGORY_ORDER.filter((c) => all.some((f) => f.category === c));
  return cats.map((c) => ({
    label: c,
    submenu: all
      .filter((f) => f.category === c)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ label: `${f.name}…`, run: () => void openFilterDialog(f.id, { mode: 'smart' }) })),
  }));
}

function SmartFiltersSection({ layer }: { layer: Layer }) {
  const [open, setOpen] = useState<string | null>(null);
  const id = layer.id;
  const list = layer.filters;
  return (
    <Section
      title={`Smart Filters${list.length ? ` (${list.length})` : ''}`}
      defaultOpen={list.length > 0}
      actions={<IconButton icon={Plus} size="sm" title="Add smart filter" onClick={(e) => showMenuAt(e.currentTarget, addSmartFilterMenu(), 180)} />}
    >
      {!list.length && <div className="layers-note">Smart filters stay editable. Add one with + or Filter menu ▸ (Smart Filter).</div>}
      {[...list]
        .map((f, i) => ({ f, i }))
        .reverse()
        .map(({ f, i }) => {
          const def = filters.get(f.filterId);
          const expanded = open === f.id;
          const values = def ? resolveParams(def, f.params) : {};
          const label = `Edit ${def?.name ?? 'Smart Filter'}`;
          return (
            <div key={f.id} className="layers-filter-card" onContextMenu={(e) => showContextMenu(e, filterContextMenu(id, f.id))}>
              <div className="layers-filter-card-head">
                <IconButton icon={expanded ? ChevronDown : ChevronRight} size="sm" onClick={() => setOpen(expanded ? null : f.id)} title={expanded ? 'Collapse' : 'Edit parameters'} />
                <Checkbox checked={f.enabled} onChange={() => ops.toggleFilter(id, f.id)} title="Enable smart filter" />
                <span className="name" onClick={() => setOpen(expanded ? null : f.id)} style={!f.enabled ? { color: 'var(--text-faint)' } : undefined}>
                  {def?.name ?? f.filterId}
                </span>
                <IconButton icon={ArrowUp} size="sm" title="Apply later (move up)" disabled={i >= list.length - 1} onClick={() => ops.moveFilter(id, i, i + 1)} />
                <IconButton icon={ArrowDown} size="sm" title="Apply earlier (move down)" disabled={i <= 0} onClick={() => ops.moveFilter(id, i, i - 1)} />
                <IconButton icon={Trash2} size="sm" title="Delete smart filter" onClick={() => ops.removeFilter(id, f.id)} />
              </div>
              {expanded && (
                <div className="layers-filter-card-body">
                  {def ? (
                    def.params.length ? (
                      <ParamEditor
                        defs={def.params}
                        values={values}
                        compact
                        onChange={(_k, _v, all) => ops.updateFilter(id, f.id, (x) => (x.params = all), 'preview', label)}
                        onCommit={(_k, _v, all) => ops.updateFilter(id, f.id, (x) => (x.params = all), 'commit', label)}
                      />
                    ) : (
                      <div className="layers-note">This filter has no parameters.</div>
                    )
                  ) : (
                    <div className="layers-note">The “{f.filterId}” filter is not available in this build.</div>
                  )}
                  <Field label="Opacity">
                    <Slider
                      value={f.opacity ?? 1}
                      min={0}
                      max={1}
                      step={1}
                      displayScale={100}
                      unit="%"
                      onChange={(v) => ops.updateFilter(id, f.id, (x) => (x.opacity = v), 'preview', 'Smart Filter Opacity')}
                      onCommit={(v) => ops.updateFilter(id, f.id, (x) => (x.opacity = v), 'commit', 'Smart Filter Opacity')}
                    />
                  </Field>
                  <Field label="Blend">
                    <Select<BlendMode>
                      value={f.blendMode ?? 'normal'}
                      options={BLEND_MODES}
                      width="100%"
                      onChange={(v) => ops.updateFilter(id, f.id, (x) => (x.blendMode = v), 'commit', 'Smart Filter Blending')}
                    />
                  </Field>
                </div>
              )}
            </div>
          );
        })}
    </Section>
  );
}

/* ---------------- Effects summary ---------------- */

function EffectsSummary({ layer }: { layer: Layer }) {
  if (!layer.effects.length) return null;
  return (
    <Section
      title={`Layer Style (${layer.effects.length})`}
      defaultOpen={false}
      actions={<IconButton icon={Sparkles} size="sm" title="Edit in the Effects panel" onClick={() => useUI.getState().showPanel('effects')} />}
    >
      {layer.effects.map((e) => (
        <div key={e.id} className="ui-row">
          <Checkbox checked={e.enabled} onChange={() => ops.toggleEffect(layer.id, e.id)} label={effectName(e.effectId)} />
        </div>
      ))}
      <div className="layers-btnrow">
        <Button size="small" onClick={() => useUI.getState().showPanel('effects')}>
          Edit Layer Style…
        </Button>
        <Button size="small" variant="ghost" onClick={() => ops.clearStyle()}>
          Clear
        </Button>
      </div>
    </Section>
  );
}
