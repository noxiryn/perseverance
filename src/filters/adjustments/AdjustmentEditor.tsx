/**
 * Editor for one adjustment layer (shared by the Adjustments panel and the Properties panel):
 * header (icon, name, clip / visibility / reset / delete), preset dropdown, then the params —
 * custom Levels and Curves editors with the histogram of the layers below, a Photoshop-style
 * Color Balance editor, ParamEditor for the rest. Edits preview live and commit as coalesced history steps.
 */
import { useMemo } from 'react';
import { Eye, EyeOff, RotateCcw, SquareArrowDownLeft, Trash2, WandSparkles } from 'lucide-react';
import type { AdjustmentLayer, CurvesValue, ID, ParamValue, ParamValues } from '../../core/types';
import { filters, gradientPresets, useRegistry } from '../../registry';
import { useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { Button, CurvesEditor, IconButton, IDENTITY_CURVES, ParamEditor, Select } from '../../ui/controls';
import { parentOf, siblingsOf } from '../../core/document';
import { resolveParams } from '../engine';
import { autoContrastParams, autoToneCurves } from './auto';
import { clippedBins } from './HistogramCanvas';
import { isCurves } from './params';
import { LevelsEditor } from './LevelsEditor';
import { ColorBalanceEditor } from './ColorBalanceEditor';
import { presetSwatchCss } from './swatches';
import { isCustomName, matchPreset, presetsFor } from './presets';
import {
  commitAdjustmentParams,
  deleteAdjustmentLayer,
  previewAdjustmentParams,
  resetAdjustment,
  setAdjustmentParams,
  toggleClipped,
  toggleVisible,
} from './layers';
import { useBelowHistogram, useElementWidth } from './useBelowHistogram';
import './adjustments.css';

/** Palette preview of the selected Color Lookup look (sample colors through the look). */
function LookStrip({ values }: { values: ParamValues }) {
  const css = presetSwatchCss('color-lookup', values);
  if (!css) return null;
  return (
    <div className="adjustments-look-strip" style={{ background: css }} title="Shadows · skin · red · foliage · sky · highlights through the look" />
  );
}

function useLayer(layerId: ID): AdjustmentLayer | null {
  return useEditor((s) => {
    const l = s.activeDocId ? s.sessions[s.activeDocId]?.doc.layers[layerId] : undefined;
    return l && l.type === 'adjustment' ? l : null;
  });
}

/** Name of the layer an adjustment is clipped to (nearest non-clipped layer below), if any. */
function useClipBaseName(layerId: ID): string | null {
  return useEditor((s) => {
    const doc = s.activeDocId ? s.sessions[s.activeDocId]?.doc : null;
    if (!doc || parentOf(doc, layerId) === undefined) return null;
    const sibs = siblingsOf(doc, layerId);
    for (let i = sibs.indexOf(layerId) - 1; i >= 0; i--) {
      const l = doc.layers[sibs[i]];
      if (l && !l.clipped) return l.name;
    }
    return null;
  });
}

export function AdjustmentEditor({ layerId, context = 'panel' }: { layerId: ID; context?: 'panel' | 'properties' }) {
  const layer = useLayer(layerId);
  const all = useRegistry(filters);
  const gradients = useRegistry(gradientPresets); // gradient-map presets come from this registry
  const def = layer ? all.find((f) => f.id === layer.adjustment.filterId) : undefined;
  const clipBase = useClipBaseName(layerId);
  const [bodyRef, width] = useElementWidth<HTMLDivElement>(context === 'panel' ? 260 : 230);
  const needsHistogram = def?.id === 'levels' || def?.id === 'curves';
  const histogram = useBelowHistogram(layer ? layerId : null, !!needsHistogram);

  const values = useMemo(() => (def && layer ? resolveParams(def, layer.adjustment.params) : {}), [def, layer]);
  const presets = useMemo(() => (def ? presetsFor(def.id) : []), [def, gradients]);
  const current = def ? matchPreset(def, values, presets) : null;
  const curvesHist = useMemo(() => (histogram ? clippedBins(histogram.lum) : undefined), [histogram]);

  if (!layer) return <div className="ui-empty">Select an adjustment layer to edit its settings.</div>;
  if (!def) {
    return (
      <div className="ui-empty">The “{layer.adjustment.filterId}” adjustment is not available in this version. The layer is kept unchanged.</div>
    );
  }

  const Icon = def.icon;
  const change = (next: ParamValues) => previewAdjustmentParams(layerId, next);
  const commit = (next: ParamValues) => commitAdjustmentParams(layerId, next);
  const onParam = (_k: string, _v: ParamValue, next: ParamValues) => change(next);
  const onParamCommit = (_k: string, _v: ParamValue, next: ParamValues) => commit(next);

  const presetOptions = [
    ...(current === null ? [{ value: '__custom', label: 'Custom' }] : []),
    { value: 'Default', label: 'Default' },
    ...presets.map((p) => ({ value: p.name, label: p.name })),
  ];
  const applyPreset = (name: string) => {
    if (name === '__custom') return;
    if (name === 'Default') return resetAdjustment(layerId);
    const p = presets.find((x) => x.name === name);
    if (p) setAdjustmentParams(layerId, p.params, `${def.name}: ${p.name}`);
  };

  const auto = () => {
    if (!histogram || !histogram.count) return toast('Nothing below this adjustment to analyse yet.', 'info');
    if (def.id === 'levels') {
      const p = autoContrastParams(histogram);
      if (!p) return toast('Levels: the image already uses its full tonal range.', 'info');
      setAdjustmentParams(layerId, { ...values, ...p, gamma: 1, outBlack: 0, outWhite: 255 }, 'Auto Levels');
    } else {
      const c = autoToneCurves(histogram);
      if (!c) return toast('Curves: the image already uses its full tonal range.', 'info');
      setAdjustmentParams(layerId, { curves: c }, 'Auto Curves');
    }
  };

  const curvesValue: CurvesValue = isCurves(values.curves) ? values.curves : IDENTITY_CURVES;

  const clipButton = (
    <IconButton
      icon={SquareArrowDownLeft}
      size="sm"
      active={layer.clipped}
      title={layer.clipped ? 'Release clipping (affect all layers below)' : 'Clip to layer below (affect only that layer)'}
      onClick={() => toggleClipped(layerId)}
    />
  );
  const visibilityButton = (
    <IconButton
      icon={layer.visible ? Eye : EyeOff}
      size="sm"
      active={!layer.visible}
      title={layer.visible ? 'Hide adjustment' : 'Show adjustment'}
      onClick={() => toggleVisible(layerId)}
    />
  );
  const resetButton = <IconButton icon={RotateCcw} size="sm" title="Reset to defaults" onClick={() => resetAdjustment(layerId)} />;
  const deleteButton = <IconButton icon={Trash2} size="sm" title="Delete adjustment layer" onClick={() => deleteAdjustmentLayer(layerId)} />;
  const clipText = layer.clipped ? `Clipped to ${clipBase ? `“${clipBase}”` : 'the layer below'}` : 'Affects all layers below';

  return (
    <div className={`adjustments-editor ${context}`}>
      {context === 'panel' ? (
        <>
          <div className="adjustments-editor-head">
            <span className="adjustments-editor-icon">{Icon ? <Icon size={15} strokeWidth={1.7} /> : null}</span>
            <span className="adjustments-editor-title" title={`${layer.name} — ${def.name}`}>
              <span className="name">{def.name}</span>
              {isCustomName(layer.name, def.name) && <span className="layer">{layer.name}</span>}
            </span>
            {clipButton}
            {visibilityButton}
            {resetButton}
            {deleteButton}
          </div>
          <div className="adjustments-editor-sub">
            <span className={`clip${layer.clipped ? ' on' : ''}`}>{clipText}</span>
            {!layer.visible && <span className="hidden-badge">Hidden</span>}
          </div>
        </>
      ) : (
        // Properties panel: its header already shows the layer name, icon and visibility.
        <div className="adjustments-editor-head compact">
          <span className="adjustments-editor-kind" title={clipText}>
            {def.name}
            <span className={`clip${layer.clipped ? ' on' : ''}`}>{layer.clipped ? 'Clipped' : ''}</span>
          </span>
          {clipButton}
          {resetButton}
          {deleteButton}
        </div>
      )}

      {/* Color Lookup's presets are exactly its Look list, so the dropdown would be redundant. */}
      {(presets.length > 0 || def.params.length > 0) && def.id !== 'color-lookup' && (
        <div className="adjustments-preset-row">
          <span className="ui-label">Preset</span>
          <Select value={current ?? '__custom'} options={presetOptions} onChange={applyPreset} width="100%" title="Adjustment preset" />
          {needsHistogram && (
            <Button size="small" icon={WandSparkles} onClick={auto} title="Compute automatically from the histogram">
              Auto
            </Button>
          )}
        </div>
      )}

      <div className="adjustments-editor-body" ref={bodyRef}>
        {def.id === 'levels' ? (
          <LevelsEditor values={values} onChange={change} onCommit={commit} histogram={histogram} width={Math.max(160, width)} />
        ) : def.id === 'curves' ? (
          <div className="adjustments-curves">
            <CurvesEditor
              value={curvesValue}
              size={Math.max(160, Math.min(width, 320))}
              histogram={curvesHist}
              onChange={(c) => change({ ...values, curves: c })}
              onCommit={(c) => commit({ ...values, curves: c })}
            />
            <div className="adjustments-hint">Click to add a point · drag to move · drag off the grid to remove</div>
          </div>
        ) : def.id === 'color-balance' ? (
          <ColorBalanceEditor values={values} onChange={change} onCommit={commit} />
        ) : def.params.length ? (
          <>
            <ParamEditor defs={def.params} values={values} onChange={onParam} onCommit={onParamCommit} />
            {def.id === 'color-lookup' && <LookStrip values={values} />}
          </>
        ) : (
          <div className="adjustments-hint">{def.description ?? 'This adjustment has no settings.'}</div>
        )}
      </div>
    </div>
  );
}
