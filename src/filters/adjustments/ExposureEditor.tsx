/**
 * Exposure editor: Exposure and Offset as regular sliders, Gamma Correction on a logarithmic
 * slider centred on 1.0 (0.1 … 10 across the track, the number field still reaches 0.01), so the
 * useful 0.3–3 range gets most of the track instead of the first 30% of a linear 0.01–9.99 one.
 */
import type { ParamValue, ParamValues } from '../../core/types';
import { Field, NumberField, ParamEditor } from '../../ui/controls';
import { exposure } from './defs/tonal';
import { RANGE_KEYS } from './ColorBalanceEditor';
import { num } from './params';

const LINEAR_DEFS = exposure.params.filter((d) => d.key !== 'gamma');
const LOG_SPAN = Math.log(10);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Slider position (0..1) of a gamma value: 0.1 → 0, 1 → 0.5, 10 → 1. */
export const gammaToSlider = (g: number) => clamp((Math.log(Math.max(1e-6, g)) / LOG_SPAN + 1) / 2, 0, 1);

/** Gamma for a slider position, rounded to 0.01 and snapped to 1.00 near the centre. */
export function sliderToGamma(p: number, min = 0.01, max = 9.99): number {
  const g = Math.exp((clamp(p, 0, 1) * 2 - 1) * LOG_SPAN);
  const r = Math.round(g * 100) / 100;
  return clamp(Math.abs(r - 1) < 0.025 ? 1 : r, min, max);
}

/** A `.ui-slider`-styled range on a log scale around 1, with a numeric field. Double-click resets to 1. */
export function LogGammaSlider({
  value,
  onChange,
  onCommit,
  min = 0.01,
  max = 9.99,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const pos = gammaToSlider(value);
  const read = (el: HTMLInputElement) => sliderToGamma(Number(el.value) / 1000, min, max);
  return (
    <div className="ui-slider adjustments-log-slider">
      <input
        type="range"
        min={0}
        max={1000}
        step={1}
        value={Math.round(pos * 1000)}
        style={{ ['--pct' as string]: `${pos * 100}%` }}
        title="Gamma (logarithmic: 1.0 in the middle) · double-click to reset"
        onChange={(e) => onChange(read(e.target))}
        onPointerUp={(e) => onCommit(read(e.target as HTMLInputElement))}
        onKeyUp={(e) => {
          if (RANGE_KEYS.has(e.key)) onCommit(read(e.target as HTMLInputElement));
        }}
        onDoubleClick={() => {
          onChange(1);
          onCommit(1);
        }}
      />
      <NumberField value={value} min={min} max={max} step={0.01} onChange={onChange} onCommit={onCommit} />
    </div>
  );
}

export function ExposureEditor({
  values,
  onChange,
  onCommit,
}: {
  values: ParamValues;
  onChange: (all: ParamValues) => void;
  onCommit: (all: ParamValues) => void;
}) {
  const gamma = num(values, 'gamma', 1, 0.01, 9.99);
  return (
    <div className="adjustments-stack">
      <ParamEditor
        defs={LINEAR_DEFS}
        values={values}
        onChange={(_k: string, _v: ParamValue, all: ParamValues) => onChange(all)}
        onCommit={(_k: string, _v: ParamValue, all: ParamValues) => onCommit(all)}
      />
      <Field label="Gamma" hint="Gamma Correction: below 1 darkens the midtones, above 1 brightens them (logarithmic slider, 1.0 in the middle)">
        <LogGammaSlider value={gamma} onChange={(g) => onChange({ ...values, gamma: g })} onCommit={(g) => onCommit({ ...values, gamma: g })} />
      </Field>
    </div>
  );
}
