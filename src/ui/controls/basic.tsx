import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;

/* ---------------- Button ---------------- */

export function Button({
  variant,
  size,
  icon: Icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'small';
  icon?: IconType;
}) {
  return (
    <button className={['ui-btn', variant, size, className].filter(Boolean).join(' ')} {...rest}>
      {Icon && <Icon size={14} strokeWidth={1.75} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  title,
  active,
  size = 'md',
  iconSize,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconType;
  title?: string;
  active?: boolean;
  size?: 'sm' | 'md';
  iconSize?: number;
}) {
  return (
    <button
      className={['ui-icon-btn', size === 'sm' && 'sm', active && 'active', className].filter(Boolean).join(' ')}
      title={title}
      aria-label={title}
      {...rest}
    >
      <Icon size={iconSize ?? (size === 'sm' ? 13 : 15)} strokeWidth={1.6} />
    </button>
  );
}

/* ---------------- Checkbox ---------------- */

export function Checkbox({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <label className="ui-check" title={title} style={disabled ? { opacity: 0.5 } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/* ---------------- Select ---------------- */

export function Select<T extends string>({
  value,
  options,
  onChange,
  width,
  title,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[] | readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  width?: number | string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <select
      className="ui-select"
      value={value}
      title={title}
      disabled={disabled}
      style={{ width }}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/* ---------------- NumberField (scrubbable) ---------------- */

function fmt(v: number, step: number) {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return Number.isFinite(v) ? v.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : '';
}

export function NumberField({
  value,
  onChange,
  onCommit,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit,
  width,
  title,
  displayScale = 1,
  scrubLabel,
  disabled,
}: {
  value: number;
  /** Called continuously (typing commit / scrubbing). */
  onChange: (v: number) => void;
  /** Called once when an interaction ends (blur / scrub release). */
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  width?: number | string;
  title?: string;
  /** Show value × displayScale (e.g. 100 for 0..1 percentages). */
  displayScale?: number;
  /** Optional label element that scrubs the value when dragged horizontally. */
  scrubLabel?: ReactNode;
  /** Read-only, dimmed, no scrubbing. */
  disabled?: boolean;
}) {
  const shown = value * displayScale;
  const [text, setText] = useState(fmt(shown, step));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(shown, step));
  }, [shown, step]);

  const clampV = (v: number) => Math.max(min, Math.min(max, v));
  const commitText = () => {
    // Allow simple math like "100*2" or "50+10".
    let v = Number(text);
    if (!Number.isFinite(v) && /^[\d\s+\-*/.()]+$/.test(text)) {
      try {
        v = Function(`"use strict";return (${text})`)() as number;
      } catch {
        v = NaN;
      }
    }
    if (Number.isFinite(v)) {
      const nv = clampV(v / displayScale);
      onChange(nv);
      onCommit?.(nv);
      setText(fmt(nv * displayScale, step));
    } else setText(fmt(shown, step));
  };

  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0 || disabled) return;
    e.preventDefault();
    const startX = e.clientX;
    const start = value;
    let last = value;
    const range = Number.isFinite(max - min) ? max - min : 200 * step;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const speed = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const perPx = Math.max(step / displayScale, range / 300) * speed;
      let nv = clampV(start + dx * perPx);
      const st = step / displayScale;
      nv = Math.round(nv / st) * st;
      last = nv;
      onChange(nv);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommit?.(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="ui-row" style={{ gap: 4, minHeight: 0 }}>
      {scrubLabel && (
        <span className="ui-label ui-scrub" onPointerDown={startScrub}>
          {scrubLabel}
        </span>
      )}
      <div className="ui-num" style={{ width, opacity: disabled ? 0.45 : undefined }} title={title}>
        <input
          value={text}
          disabled={disabled}
          onFocus={(e) => {
            focused.current = true;
            e.target.select();
          }}
          onBlur={() => {
            focused.current = false;
            commitText();
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setText(fmt(shown, step));
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1) * (step / displayScale);
              const nv = clampV(value + d);
              onChange(nv);
              onCommit?.(nv);
            }
          }}
        />
        {unit && <span className="unit">{unit}</span>}
      </div>
    </div>
  );
}

/* ---------------- Slider ---------------- */

export function Slider({
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  unit,
  displayScale = 1,
  showNumber = true,
  width,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  displayScale?: number;
  showNumber?: boolean;
  width?: number | string;
}) {
  const pct = ((value - min) / (max - min || 1)) * 100;
  return (
    <div className="ui-slider" style={{ width }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step / displayScale}
        value={value}
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      />
      {showNumber && (
        <NumberField
          value={value}
          onChange={onChange}
          onCommit={onCommit}
          min={min}
          max={max}
          step={step}
          unit={unit}
          displayScale={displayScale}
        />
      )}
    </div>
  );
}

/* ---------------- Field (label + control row) ---------------- */

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <div className="ui-field" title={hint}>
      <span className="ui-label">{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

/* ---------------- Tabs ---------------- */

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T;
  tabs: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="ui-tabs">
      {tabs.map((t) => (
        <button key={t.value} className={`ui-tab${t.value === value ? ' active' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Section (collapsible) ---------------- */

export function Section({
  title,
  children,
  defaultOpen = true,
  actions,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ui-section">
      <div className="ui-section-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span style={{ flex: 1 }}>{title}</span>
        {actions && (
          <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 2 }}>
            {actions}
          </span>
        )}
      </div>
      {open && <div className="ui-section-body">{children}</div>}
    </div>
  );
}

/* ---------------- Search ---------------- */

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="ui-search">
      <Search size={12} />
      <input
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      {value && (
        <button className="ui-icon-btn sm" onClick={() => onChange('')} title="Clear">
          <X size={11} />
        </button>
      )}
    </div>
  );
}

/* ---------------- TextInput ---------------- */

export function TextInput({
  value,
  onChange,
  onCommit,
  placeholder,
  multiline,
  width,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  width?: number | string;
  rows?: number;
}) {
  const common = {
    className: 'ui-input',
    value,
    placeholder,
    style: { width: width ?? '100%' },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => onCommit?.(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (!multiline && e.key === 'Enter') (e.target as HTMLInputElement).blur();
    },
  };
  return multiline ? <textarea rows={rows} {...common} /> : <input {...common} />;
}
