/**
 * Auto-generated form for a ParamDef list. Used by filters, adjustments, effects, assets, looks…
 * `onChange` fires continuously while dragging (use it for live preview); `onCommit` fires once
 * when an interaction ends (use it to create a history entry).
 */
import { useRef, useState } from 'react';
import { Dices } from 'lucide-react';
import type { CurvesValue, Gradient, ParamDef, ParamValue, ParamValues, Point } from '../../core/types';
import { Checkbox, Field, NumberField, Select, Slider, TextInput } from './basic';
import { ColorField } from './color';
import { GradientField } from './gradient';
import { CurvesEditor } from './curves';
import { FontSelect } from './fontSelect';

export function ParamEditor({
  defs,
  values,
  onChange,
  onCommit,
  compact,
}: {
  defs: ParamDef[];
  values: ParamValues;
  onChange: (key: string, value: ParamValue, all: ParamValues) => void;
  onCommit?: (key: string, value: ParamValue, all: ParamValues) => void;
  compact?: boolean;
}) {
  let lastGroup: string | undefined;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 4 : 6 }}>
      {defs.map((d) => {
        if (d.showIf && !d.showIf(values)) return null;
        const v = values[d.key] ?? (d.default as ParamValue);
        const set = (nv: ParamValue) => onChange(d.key, nv, { ...values, [d.key]: nv });
        const commit = (nv: ParamValue) => onCommit?.(d.key, nv, { ...values, [d.key]: nv });
        const header =
          d.group && d.group !== lastGroup ? (
            <div key={`g_${d.group}`} className="ui-menu-heading" style={{ padding: '6px 0 0' }}>
              {d.group}
            </div>
          ) : null;
        lastGroup = d.group;
        return (
          <div key={d.key} style={{ display: 'contents' }}>
            {header}
            <ParamControl def={d} value={v} set={set} commit={commit} />
          </div>
        );
      })}
    </div>
  );
}

function ParamControl({
  def: d,
  value: v,
  set,
  commit,
}: {
  def: ParamDef;
  value: ParamValue;
  set: (v: ParamValue) => void;
  commit: (v: ParamValue) => void;
}) {
  switch (d.type) {
    case 'number':
      return (
        <Field label={d.label} hint={d.hint}>
          <Slider
            value={v as number}
            min={d.min}
            max={d.max}
            step={d.step ?? 1}
            unit={d.unit}
            displayScale={d.displayScale}
            onChange={set}
            onCommit={commit}
          />
        </Field>
      );
    case 'angle':
      return (
        <Field label={d.label} hint={d.hint}>
          <div className="ui-row">
            <AngleDial value={v as number} onChange={set} onCommit={commit} />
            <NumberField value={v as number} min={-360} max={360} unit="°" width={60} onChange={set} onCommit={commit} />
          </div>
        </Field>
      );
    case 'boolean':
      return (
        <Field label="" hint={d.hint}>
          <Checkbox
            checked={!!v}
            label={d.label}
            onChange={(b) => {
              set(b);
              commit(b);
            }}
          />
        </Field>
      );
    case 'color':
      return (
        <Field label={d.label} hint={d.hint}>
          <ColorField value={v as string} alpha={d.alpha} onChange={set} onCommit={commit} showHex />
        </Field>
      );
    case 'select':
      return (
        <Field label={d.label} hint={d.hint}>
          <Select
            value={v as string}
            options={d.options}
            width="100%"
            onChange={(s) => {
              set(s);
              commit(s);
            }}
          />
        </Field>
      );
    case 'gradient':
      return (
        <Field label={d.label} hint={d.hint}>
          <GradientField value={v as Gradient} onChange={set} onCommit={commit} />
        </Field>
      );
    case 'curves':
      return (
        <div>
          <div className="ui-label" style={{ marginBottom: 4 }}>
            {d.label}
          </div>
          <CurvesEditor value={v as CurvesValue} onChange={set} onCommit={commit} />
        </div>
      );
    case 'seed':
      return (
        <Field label={d.label} hint={d.hint}>
          <div className="ui-row">
            <NumberField value={v as number} min={0} max={999999} width={72} onChange={set} onCommit={commit} />
            <button
              className="ui-icon-btn"
              title="Randomize"
              onClick={() => {
                const s = Math.floor(Math.random() * 999999);
                set(s);
                commit(s);
              }}
            >
              <Dices size={14} />
            </button>
          </div>
        </Field>
      );
    case 'text':
      return (
        <Field label={d.label} hint={d.hint}>
          <TextInput value={v as string} multiline={d.multiline} onChange={set} onCommit={commit} />
        </Field>
      );
    case 'font':
      return (
        <Field label={d.label} hint={d.hint}>
          <FontSelect
            value={v as string}
            onChange={(f) => {
              set(f);
              commit(f);
            }}
          />
        </Field>
      );
    case 'point':
      return (
        <Field label={d.label} hint={d.hint}>
          <PointPad value={v as Point} onChange={set} onCommit={commit} />
        </Field>
      );
  }
}

export function AngleDial({
  value,
  onChange,
  onCommit,
  size = 26,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  size?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const down = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const cx = r.left + r.width / 2,
      cy = r.top + r.height / 2;
    let last = value;
    const handle = (ev: PointerEvent | React.PointerEvent) => {
      let a = (Math.atan2(-(ev.clientY - cy), ev.clientX - cx) * 180) / Math.PI;
      if (ev.shiftKey) a = Math.round(a / 15) * 15;
      last = Math.round(a);
      onChange(last);
    };
    handle(e);
    const move = (ev: PointerEvent) => handle(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommit?.(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const rad = (value * Math.PI) / 180;
  return (
    <div
      ref={ref}
      onPointerDown={down}
      title="Drag to set angle (Shift snaps to 15°)"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: '1px solid #4a4a4a',
        background: 'var(--bg-input)',
        position: 'relative',
        cursor: 'pointer',
        flex: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: size / 2 - 3,
          height: 1.5,
          background: 'var(--text)',
          transformOrigin: '0 50%',
          transform: `rotate(${-rad}rad)`,
        }}
      />
    </div>
  );
}

function PointPad({ value, onChange, onCommit }: { value: Point; onChange: (p: Point) => void; onCommit?: (p: Point) => void }) {
  const [drag, setDrag] = useState(false);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    let last = value;
    const handle = (ev: PointerEvent | React.PointerEvent) => {
      last = {
        x: Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * 1000) / 1000,
        y: Math.round(Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) * 1000) / 1000,
      };
      onChange(last);
    };
    setDrag(true);
    handle(e);
    const move = (ev: PointerEvent) => handle(ev);
    const up = () => {
      setDrag(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommit?.(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="ui-row">
      <div
        onPointerDown={down}
        style={{
          width: 64,
          height: 40,
          background: 'var(--bg-input)',
          border: '1px solid #444',
          borderRadius: 3,
          position: 'relative',
          cursor: drag ? 'grabbing' : 'crosshair',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: `${value.x * 100}%`,
            top: `${value.y * 100}%`,
            width: 8,
            height: 8,
            margin: -4,
            borderRadius: '50%',
            background: 'var(--accent)',
            border: '1px solid #fff',
          }}
        />
      </div>
      <span className="ui-label">
        {Math.round(value.x * 100)}%, {Math.round(value.y * 100)}%
      </span>
    </div>
  );
}
