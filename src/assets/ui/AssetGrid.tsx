/**
 * Asset browser grid (Assets tab of the Libraries panel and the Place Asset dialog).
 */
import { useMemo, useRef } from 'react';
import { Search } from 'lucide-react';
import type { AssetDef } from '../../registry';
import { assets, useRegistry } from '../../registry';
import { CATEGORY_ORDER } from '../catalog';
import { startDrag } from '../lib/dnd';
import { placeAsset } from '../place';
import { AssetThumb } from './AssetThumb';
import { matchesQuery, useLibrary } from './store';

/** Registered assets grouped by category in library order (optionally filtered). */
export function useFilteredAssets(category: string, query: string): { all: AssetDef[]; list: AssetDef[]; categories: { name: string; count: number }[] } {
  const all = useRegistry(assets);
  return useMemo(() => {
    const order = (c: string) => {
      const i = CATEGORY_ORDER.indexOf(c as (typeof CATEGORY_ORDER)[number]);
      return i < 0 ? 99 : i;
    };
    const sorted = all
      .map((d, i) => ({ d, i }))
      .sort((a, b) => order(a.d.category) - order(b.d.category) || a.i - b.i)
      .map((x) => x.d);
    const counts = new Map<string, number>();
    for (const d of sorted) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
    const categories = [...counts.entries()].map(([name, count]) => ({ name, count }));
    const list = sorted.filter((d) => (category === 'All' || d.category === category) && matchesQuery(d, query));
    return { all: sorted, list, categories };
  }, [all, category, query]);
}

export function CategoryChips({
  categories,
  value,
  onChange,
  wrap,
}: {
  categories: { name: string; count: number }[];
  value: string;
  onChange: (c: string) => void;
  wrap?: boolean;
}) {
  return (
    <div className={`assets-chips${wrap ? ' wrap' : ''}`}>
      {[{ name: 'All', count: 0 }, ...categories].map((c) => (
        <button key={c.name} className={`assets-chip${value === c.name ? ' active' : ''}`} onClick={() => onChange(c.name)} title={c.count ? `${c.count} assets` : undefined}>
          {c.name}
        </button>
      ))}
    </div>
  );
}

function AssetCard({
  def,
  selected,
  onSelect,
  onActivate,
  thumbSize,
}: {
  def: AssetDef;
  selected: boolean;
  onSelect: () => void;
  onActivate: () => void;
  thumbSize: number;
}) {
  const thumb = useRef<HTMLCanvasElement | null>(null);
  const settings = useLibrary((s) => s.settings[def.id]);
  return (
    <div
      className={`assets-card${selected ? ' selected' : ''}`}
      title={`${def.name} — click for settings, double-click to place, or drag onto the canvas`}
      draggable
      onDragStart={(e) => startDrag(e, { kind: 'asset', id: def.id, params: settings?.params, blendMode: settings?.blendMode, opacity: settings?.opacity }, thumb.current)}
      onClick={onSelect}
      onDoubleClick={onActivate}
    >
      <AssetThumb assetId={def.id} size={thumbSize} badge={def.sizing === 'document' ? undefined : 'Sticker'} onCanvas={(c) => (thumb.current = c)} />
      <div className="assets-card-name">{def.name}</div>
    </div>
  );
}

export function AssetGrid({
  list,
  grouped,
  large,
  selectedId,
  onSelect,
  onActivate,
  emptyText,
}: {
  list: AssetDef[];
  grouped?: boolean;
  large?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onActivate?: (id: string) => void;
  emptyText?: string;
}) {
  // double-click = quick place with the asset's defaults
  const activate = onActivate ?? ((id: string) => placeAsset(id));
  if (!list.length)
    return (
      <div className="assets-empty">
        <Search size={18} />
        {emptyText ?? 'No assets match your search.'}
      </div>
    );
  const cards = (items: AssetDef[]) => (
    <div className={`assets-grid${large ? ' large' : ''}`}>
      {items.map((d) => (
        <AssetCard
          key={d.id}
          def={d}
          thumbSize={large ? 200 : 128}
          selected={selectedId === d.id}
          onSelect={() => onSelect(d.id)}
          onActivate={() => activate(d.id)}
        />
      ))}
    </div>
  );
  if (!grouped) return cards(list);
  const groups: { name: string; items: AssetDef[] }[] = [];
  for (const d of list) {
    const g = groups[groups.length - 1];
    if (g && g.name === d.category) g.items.push(d);
    else groups.push({ name: d.category, items: [d] });
  }
  return (
    <>
      {groups.map((g) => (
        <div key={g.name}>
          <div className="assets-group-title">{g.name}</div>
          {cards(g.items)}
        </div>
      ))}
    </>
  );
}
