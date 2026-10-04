/**
 * Libraries panel: Assets (procedural generators) / Shapes (vector presets) / My Assets (imports).
 */
import { assets } from '../../registry';
import { SearchInput, Tabs } from '../../ui/controls';
import { AssetGrid, CategoryChips, useFilteredAssets } from './AssetGrid';
import { AssetSettings } from './AssetSettings';
import { MyAssetsTab } from './MyAssetsTab';
import { ShapesTab } from './ShapesTab';
import type { LibraryTab } from './store';
import { useLibrary } from './store';
import '../assets.css';

const TABS: { value: LibraryTab; label: string }[] = [
  { value: 'assets', label: 'Assets' },
  { value: 'shapes', label: 'Shapes' },
  { value: 'mine', label: 'My Assets' },
];

function AssetsTab() {
  const category = useLibrary((s) => s.category);
  const query = useLibrary((s) => s.query);
  const setCategory = useLibrary((s) => s.setCategory);
  const setQuery = useLibrary((s) => s.setQuery);
  const selectedId = useLibrary((s) => s.selectedId);
  const select = useLibrary((s) => s.select);
  const { all, list, categories } = useFilteredAssets(category, query);
  const selected = selectedId ? assets.get(selectedId) : undefined;
  return (
    <>
      <div className="assets-head" style={{ paddingTop: 0 }}>
        <SearchInput value={query} onChange={setQuery} placeholder={`Search ${all.length} assets`} />
        <CategoryChips categories={categories} value={category} onChange={setCategory} />
      </div>
      <div className="assets-scroll">
        <AssetGrid
          list={list}
          grouped={category === 'All' && !query.trim()}
          selectedId={selectedId}
          onSelect={(id) => select(selectedId === id ? null : id)}
          emptyText={query ? `No assets match “${query}”.` : 'No assets in this category yet.'}
        />
      </div>
      {selected && (
        <div className="assets-drawer">
          <AssetSettings key={selected.id} def={selected} onClose={() => select(null)} compactFooter />
        </div>
      )}
    </>
  );
}

export function LibrariesPanel() {
  const tab = useLibrary((s) => s.tab);
  const setTab = useLibrary((s) => s.setTab);
  return (
    <div className="assets-panel">
      <div className="assets-head" style={{ borderBottom: 'none', paddingBottom: 6 }}>
        <div className="assets-tabs">
          <Tabs value={tab} tabs={TABS} onChange={setTab} />
        </div>
      </div>
      {tab === 'assets' ? <AssetsTab /> : tab === 'shapes' ? <ShapesTab /> : <MyAssetsTab />}
    </div>
  );
}
