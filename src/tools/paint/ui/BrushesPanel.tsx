/**
 * Brushes panel: preset browser (list/grid with real stroke previews) and editable brush
 * settings bound to the current brush-like tool's options. Save/rename/delete user presets.
 */
import { useEffect, useMemo, useState } from 'react';
import { LayoutGrid, List, RotateCcw, Save } from 'lucide-react';
import type { BrushPresetDef } from '../../../registry';
import { brushPresets, tools, useRegistry } from '../../../registry';
import { useEditor, useToolOptions } from '../../../state/editor';
import { openDialog, toast } from '../../../state/ui';
import { AngleDial, Button, Checkbox, IconButton, SearchInput, Section, Slider, Tabs, type MenuItem } from '../../../ui/controls';
import { defaultsFor, isRetouchTool, setOpts, type BrushSettings, type BrushToolOptions } from '../options';
import { applyPreset, panelTargetTool } from '../presets/apply';
import type { PaintBrushPreset } from '../presets/presets';
import { deleteUserPreset, renameUserPreset, saveUserPreset } from '../presets/user';
import { renderStrokePreview } from './preview';
import { PresetList, TipThumb } from './PresetList';
import { SavePresetDialog } from './SavePresetDialog';
import { CanvasView } from './widgets';
import '../paint.css';

const VIEW_KEY = 'perseverance.paint.brushesView';

function readView(): 'list' | 'grid' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

/** Width (CSS px) of an element, tracked with a ResizeObserver. */
function useElementWidth(fallback: number): [(el: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const update = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) >= 2 ? w : prev));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/** Debounced live preview of the current settings. */
function useSettingsPreview(settings: BrushSettings, w: number, h: number): HTMLCanvasElement | null {
  const [src, setSrc] = useState<HTMLCanvasElement | null>(null);
  const key = JSON.stringify(settings);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try {
        setSrc(renderStrokePreview(settings, w, h, { seed: 3 }));
      } catch (err) {
        console.error('[paint] settings preview failed', err);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [key, w, h]); // eslint-disable-line react-hooks/exhaustive-deps
  return src;
}

function SliderRow({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  displayScale,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  displayScale?: number;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className={`paint-row${disabled ? ' disabled' : ''}`} title={hint}>
      <span className="paint-row-label">{label}</span>
      <Slider value={value} onChange={onChange} min={min} max={max} step={step} unit={unit} displayScale={displayScale} />
    </div>
  );
}

const PCT = { min: 0, max: 1, step: 1, displayScale: 100, unit: '%' } as const;

