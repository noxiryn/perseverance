/** Fill / stroke swatch buttons with popover editors, shared by the options bar and Properties. */
import { useState } from 'react';
import type { Gradient } from '../../core/types';
import { ColorPicker, GradientEditor, Popover, Select, gradientToCss } from '../../ui/controls';
import type { DashPreset, EditPhase, FillMode, StrokeAlign } from './options';
import './shape.css';

export interface FillView {
  mode: FillMode;
  color: string;
  gradient: Gradient;
}

export function fillCss(f: FillView): string {
  if (f.mode === 'none') return '';
  if (f.mode === 'gradient') return gradientToCss(f.gradient, 135);
  return f.color;
}

/** Chip showing a paint (none = white with a red slash). */
export function PaintChip({ css, title, onClick, active, ring }: { css: string; title: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; active?: boolean; ring?: boolean }) {
  return (
    <button className={`shape-chip${active ? ' active' : ''}${ring ? ' ring' : ''}`} title={title} aria-label={title} onClick={onClick}>
      {css ? <span className="shape-chip-paint" style={{ background: css }} /> : <span className="shape-chip-none" />}
      {ring && <span className="shape-chip-hole" />}
    </button>
  );
}

function ModeTabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="shape-modes" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={`shape-mode${o.value === value ? ' active' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FillButton({
  value,
  onMode,
  onColor,
  onGradient,
  title = 'Fill',
}: {
  value: FillView;
  onMode: (m: FillMode) => void;
  onColor: (c: string, phase: EditPhase) => void;
  onGradient: (g: Gradient, phase: EditPhase) => void;
  title?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <PaintChip css={fillCss(value)} title={`${title}: ${value.mode === 'none' ? 'None' : value.mode === 'gradient' ? 'Gradient' : value.color}`} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} active={!!anchor} />
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-start" className="shape-pop">
          <div className="shape-pop-body">
            <ModeTabs
              value={value.mode}
              options={[
                { value: 'none', label: 'None' },
                { value: 'solid', label: 'Color' },
                { value: 'gradient', label: 'Gradient' },
              ]}
              onChange={onMode}
            />
            {value.mode === 'solid' && <ColorPicker value={value.color} onChange={(c) => onColor(c, 'live')} onCommit={(c) => onColor(c, 'commit')} alpha />}
            {value.mode === 'gradient' && <GradientEditor value={value.gradient} onChange={(g) => onGradient(g, 'live')} onCommit={(g) => onGradient(g, 'commit')} />}
            {value.mode === 'none' && <div className="shape-pop-hint">No fill — only the stroke is drawn.</div>}
          </div>
        </Popover>
      )}
    </>
  );
}

export interface StrokeView {
  on: boolean;
  color: string;
  width: number;
  align: StrokeAlign;
  dash: DashPreset;
}

export function StrokeButton({ value, onOn, onColor, title = 'Stroke' }: { value: StrokeView; onOn: (on: boolean) => void; onColor: (c: string, phase: EditPhase) => void; title?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <PaintChip css={value.on ? value.color : ''} ring title={`${title}: ${value.on ? value.color : 'None'}`} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} active={!!anchor} />
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-start" className="shape-pop">
          <div className="shape-pop-body">
            <ModeTabs
              value={value.on ? 'on' : 'off'}
              options={[
                { value: 'off', label: 'None' },
                { value: 'on', label: 'Color' },
              ]}
              onChange={(v) => onOn(v === 'on')}
            />
            {value.on ? (
              <ColorPicker value={value.color} onChange={(c) => onColor(c, 'live')} onCommit={(c) => onColor(c, 'commit')} alpha />
            ) : (
              <div className="shape-pop-hint">No stroke.</div>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

export const ALIGN_OPTIONS: { value: StrokeAlign; label: string }[] = [
  { value: 'inside', label: 'Inside' },
  { value: 'center', label: 'Center' },
  { value: 'outside', label: 'Outside' },
];

export const DASH_OPTIONS: { value: DashPreset; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

/** Small inline SVG preview of a dash preset. */
export function DashGlyph({ dash }: { dash: DashPreset }) {
  return (
    <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden>
      <line
        x1="2"
        y1="4"
        x2="24"
        y2="4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap={dash === 'dotted' ? 'round' : 'butt'}
        strokeDasharray={dash === 'dashed' ? '6 3' : dash === 'dotted' ? '0 4' : undefined}
      />
    </svg>
  );
}

export function DashSelect({ value, onChange, width = 84 }: { value: DashPreset; onChange: (d: DashPreset) => void; width?: number }) {
  return <Select value={value} options={DASH_OPTIONS} onChange={onChange} width={width} title="Stroke style" />;
}
