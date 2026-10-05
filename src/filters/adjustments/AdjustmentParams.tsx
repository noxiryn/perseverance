/**
 * The settings area of one adjustment, shared by the panel / Properties editor and the
 * destructive Image ▸ Adjustments dialog: custom Photoshop-style editors for Levels, Curves,
 * Color Balance, Selective Color and Exposure, the generic ParamEditor for the rest.
 * `onChange` fires continuously (live preview), `onCommit` once per finished interaction.
 */
import { useMemo } from 'react';
import type { CurvesValue, ParamValue, ParamValues } from '../../core/types';
import type { FilterDef } from '../../registry';
import { CurvesEditor, IDENTITY_CURVES, ParamEditor } from '../../ui/controls';
import { clippedBins } from './HistogramCanvas';
import type { Histogram } from './histogram';
import { isCurves } from './params';
import { LevelsEditor } from './LevelsEditor';
import { ColorBalanceEditor } from './ColorBalanceEditor';
import { SelectiveColorEditor } from './SelectiveColorEditor';
import { ExposureEditor } from './ExposureEditor';
import { presetSwatchCss } from './swatches';

/** Adjustments with a dedicated editor (the destructive menu commands open them in our own dialog). */
export const CUSTOM_EDITOR_IDS: ReadonlySet<string> = new Set(['levels', 'curves', 'color-balance', 'selective-color', 'exposure']);

/** Adjustments whose editor shows the histogram of their input. */
export const HISTOGRAM_IDS: ReadonlySet<string> = new Set(['levels', 'curves']);

/** Palette preview of the selected Color Lookup look (sample colors through the look). */
function LookStrip({ values }: { values: ParamValues }) {
  const css = presetSwatchCss('color-lookup', values);
  if (!css) return null;
  return (
    <div className="adjustments-look-strip" style={{ background: css }} title="Shadows · skin · red · foliage · sky · highlights through the look" />
  );
}

export function AdjustmentParams({
  def,
  values,
  onChange,
  onCommit,
  histogram,
  width,
}: {
  def: FilterDef;
  values: ParamValues;
  onChange: (all: ParamValues) => void;
  onCommit: (all: ParamValues) => void;
  histogram: Histogram | null;
  /** Content width available for the histogram / curve grid. */
  width: number;
}) {
  const curvesHist = useMemo(() => (histogram ? clippedBins(histogram.lum) : undefined), [histogram]);
  switch (def.id) {
    case 'levels':
      return <LevelsEditor values={values} onChange={onChange} onCommit={onCommit} histogram={histogram} width={Math.max(160, width)} />;
    case 'curves': {
      const curvesValue: CurvesValue = isCurves(values.curves) ? values.curves : IDENTITY_CURVES;
      return (
        <div className="adjustments-curves">
          <CurvesEditor
            value={curvesValue}
            size={Math.max(160, Math.min(width, 320))}
            histogram={curvesHist}
            onChange={(c) => onChange({ ...values, curves: c })}
            onCommit={(c) => onCommit({ ...values, curves: c })}
          />
          <div className="adjustments-hint">Click to add a point · drag to move · drag off the grid to remove</div>
        </div>
      );
    }
    case 'color-balance':
      return <ColorBalanceEditor values={values} onChange={onChange} onCommit={onCommit} />;
    case 'selective-color':
      return <SelectiveColorEditor values={values} onChange={onChange} onCommit={onCommit} />;
    case 'exposure':
      return <ExposureEditor values={values} onChange={onChange} onCommit={onCommit} />;
  }
  if (!def.params.length) return <div className="adjustments-hint">{def.description ?? 'This adjustment has no settings.'}</div>;
  return (
    <>
      <ParamEditor
        defs={def.params}
        values={values}
        onChange={(_k: string, _v: ParamValue, all: ParamValues) => onChange(all)}
        onCommit={(_k: string, _v: ParamValue, all: ParamValues) => onCommit(all)}
      />
      {def.id === 'color-lookup' && <LookStrip values={values} />}
    </>
  );
}
