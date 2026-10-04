/**
 * File ▸ Place Asset… — a roomy dialog version of the library: categories, large thumbnails
 * and the asset settings side by side.
 */
import { useEffect } from 'react';
import { Library } from 'lucide-react';
import { assets } from '../../registry';
import { Dialog, SearchInput } from '../../ui/controls';
import { placeAsset } from '../place';
import { AssetGrid, useFilteredAssets } from './AssetGrid';
import { AssetSettings } from './AssetSettings';
import { useLibrary } from './store';
import '../assets.css';

export function PlaceAssetDialog({ close }: { close: (placed?: boolean) => void }) {
  const category = useLibrary((s) => s.category);
  const query = useLibrary((s) => s.query);
  const setCategory = useLibrary((s) => s.setCategory);
  const setQuery = useLibrary((s) => s.setQuery);
  const selectedId = useLibrary((s) => s.selectedId);
  const select = useLibrary((s) => s.select);
  const { all, list, categories } = useFilteredAssets(category, query);
  const selected = selectedId ? assets.get(selectedId) : undefined;

  // preselect the first visible asset so the settings column is never empty
  useEffect(() => {
    if (!selected && list.length) select(list[0].id);
  }, [selected, list, select]);

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
              onActivate={(id) => {
                const st = useLibrary.getState().settings[id];
                if (placeAsset(id, st?.params, { blendMode: st?.blendMode, opacity: st?.opacity })) close(true);
              }}
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
