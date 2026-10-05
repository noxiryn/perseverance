/**
 * File ▸ Place Asset… — a roomy dialog version of the library: categories, large thumbnails
 * and the asset settings side by side. Its category, search and selection are local to the
 * dialog (the Libraries panel keeps its own); only the per-asset settings are shared.
 */
import { useEffect, useState } from 'react';
import { Library } from 'lucide-react';
import { assets } from '../../registry';
import { Dialog, SearchInput } from '../../ui/controls';
import { placeAssetWhenReady } from '../place';
import { AssetGrid, useFilteredAssets } from './AssetGrid';
import { AssetSettings } from './AssetSettings';
import { useLibrary } from './store';
import '../assets.css';

export function PlaceAssetDialog({ close }: { close: (placed?: boolean) => void }) {
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [selectedId, select] = useState<string | null>(null);
  const { all, list, categories } = useFilteredAssets(category, query);
  const selected = selectedId ? assets.get(selectedId) : undefined;

  // the settings column follows the grid: preselect the first visible asset, and move the
  // selection when a category/search change hides the selected one
  useEffect(() => {
    if (list.length && (!selected || !list.some((d) => d.id === selected.id))) select(list[0].id);
  }, [selected, list]);

  const activate = async (id: string) => {
    const st = useLibrary.getState().settings[id];
    if (await placeAssetWhenReady(id, st?.params, { blendMode: st?.blendMode, opacity: st?.opacity })) close(true);
  };

  return (
    <Dialog
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Library size={15} /> Place Asset
        </span>
      }
      width={1040}
      onClose={() => close()}
    >
      <div className="assets-dialog">
        <nav className="assets-dialog-nav">
          {[{ name: 'All', count: all.length }, ...categories].map((c) => (
            <button key={c.name} className={`assets-nav-item${category === c.name ? ' active' : ''}`} onClick={() => setCategory(c.name)}>
              <span>{c.name}</span>
              <span>{c.count}</span>
            </button>
          ))}
        </nav>
        <div className="assets-dialog-main">
          <div className="assets-head">
            <SearchInput value={query} onChange={setQuery} placeholder={`Search ${all.length} assets`} autoFocus />
          </div>
          <div className="assets-scroll">
            <AssetGrid
              list={list}
              grouped={category === 'All' && !query.trim()}
              large
              selectedId={selectedId}
              onSelect={select}
              onActivate={(id) => void activate(id)}
              emptyText={query ? `No assets match “${query}”.` : 'No assets in this category yet.'}
            />
          </div>
        </div>
        <aside className="assets-dialog-side">
          {selected ? (
            <AssetSettings key={selected.id} def={selected} onPlaced={() => close(true)} compactFooter />
          ) : (
            <div className="assets-empty">Select an asset to adjust it before placing.</div>
          )}
        </aside>
      </div>
    </Dialog>
  );
}
