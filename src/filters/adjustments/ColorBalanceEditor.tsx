/**
 * Photoshop-style Color Balance editor: Tone tabs (Shadows / Midtones / Highlights, a dot marks
 * tones with edits), three bipolar sliders on tinted tracks (Cyan–Red, Magenta–Green,
 * Yellow–Blue; double-click a slider to zero it) and Preserve Luminosity.
 * Keys: shadowsR/G/B, midR/G/B, highR/G/B (-100..100), preserveLuminosity.
 */
import { useState, type CSSProperties } from 'react';
import type { ParamValues } from '../../core/types';
import { Checkbox, NumberField, Tabs } from '../../ui/controls';
import { bool, num } from './params';

type Tone = 'shadows' | 'mid' | 'high';

const TONES: { value: Tone; label: string }[] = [
  { value: 'shadows', label: 'Shadows' },
  { value: 'mid', label: 'Midtones' },
  { value: 'high', label: 'Highlights' },
];

const AXES = [
  { ch: 'R', left: 'Cyan', right: 'Red', from: '#22c8d0', to: '#e0393e' },
  { ch: 'G', left: 'Magenta', right: 'Green', from: '#cf3fcf', to: '#3cc95a' },
  { ch: 'B', left: 'Yellow', right: 'Blue', from: '#e3cf35', to: '#3d6ee0' },
] as const;

export function ColorBalanceEditor({
  values,
  onChange,
  onCommit,
}: {
  values: ParamValues;
  onChange: (all: ParamValues) => void;
  onCommit: (all: ParamValues) => void;
}) {
  const [tone, setTone] = useState<Tone>('mid');
  const edited = (t: Tone) => AXES.some((a) => num(values, `${t}${a.ch}`, 0) !== 0);
  const set = (key: string, v: number, commit: boolean) => {
    const next = { ...values, [key]: Math.round(Math.max(-100, Math.min(100, v))) };
    onChange(next);
    if (commit) onCommit(next);
  };

  return (
    <div className="adjustments-cb">
      <Tabs
        value={tone}
        onChange={setTone}
        tabs={TONES.map((t) => ({
          value: t.value,
          label: (
            <span className="adjustments-cb-tab">
              {t.label}
              {edited(t.value) && <span className="dot" title="This tonal range has changes" />}
            </span>
          ),
        }))}
      />
      {AXES.map((a) => {
        const key = `${tone}${a.ch}`;
        const v = num(values, key, 0, -100, 100);
        const style = { '--from': a.from, '--to': a.to } as CSSProperties;
        return (
          <div className="adjustments-cb-row" key={key}>
            <span className={`l${v < 0 ? ' on' : ''}`}>{a.left}</span>
            <input
              type="range"
              className="adjustments-cb-range"
              min={-100}
              max={100}
              step={1}
              value={v}
              style={style}
              title={`${a.left} ↔ ${a.right} (double-click to reset)`}
              aria-label={`${TONES.find((t) => t.value === tone)?.label} ${a.left} to ${a.right}`}
              onChange={(e) => set(key, Number(e.target.value), false)}
              onPointerUp={(e) => set(key, Number((e.target as HTMLInputElement).value), true)}
              onKeyUp={(e) => set(key, Number((e.target as HTMLInputElement).value), true)}
              onDoubleClick={() => set(key, 0, true)}
            />
            <span className={`r${v > 0 ? ' on' : ''}`}>{a.right}</span>
            <NumberField value={v} min={-100} max={100} width={44} onChange={(n) => set(key, n, false)} onCommit={(n) => set(key, n, true)} />
          </div>
        );
      })}
      <Checkbox
        checked={bool(values, 'preserveLuminosity', true)}
        label="Preserve Luminosity"
        onChange={(b) => {
          const next = { ...values, preserveLuminosity: b };
          onChange(next);
          onCommit(next);
        }}
      />
    </div>
  );
}
