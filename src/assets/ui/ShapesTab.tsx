/**
 * Shapes tab: vector shape presets from the registry (live-updating as modules register them).
 * Click adds a shape layer filled with the primary color; drag drops it at the cursor.
 */
import { memo, useMemo } from 'react';
import { Shapes } from 'lucide-react';
import type { ShapePresetDef } from '../../registry';
import { shapePresets, useRegistry } from '../../registry';
import { SearchInput } from '../../ui/controls';
import { useEditor } from '../../state/editor';
import { startDrag } from '../lib/dnd';
import { addShapePreset } from '../lib/shapes';
import { CategoryChips } from './AssetGrid';
import { useLibrary } from './store';

const ShapeCard = memo(function ShapeCard({ preset }: { preset: ShapePresetDef }) {
  const [x, y, w, h] = preset.viewBox;
  // pad the viewBox slightly so strokes/edges are not clipped
  const pad = Math.max(w, h) * 0.04;
  return (
    <div
      className="assets-card"
      title={`${preset.name} — click to add, or drag onto the canvas`}
      draggable
      onDragStart={(e) => startDrag(e, { kind: 'shape', id: preset.id })}
      onClick={() => addShapePreset(preset.id)}
    >
      <div className="assets-shape">
        <svg viewBox={`${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
          <path d={preset.path} fill="currentColor" fillRule={preset.evenOdd ? 'evenodd' : 'nonzero'} />
        </svg>
      </div>
      <div className="assets-card-name">{preset.name}</div>
    </div>
  );
});

export function ShapesTab() {
  const all = useRegistry(shapePresets);
  const category = useLibrary((s) => s.shapeCategory);
  const query = useLibrary((s) => s.shapeQuery);
  const setCategory = useLibrary((s) => s.setShapeCategory);
  const setQuery = useLibrary((s) => s.setShapeQuery);
  const primary = useEditor((s) => s.primaryColor);
  const { categories, list } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of all) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    const q = query.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const list = all.filter((p) => {
      if (category !== 'All' && p.category !== category) return false;
      const hay = `${p.name} ${p.id} ${p.category}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    return { categories: [...counts.entries()].map(([name, count]) => ({ name, count })), list };
  }, [all, category, query]);

  return (
    <>
      <div className="assets-head" style={{ borderTop: 'none', paddingTop: 0 }}>
        <SearchInput value={query} onChange={setQuery} placeholder={`Search ${all.length} shapes`} />
        {categories.length > 1 && <CategoryChips categories={categories} value={category} onChange={setCategory} />}
      </div>
      <div className="assets-scroll">
        {!all.length ? (
          <div className="assets-empty">
            <Shapes size={18} />
            Shape presets will appear here as soon as they are loaded.
          </div>
        ) : !list.length ? (
          <div className="assets-empty">No shapes match your search.</div>
        ) : (
          <>
            <div className="assets-group-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Fill
              <span style={{ width: 10, height: 10, borderRadius: 2, background: primary, border: '1px solid #555', display: 'inline-block' }} />
              <span style={{ textTransform: 'none', letterSpacing: 0 }}>primary color</span>
            </div>
            <div className="assets-grid">
              {list.map((p) => (
                <ShapeCard key={p.id} preset={p} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
