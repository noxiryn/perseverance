/**
 * Adjustments panel (id 'adjustments'): "Add an adjustment" icon grid of every filter flagged
 * `adjustment: true` (read reactively from the registry, so other modules' adjustments such as
 * Vignette appear too), optional one-click preset list, and the editor of the active
 * adjustment layer. Click = new adjustment layer above the active layer (it joins the clipping
 * group it lands in); Alt-click = inverted clipping (clipped to the layer below).
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import type { FilterDef } from '../../registry';
import { filters, gradientPresets, useRegistry } from '../../registry';
import { useActiveLayer, useActiveSession } from '../../state/editor';
import { AdjustmentEditor } from './AdjustmentEditor';
import { createAdjustmentLayer } from './layers';
import { orderAdjustments, presetsFor } from './presets';
import { useAdjustmentsPrefs } from './prefs';
import { presetSwatchCss } from './swatches';
import './adjustments.css';

function useAdjustmentRows(): FilterDef[][] {
  const list = useRegistry(filters);
  return useMemo(() => orderAdjustments(list.filter((f) => f.adjustment && !f.hidden)), [list]);
}

function AddGrid({
  rows,
  activeFilterId,
  disabled,
  onHover,
}: {
  rows: FilterDef[][];
  activeFilterId: string | null;
  disabled: boolean;
  onHover: (def: FilterDef | null) => void;
}) {
  const clipDefault = useAdjustmentsPrefs((s) => s.clipByDefault);
  return (
    <div className={`adjustments-grid${disabled ? ' disabled' : ''}`} onMouseLeave={() => onHover(null)}>
      {rows.map((row, i) => (
        <div className="adjustments-grid-row" key={i}>
          {row.map((def) => {
            const Icon = def.icon ?? SlidersHorizontal;
            return (
              <button
                key={def.id}
                className={`adjustments-add-btn${activeFilterId === def.id ? ' current' : ''}`}
                title={`${def.name}\n${clipDefault ? 'Click: new layer clipped to the layer below · Alt-click: unclipped' : 'Click: new adjustment layer (joins a clipping group it lands in) · Alt-click: toggle clipping'}`}
                aria-label={`Add ${def.name} adjustment`}
                onClick={(e) => createAdjustmentLayer(def.id, { invertClip: e.altKey })}
                onMouseEnter={() => onHover(def)}
                onFocus={() => onHover(def)}
                onBlur={() => onHover(null)}
              >
                <Icon size={17} strokeWidth={1.6} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PresetList({ rows }: { rows: FilterDef[][] }) {
  useRegistry(gradientPresets);
  const [open, setOpen] = useState<string | null>(null);
  const clipDefault = useAdjustmentsPrefs((s) => s.clipByDefault);
  const defs = rows.flat().filter((d) => presetsFor(d.id).length > 0);
  return (
    <div className="adjustments-presets">
      {defs.map((def) => {
        const Icon = def.icon ?? SlidersHorizontal;
        const isOpen = open === def.id;
        return (
          <div key={def.id} className="adjustments-preset-group">
            <button className="adjustments-preset-head" onClick={() => setOpen(isOpen ? null : def.id)}>
              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Icon size={13} strokeWidth={1.7} />
              <span className="name">{def.name}</span>
              <span className="count">{presetsFor(def.id).length}</span>
            </button>
            {isOpen && (
              <div className="adjustments-preset-items">
                {presetsFor(def.id).map((p) => {
                  const swatch = presetSwatchCss(def.id, p.params);
                  return (
                    <button
                      key={p.name}
                      className="adjustments-preset-item"
                      title={`New ${def.name} layer: ${p.name} (Alt-click: ${clipDefault ? 'unclipped' : 'toggle clipping'})`}
                      onClick={(e) =>
                        createAdjustmentLayer(def.id, {
                          params: p.params,
                          name: p.name,
                          label: `New ${def.name} Layer`,
                          invertClip: e.altKey,
                        })
                      }
                    >
                      {swatch && <span className="adjustments-preset-swatch" style={{ background: swatch }} />}
                      <span className="label">{p.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AdjustmentsPanel() {
  const session = useActiveSession();
  const layer = useActiveLayer();
  const rows = useAdjustmentRows();
  const showPresets = useAdjustmentsPrefs((s) => s.showPresets);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [hovered, setHovered] = useState<FilterDef | null>(null);
  const adj = layer && layer.type === 'adjustment' ? layer : null;

  return (
    <div className="adjustments-panel">
      <div className="adjustments-scroll">
        <div className="adjustments-section">
          <div className={`adjustments-heading${hovered ? ' hover' : ''}`}>
            <span>{hovered ? hovered.name : 'Add an adjustment'}</span>
          </div>
          <AddGrid rows={rows} activeFilterId={adj?.adjustment.filterId ?? null} disabled={!session} onHover={setHovered} />
          {!session && <div className="adjustments-hint center">Open or create a document to add adjustments.</div>}
        </div>

        {/* Without a document: one empty state only (the dimmed grid + hint above). */}
        {showPresets && session && (
          <div className="adjustments-section">
            <button className="adjustments-heading toggle" onClick={() => setPresetsOpen(!presetsOpen)}>
              {presetsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>Adjustment presets</span>
            </button>
            {presetsOpen && <PresetList rows={rows} />}
          </div>
        )}

        {session && (
          <div className="adjustments-section grow">
            {adj ? (
              <AdjustmentEditor key={adj.id} layerId={adj.id} context="panel" />
            ) : (
              <div className="adjustments-empty">
                <SlidersHorizontal size={22} strokeWidth={1.4} />
                <div>
                  {layer
                    ? `“${layer.name}” is not an adjustment layer. Click an icon above to add one above it, or select an adjustment layer to edit it.`
                    : 'Click an icon above to add an adjustment layer, or select one in the Layers panel to edit it.'}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
