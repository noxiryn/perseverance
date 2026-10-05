/**
 * Libraries panel: Assets (procedural generators) / Shapes (vector presets) / My Assets (imports).
 */
import { useEffect, useRef, useState } from 'react';
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

/** Below this panel height the settings drawer covers the whole panel instead of its bottom. */
const OVERLAY_BELOW = 520;

function AssetsTab({ compact }: { compact: boolean }) {
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
          clickPlaces
        />
      </div>
      {selected && (
        <div className={`assets-drawer${compact ? ' overlay' : ''}`}>
          <AssetSettings key={selected.id} def={selected} onClose={() => select(null)} compactFooter backButton={compact} />
        </div>
      )}
    </>
  );
}

export function LibrariesPanel() {
  const tab = useLibrary((s) => s.tab);
  const setTab = useLibrary((s) => s.setTab);
  const root = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCompact(el.clientHeight < OVERLAY_BELOW));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="assets-panel" ref={root}>
      <div className="assets-head" style={{ borderBottom: 'none', paddingBottom: 6 }}>
        <div className="assets-tabs">
          <Tabs value={tab} tabs={TABS} onChange={setTab} />
        </div>
      </div>
      {tab === 'assets' ? <AssetsTab compact={compact} /> : tab === 'shapes' ? <ShapesTab /> : <MyAssetsTab />}
    </div>
  );
}
