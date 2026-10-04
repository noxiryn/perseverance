/** Custom shape preset picker: trigger button + popover with search, categories and SVG previews. */
import { memo, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { shapePresets, useRegistry, type ShapePresetDef } from '../../registry';
import { Popover, SearchInput } from '../../ui/controls';
import { SHAPE_PRESET_CATEGORIES } from './presets';
import './shape.css';

export const PresetGlyph = memo(function PresetGlyph({ preset, size = 40 }: { preset: ShapePresetDef; size?: number }) {
  const [x, y, w, h] = preset.viewBox;
  const pad = Math.max(w, h) * 0.06;
  return (
    <svg width={size} height={size} viewBox={`${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <path d={preset.path} fillRule={preset.evenOdd ? 'evenodd' : 'nonzero'} fill="currentColor" />
    </svg>
  );
});

export function PresetPicker({ value, onChange, compact }: { value: string; onChange: (id: string) => void; compact?: boolean }) {
  const list = useRegistry(shapePresets);
  const current = list.find((p) => p.id === value) ?? list[0];
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        className={`shape-preset-trigger${compact ? ' compact' : ''}${anchor ? ' open' : ''}`}
        title="Choose a custom shape"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        {current ? <PresetGlyph preset={current} size={compact ? 16 : 18} /> : null}
        <span className="shape-preset-name">{current?.name ?? 'No shapes'}</span>
        <ChevronDown size={11} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-start" className="shape-pop">
          <PresetBrowser
            value={value}
            onPick={(id) => {
              onChange(id);
              setAnchor(null);
            }}
          />
        </Popover>
      )}
    </>
  );
}

export function PresetBrowser({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  const list = useRegistry(shapePresets);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('All');
  const cats = useMemo(() => {
    const extra = [...new Set(list.map((p) => p.category))].filter((c) => !(SHAPE_PRESET_CATEGORIES as readonly string[]).includes(c));
    return ['All', ...SHAPE_PRESET_CATEGORIES.filter((c) => list.some((p) => p.category === c)), ...extra];
  }, [list]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter(
      (p) =>
        (cat === 'All' || p.category === cat) &&
        (!needle || p.name.toLowerCase().includes(needle) || p.id.includes(needle) || p.category.toLowerCase().includes(needle)),
    );
  }, [list, q, cat]);
  return (
    <div className="shape-browser">
      <SearchInput value={q} onChange={setQ} placeholder="Search shapes" autoFocus />
      <div className="shape-cats">
        {cats.map((c) => (
          <button key={c} className={`shape-cat${c === cat ? ' active' : ''}`} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="shape-grid">
        {shown.map((p) => (
          <button key={p.id} className={`shape-tile${p.id === value ? ' active' : ''}`} title={`${p.name} — ${p.category}`} onClick={() => onPick(p.id)}>
            <PresetGlyph preset={p} size={34} />
          </button>
        ))}
        {!shown.length && <div className="shape-empty">No shapes match “{q}”.</div>}
      </div>
      <div className="shape-browser-foot">
        {shown.length} shape{shown.length === 1 ? '' : 's'}
      </div>
    </div>
  );
}
