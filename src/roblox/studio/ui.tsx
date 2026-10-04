/** Small shared form pieces for the Roblox dialogs (segmented control, chips, labelled sliders). */
import type { ReactNode } from 'react';
import { ColorField, Field, Slider } from '../../ui/controls';

export function Seg<T extends string>({
  value,
  options,
  onChange,
  title,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  title?: string;
}) {
  return (
    <div className="roblox-seg" role="radiogroup" title={title}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'active' : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  active,
  onClick,
  children,
  title,
  swatch,
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  /** Optional color stripe (gradient of these colors) shown on the left. */
  swatch?: string[];
}) {
  return (
    <button type="button" className={`roblox-chip${active ? ' active' : ''}`} onClick={onClick} title={title}>
      {swatch && swatch.length > 0 && (
        <span
          className="roblox-chip-swatch"
          style={{ background: swatch.length > 1 ? `linear-gradient(135deg, ${swatch.join(', ')})` : swatch[0] }}
        />
      )}
      <span className="roblox-chip-label">{children}</span>
    </button>
  );
}

export function ChipGrid({ children, cols = 2 }: { children: ReactNode; cols?: number }) {
  return (
    <div className="roblox-chip-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {children}
    </div>
  );
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  displayScale,
  onChange,
  onCommit,
  hint,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  displayScale?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Slider value={value} min={min} max={max} step={step} unit={unit} displayScale={displayScale} onChange={onChange} onCommit={onCommit} />
    </Field>
  );
}

export function ColorRow({ label, value, onChange, hint }: { label: ReactNode; value: string; onChange: (c: string) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <ColorField value={value} onChange={onChange} showHex />
    </Field>
  );
}

export function SwatchRow({ colors, value, onPick, size = 16 }: { colors: string[]; value?: string; onPick: (c: string) => void; size?: number }) {
  return (
    <div className="roblox-swatches">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className={`roblox-swatch${value && value.toLowerCase() === c.toLowerCase() ? ' active' : ''}`}
          style={{ width: size, height: size, background: c }}
          title={c}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

export function Group({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="roblox-group">
      <div className="roblox-group-head">
        <span>{title}</span>
        {actions && <span className="roblox-group-actions">{actions}</span>}
      </div>
      <div className="roblox-group-body">{children}</div>
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <div className="roblox-hint">{children}</div>;
}
