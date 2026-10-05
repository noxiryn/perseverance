/**
 * Photoshop-style Selective Color editor: a row of color-range chips (a dot marks ranges with
 * edits), the Cyan / Magenta / Yellow / Black sliders of the shown range, and Method.
 *
 * The shown range is editor-local view state, like Color Balance's tone tabs: switching it is not
 * an edit (no history step, no dirty document). The stored `range` param is only read to pick the
 * initial range and followed when it changes from outside (a preset or its undo).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParamValue, ParamValues } from '../../core/types';
import { ParamEditor } from '../../ui/controls';
import { RANGE_LABELS, SELECTIVE_RANGES, selectiveColor, type SelectiveRange } from './defs/color';
import { num } from './params';

const CHIP_COLORS: Record<SelectiveRange, string> = {
  reds: '#e0393e',
  yellows: '#e3cf35',
  greens: '#3cc95a',
  cyans: '#22c8d0',
  blues: '#3d6ee0',
  magentas: '#cf3fcf',
  whites: '#f2f2f2',
  neutrals: '#808080',
  blacks: '#0d0d0d',
};

const INKS = ['C', 'M', 'Y', 'K'] as const;
const SLIDER_DEFS = selectiveColor.params.filter((d) => d.key !== 'range');

const asRange = (v: unknown): SelectiveRange =>
  typeof v === 'string' && (SELECTIVE_RANGES as readonly string[]).includes(v) ? (v as SelectiveRange) : 'reds';

export function isRangeEdited(values: ParamValues, r: SelectiveRange): boolean {
  return INKS.some((c) => num(values, `${r}${c}`, 0) !== 0);
}

/** Range to show first: the stored one if it has edits, else the first edited range, else the stored one. */
export function initialRange(values: ParamValues): SelectiveRange {
  const stored = asRange(values.range);
  if (isRangeEdited(values, stored)) return stored;
  return SELECTIVE_RANGES.find((r) => isRangeEdited(values, r)) ?? stored;
}

export function SelectiveColorEditor({
  values,
  onChange,
  onCommit,
}: {
  values: ParamValues;
  onChange: (all: ParamValues) => void;
  onCommit: (all: ParamValues) => void;
}) {
  const stored = asRange(values.range);
  const [range, setRange] = useState<SelectiveRange>(() => initialRange(values));
  // Follow the stored range only when it changes from outside (preset, undo of a preset).
  const lastStored = useRef(stored);
  useEffect(() => {
    if (lastStored.current === stored) return;
    lastStored.current = stored;
    setRange(stored);
  }, [stored]);

  const view = useMemo(() => ({ ...values, range }), [values, range]);
  // Edits keep the stored `range` value: what is being viewed is not part of the edit.
  const keep = (all: ParamValues): ParamValues => ({ ...all, range: values.range ?? stored });

  return (
    <div className="adjustments-sc">
      <div className="adjustments-sc-head">
        <span className="ui-label">Colors</span>
        <span className="adjustments-sc-name">{RANGE_LABELS[range]}</span>
      </div>
      <div className="adjustments-sc-ranges" role="radiogroup" aria-label="Color range">
        {SELECTIVE_RANGES.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={r === range}
            className={`adjustments-sc-chip${r === range ? ' current' : ''}${r === 'whites' ? ' gap' : ''}`}
            style={{ background: CHIP_COLORS[r] }}
            title={`${RANGE_LABELS[r]}${isRangeEdited(values, r) ? ' (edited)' : ''}`}
            onClick={() => setRange(r)}
          >
            {isRangeEdited(values, r) && <span className="dot" />}
          </button>
        ))}
      </div>
      <ParamEditor
        defs={SLIDER_DEFS}
        values={view}
        onChange={(_k: string, _v: ParamValue, all: ParamValues) => onChange(keep(all))}
        onCommit={(_k: string, _v: ParamValue, all: ParamValues) => onCommit(keep(all))}
      />
    </div>
  );
}
