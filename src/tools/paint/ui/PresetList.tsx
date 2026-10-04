/** Brush preset list/grid with live stroke previews + the options-bar preset picker. */
import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { BrushPresetDef } from '../../../registry';
import { brushPresets, useRegistry } from '../../../registry';
import { useToolOptions } from '../../../state/editor';
import { SearchInput, Popover, Slider, showContextMenu, type MenuItem } from '../../../ui/controls';
import { defaultsFor, setOpt, type BrushToolOptions } from '../options';
import { applyPreset } from '../presets/apply';
import type { PaintBrushPreset } from '../presets/presets';
import { presetPreview, tipThumbnail } from './preview';
import { CanvasView } from './widgets';
import { ChevronDown } from 'lucide-react';
import '../paint.css';

/* ---------------- staged preview rendering (keeps the UI responsive) ---------------- */

type Job = () => void;
const queue: Job[] = [];
let scheduled = false;
function runQueue() {
  scheduled = false;
  const t0 = performance.now();
  while (queue.length && performance.now() - t0 < 8) queue.shift()!();
  if (queue.length) schedule();
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(runQueue);
}

function usePresetPreview(preset: BrushPresetDef, w: number, h: number): HTMLCanvasElement | null {
  const [src, setSrc] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let alive = true;
    queue.push(() => {
      if (alive) setSrc(presetPreview(preset, w, h));
    });
    schedule();
    return () => {
      alive = false;
    };
  }, [preset, w, h]);
  return src;
}

/* ---------------- list ---------------- */

const CATEGORY_ORDER = ['Basic', 'Dry Media', 'Grunge & Texture', 'FX & Particles', 'Hair', 'My Brushes'];

export function groupPresets(list: BrushPresetDef[], query: string): { name: string; items: BrushPresetDef[] }[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? list.filter((p) => `${p.name} ${p.category} ${(p as PaintBrushPreset).description ?? ''}`.toLowerCase().includes(q))
    : list;
  const map = new Map<string, BrushPresetDef[]>();
  for (const p of filtered) {
    const arr = map.get(p.category);
    if (arr) arr.push(p);
    else map.set(p.category, [p]);
  }
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i < 0 ? CATEGORY_ORDER.length - 1 : i;
  };
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([name, items]) => ({ name, items }));
}

function PresetItem({
  preset,
  selected,
  view,
  onPick,
  menu,
}: {
  preset: BrushPresetDef;
  selected: boolean;
  view: 'list' | 'grid';
  onPick: (p: BrushPresetDef) => void;
  menu?: (p: BrushPresetDef) => MenuItem[];
}) {
  const grid = view === 'grid';
  const src = usePresetPreview(preset, grid ? 72 : 132, grid ? 40 : 30);
  const user = !!(preset as PaintBrushPreset).user;
  const desc = (preset as PaintBrushPreset).description;
  return (
    <div
      className={`paint-preset ${grid ? 'grid' : 'list'}${selected ? ' selected' : ''}`}
      title={`${preset.name} — ${Math.round(preset.size)} px${desc ? `\n${desc}` : ''}`}
      onClick={() => onPick(preset)}
      onContextMenu={menu ? (e) => showContextMenu(e, menu(preset)) : undefined}
    >
      {grid ? (
        <>
          <CanvasView source={src} width={72} height={40} className="paint-preset-stroke" />
          <span className="paint-preset-name">{preset.name}</span>
        </>
      ) : (
        <>
          <span className="paint-preset-size">{Math.round(preset.size)}</span>
          <span className="paint-preset-name">{preset.name}</span>
          <CanvasView source={src} width={132} height={30} className="paint-preset-stroke" />
        </>
      )}
      {user && menu && (
        <button
          className="paint-preset-del"
          title="Delete preset"
          onClick={(e) => {
            e.stopPropagation();
            const del = menu(preset).find((m) => m.label?.startsWith('Delete'));
            del?.run?.();
          }}
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

export function PresetList({
  selectedId,
  onPick,
  view = 'list',
  query = '',
  menu,
}: {
  selectedId: string | null;
  onPick: (p: BrushPresetDef) => void;
  view?: 'list' | 'grid';
  query?: string;
  menu?: (p: BrushPresetDef) => MenuItem[];
}) {
  const list = useRegistry(brushPresets);
  const groups = useMemo(() => groupPresets(list, query), [list, query]);
  if (!groups.length) return <div className="paint-empty">No brushes match “{query}”.</div>;
  return (
    <div className="paint-presets">
      {groups.map((g) => (
        <div key={g.name} className="paint-presets-group">
          <div className="paint-presets-cat">{g.name}</div>
          <div className={view === 'grid' ? 'paint-presets-grid' : 'paint-presets-list'}>
            {g.items.map((p) => (
              <PresetItem key={p.id} preset={p} selected={p.id === selectedId} view={view} onPick={onPick} menu={menu} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- tip thumbnail ---------------- */

export function TipThumb({ presetId, hardness, size = 22, square, pencil }: { presetId: string; hardness: number; size?: number; square?: boolean; pencil?: boolean }) {
  const presets = useRegistry(brushPresets);
  const src = useMemo(() => tipThumbnail(presetId, hardness, size, { square, pencil }), [presetId, hardness, size, square, pencil, presets]);
  return <CanvasView source={src} width={size} height={size} className="paint-tip-thumb" />;
}

/* ---------------- options-bar picker ---------------- */

export function PresetPicker({ toolId }: { toolId: 'brush' | 'eraser' | 'clone-stamp' }) {
  const o = useToolOptions(toolId, defaultsFor(toolId) as BrushToolOptions);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const textured = !!brushPresets.get(o.presetId)?.tip;
  return (
    <>
      <button className="paint-picker-btn" title="Brush preset picker" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <TipThumb presetId={o.presetId} hardness={o.hardness} size={20} />
        <span className="paint-picker-size">{Math.round(o.size)}</span>
        <ChevronDown size={10} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-start" width={300}>
          <div className="paint-picker">
            <div className="paint-picker-row">
              <span className="paint-opt-label">Size</span>
              <Slider value={o.size} onChange={(v) => setOpt(toolId, 'size', v)} min={1} max={1000} unit="px" />
            </div>
            <div className="paint-picker-row" style={textured ? { opacity: 0.45, pointerEvents: 'none' } : undefined} title={textured ? 'Hardness applies to round tips' : undefined}>
              <span className="paint-opt-label">Hardness</span>
              <Slider value={o.hardness} onChange={(v) => setOpt(toolId, 'hardness', v)} min={0} max={1} step={1} displayScale={100} unit="%" />
            </div>
            <SearchInput value={query} onChange={setQuery} placeholder="Search brushes" />
            <div className="paint-picker-list">
              <PresetList selectedId={o.presetId} query={query} onPick={(p) => applyPreset(p, toolId)} />
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
