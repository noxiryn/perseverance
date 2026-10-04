/**
 * Photoshop-style Levels editor: histogram, draggable input black / midtone / white triangles,
 * output range bar with two triangles, and numeric fields.
 */
import { useRef } from 'react';
import type { ParamValues } from '../../core/types';
import { NumberField } from '../../ui/controls';
import { HistogramCanvas } from './HistogramCanvas';
import type { Histogram } from './histogram';
import { levelsParams } from './defs/tonal';

type Handle = 'inBlack' | 'gamma' | 'inWhite' | 'outBlack' | 'outWhite';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Relative position (0..1) of the midtone slider between black and white for a gamma. */
export const gammaToPos = (gamma: number) => Math.pow(0.5, gamma);
export const posToGamma = (p: number) => clamp(Math.log(clamp(p, 0.001, 0.999)) / Math.log(0.5), 0.1, 9.99);

function Tri({ x, fill, title, onPointerDown }: { x: number; fill: string; title: string; onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div className="adjustments-tri" style={{ left: `${(x / 255) * 100}%` }} title={title} onPointerDown={onPointerDown}>
      <svg width="12" height="10" viewBox="0 0 12 10">
        <path d="M6 0.8 L11.2 9.2 L0.8 9.2 Z" fill={fill} stroke="#cfcfcf" strokeWidth="1" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function LevelsEditor({
  values,
  onChange,
  onCommit,
  histogram,
  width,
}: {
  values: ParamValues;
  onChange: (all: ParamValues) => void;
  onCommit: (all: ParamValues) => void;
  histogram: Histogram | null;
  width: number;
}) {
  const v = levelsParams(values);
  const inRef = useRef<HTMLDivElement>(null);
  const outRef = useRef<HTMLDivElement>(null);

  const startDrag = (which: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = (which === 'outBlack' || which === 'outWhite' ? outRef : inRef).current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const start = { ...values, ...v };
    let last: ParamValues | null = null;
    const compute = (clientX: number): ParamValues => {
      const x = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * 255;
      const next: ParamValues = { ...start };
      if (which === 'inBlack') next.inBlack = Math.round(clamp(x, 0, v.inWhite - 2));
      else if (which === 'inWhite') next.inWhite = Math.round(clamp(x, v.inBlack + 2, 255));
      else if (which === 'gamma') next.gamma = round2(posToGamma((x - v.inBlack) / Math.max(1, v.inWhite - v.inBlack)));
      else if (which === 'outBlack') next.outBlack = Math.round(x);
      else next.outWhite = Math.round(x);
      return next;
    };
    const move = (ev: PointerEvent) => {
      last = compute(ev.clientX);
      onChange(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (last) onCommit(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const field = (key: Handle, value: number, min: number, max: number, step = 1, w = 52) => {
    const fix = (nv: number): ParamValues => {
      const next: ParamValues = { ...values, ...v, [key]: nv };
      if (key === 'inBlack') next.inBlack = Math.round(clamp(nv, 0, v.inWhite - 2));
      if (key === 'inWhite') next.inWhite = Math.round(clamp(nv, v.inBlack + 2, 255));
      if (key === 'gamma') next.gamma = round2(clamp(nv, 0.1, 9.99));
      return next;
    };
    return (
      <NumberField
        value={value}
        min={min}
        max={max}
        step={step}
        width={w}
        onChange={(nv) => onChange(fix(nv))}
        onCommit={(nv) => onCommit(fix(nv))}
      />
    );
  };

  const grayX = v.inBlack + (v.inWhite - v.inBlack) * gammaToPos(v.gamma);

  return (
    <div className="adjustments-levels">
      <HistogramCanvas histogram={histogram} width={width} height={100} />
      <div className="adjustments-tri-track" ref={inRef} style={{ width }}>
        <div
          className="adjustments-range-shade"
          style={{ left: `${(v.inBlack / 255) * 100}%`, width: `${((v.inWhite - v.inBlack) / 255) * 100}%` }}
        />
        <Tri x={v.inBlack} fill="#0d0d0d" title="Input black point" onPointerDown={startDrag('inBlack')} />
        <Tri x={grayX} fill="#7f7f7f" title="Midtones (gamma)" onPointerDown={startDrag('gamma')} />
        <Tri x={v.inWhite} fill="#ffffff" title="Input white point" onPointerDown={startDrag('inWhite')} />
      </div>
      <div className="adjustments-levels-fields" style={{ width }}>
        {field('inBlack', v.inBlack, 0, 253)}
        {field('gamma', v.gamma, 0.1, 9.99, 0.01, 56)}
        {field('inWhite', v.inWhite, 2, 255)}
      </div>
      <div className="adjustments-sublabel">Output Levels</div>
      <div className="adjustments-out-bar" style={{ width }} />
      <div className="adjustments-tri-track" ref={outRef} style={{ width }}>
        <Tri x={v.outBlack} fill="#0d0d0d" title="Output black" onPointerDown={startDrag('outBlack')} />
        <Tri x={v.outWhite} fill="#ffffff" title="Output white" onPointerDown={startDrag('outWhite')} />
      </div>
      <div className="adjustments-levels-fields two" style={{ width }}>
        {field('outBlack', v.outBlack, 0, 255)}
        {field('outWhite', v.outWhite, 0, 255)}
      </div>
    </div>
  );
}