export function BrushesPanel() {
  const activeTool = useEditor((s) => s.activeTool);
  const toolId = panelTargetTool(activeTool);
  const retouch = isRetouchTool(toolId);
  const opts = useToolOptions(toolId, defaultsFor(toolId) as BrushToolOptions);
  const presets = useRegistry(brushPresets);
  const toolList = useRegistry(tools);
  const toolName = toolList.find((t) => t.id === toolId)?.name ?? 'Brush';
  const [tab, setTab] = useState<'presets' | 'settings'>('presets');
  const [view, setViewState] = useState<'list' | 'grid'>(readView);
  const [query, setQuery] = useState('');
  const setView = (v: 'list' | 'grid') => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const current = presets.find((p) => p.id === opts.presetId) ?? null;
  const textured = !!current?.tip;
  const settings: BrushSettings = useMemo(
    () => ({
      presetId: opts.presetId ?? 'round-hard',
      size: opts.size,
      hardness: opts.hardness,
      spacing: opts.spacing ?? 0.1,
      flow: opts.flow ?? 1,
      opacity: opts.opacity ?? 1,
      angle: opts.angle ?? 0,
      roundness: opts.roundness ?? 1,
      sizeJitter: opts.sizeJitter ?? 0,
      angleJitter: opts.angleJitter ?? 0,
      scatter: opts.scatter ?? 0,
      opacityJitter: opts.opacityJitter ?? 0,
      pressureSize: !!opts.pressureSize,
      pressureOpacity: !!opts.pressureOpacity,
      followDirection: !!opts.followDirection,
      smoothing: opts.smoothing ?? 0,
    }),
    [opts],
  );
  const [headRef, headWidth] = useElementWidth(268);
  const previewW = Math.max(120, headWidth - 20);
  const preview = useSettingsPreview(retouch ? { ...settings, presetId: '', flow: 1 } : settings, previewW, 46);
  const set = (key: keyof BrushToolOptions, value: unknown) => setOpts(toolId, { [key]: value });

  const pick = (p: BrushPresetDef) => {
    const target = applyPreset(p);
    if (target !== activeTool) toast(`${p.name} — ${tools.get(target)?.name ?? 'Brush'} tool selected`, 'info', 1600);
  };

  const menu = (p: BrushPresetDef): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Use Brush', run: () => pick(p) }];
    if ((p as PaintBrushPreset).user) {
      items.push(
        { separator: true },
        {
          label: 'Rename…',
          run: async () => {
            const name = await openDialog<string, { initial: string; title: string }>(SavePresetDialog, { initial: p.name, title: 'Rename Brush' });
            if (name) renameUserPreset(p.id, name);
          },
        },
        {
          label: 'Delete Brush',
          run: () => {
            deleteUserPreset(p.id);
            toast(`Deleted brush “${p.name}”`, 'info');
          },
        },
      );
    }
    return items;
  };

  const save = async () => {
    const name = await openDialog<string, { initial: string; title: string }>(SavePresetDialog, {
      initial: current ? `${current.name} copy` : 'My Brush',
      title: 'Save Brush Preset',
    });
    if (!name) return;
    const p = saveUserPreset(name, settings, toolId === 'brush' ? !!opts.airbrush : undefined);
    setOpts(toolId, { presetId: p.id });
    toast(`Saved brush “${p.name}”`, 'success');
  };

  const resetToPreset = () => {
    if (!current) return;
    applyPreset(current, toolId);
  };

  return (
    <div className="paint-panel">
      <div className="paint-panel-head" ref={headRef}>
        <CanvasView source={preview} width={previewW} height={46} className="paint-panel-preview" />
        <div className="paint-panel-meta">
          <TipThumb presetId={retouch ? '' : settings.presetId} hardness={settings.hardness} size={16} />
          <span className="paint-panel-name">{retouch ? 'Round' : (current?.name ?? 'Custom')}</span>
          <span className="paint-panel-size">{Math.round(settings.size)} px</span>
          <span className="paint-panel-tool" title="The tool these settings apply to">
            {toolName}
          </span>
        </div>
      </div>
      <div className="paint-panel-tabs">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'presets', label: 'Presets' },
            { value: 'settings', label: 'Settings' },
          ]}
        />
        {tab === 'presets' && (
          <div className="paint-panel-viewbtns">
            <IconButton icon={List} size="sm" active={view === 'list'} title="List view" onClick={() => setView('list')} />
            <IconButton icon={LayoutGrid} size="sm" active={view === 'grid'} title="Grid view" onClick={() => setView('grid')} />
          </div>
        )}
      </div>

      {tab === 'presets' ? (
        <>
          <div className="paint-panel-search">
            <SearchInput value={query} onChange={setQuery} placeholder="Search brushes" />
          </div>
          <div className="paint-panel-scroll">
            <PresetList selectedId={retouch ? null : opts.presetId} view={view} query={query} onPick={pick} menu={menu} />
          </div>
        </>
      ) : (
        <div className="paint-panel-scroll">
          <Section title="Tip">
            <SliderRow label="Size" value={settings.size} onChange={(v) => set('size', v)} min={1} max={1000} unit="px" />
            <SliderRow
              label="Hardness"
              value={settings.hardness}
              onChange={(v) => set('hardness', v)}
              {...PCT}
              disabled={textured && !retouch}
              hint={textured && !retouch ? 'Hardness applies to round tips only' : undefined}
            />
            {!retouch && (
              <>
                <div className="paint-row">
                  <span className="paint-row-label">Angle</span>
                  <div className="paint-row-angle">
                    <AngleDial value={-settings.angle} onChange={(v) => set('angle', -Math.round(v))} />
                    <Slider value={settings.angle} onChange={(v) => set('angle', v)} min={-180} max={180} unit="°" />
                  </div>
                </div>
                <SliderRow label="Roundness" value={settings.roundness} onChange={(v) => set('roundness', Math.max(0.02, v))} {...PCT} />
              </>
            )}
            <SliderRow label="Spacing" value={settings.spacing} onChange={(v) => set('spacing', Math.max(0.01, v))} min={0.01} max={2} step={1} displayScale={100} unit="%" />
          </Section>
          {!retouch && (
            <Section title="Dynamics">
              <SliderRow label="Size jitter" value={settings.sizeJitter} onChange={(v) => set('sizeJitter', v)} {...PCT} />
              <SliderRow label="Angle jitter" value={settings.angleJitter} onChange={(v) => set('angleJitter', v)} {...PCT} />
              <SliderRow label="Opacity jitter" value={settings.opacityJitter} onChange={(v) => set('opacityJitter', v)} {...PCT} />
              <SliderRow label="Scatter" value={settings.scatter} onChange={(v) => set('scatter', v)} {...PCT} />
              <div className="paint-checks">
                <Checkbox checked={settings.pressureSize} onChange={(v) => set('pressureSize', v)} label="Pressure → size" />
                <Checkbox checked={settings.pressureOpacity} onChange={(v) => set('pressureOpacity', v)} label="Pressure → opacity" />
                <Checkbox checked={settings.followDirection} onChange={(v) => set('followDirection', v)} label="Follow stroke direction" />
              </div>
            </Section>
          )}
          <Section title="Transfer & Smoothing">
            {!retouch && (
              <>
                <SliderRow label="Opacity" value={settings.opacity} onChange={(v) => set('opacity', v)} {...PCT} />
                <SliderRow label="Flow" value={settings.flow} onChange={(v) => set('flow', Math.max(0.01, v))} {...PCT} />
              </>
            )}
            <SliderRow label="Smoothing" value={settings.smoothing} onChange={(v) => set('smoothing', v)} min={0} max={100} unit="%" />
            {toolId === 'brush' && (
              <div className="paint-checks">
                <Checkbox checked={!!opts.airbrush} onChange={(v) => set('airbrush', v)} label="Airbrush build-up" />
              </div>
            )}
          </Section>
        </div>
      )}

      {!retouch && (
        <div className="paint-panel-foot">
          <Button size="small" icon={Save} onClick={save} title="Save the current settings as a new brush preset">
            Save as Preset
          </Button>
          <Button size="small" variant="ghost" icon={RotateCcw} onClick={resetToPreset} disabled={!current} title="Restore the selected preset's settings">
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}
