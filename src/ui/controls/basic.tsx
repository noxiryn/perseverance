import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentType, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';

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

/**
 * Native <select> focus handling. After a value is picked with the mouse, focus is handed back to
 * the page (like Photopea) so tool letters, Delete and Ctrl+Z keep working and the select's
 * type-to-search can't silently change the value again. Keyboard users keep focus on the select.
 * Inside a dialog focus is left alone (the dialog owns the keyboard).
 * Spread `selectFocusHandlers` on the element and call `releaseSelectFocus` from onChange; raw
 * <select>s outside the shared control use the same pair.
 */
export const selectFocusHandlers = {
  onPointerDown: (e: React.PointerEvent<HTMLSelectElement>) => {
    e.currentTarget.dataset.pointerPick = '1';
  },
  onKeyDown: (e: React.KeyboardEvent<HTMLSelectElement>) => {
    delete e.currentTarget.dataset.pointerPick;
  },
};

export function releaseSelectFocus(el: HTMLSelectElement) {
  const viaPointer = el.dataset.pointerPick === '1';
  delete el.dataset.pointerPick;
  if (viaPointer && document.activeElement === el && !el.closest('.ui-dialog')) el.blur();
}

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
      {...selectFocusHandlers}
      onChange={(e) => {
        onChange(e.target.value as T);
        releaseSelectFocus(e.currentTarget);
      }}
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
  autoFocus,
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
  /**
   * Take the focus when its dialog opens (number fields are otherwise skipped by the dialog's
   * initial focus, so arrow keys / digits can't change a value the user didn't pick).
   */
  autoFocus?: boolean;
}) {
  const shown = value * displayScale;
  const [text, setText] = useState(fmt(shown, step));
  const focused = useRef(false);
  /** Set by Escape: the blur that follows must revert, not commit the typed text. */
  const cancelRef = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(shown, step));
  }, [shown, step]);

  const clampV = (v: number) => Math.max(min, Math.min(max, v));
  const commitText = () => {
    // Untouched text: nothing to commit (no spurious history step, no rounding to the display).
    if (text === fmt(shown, step)) return;
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
          data-autofocus={autoFocus ? '' : undefined}
          onFocus={(e) => {
            focused.current = true;
            e.target.select();
          }}
          onBlur={() => {
            focused.current = false;
            if (cancelRef.current) {
              cancelRef.current = false;
              setText(fmt(shown, step));
              return;
            }
            commitText();
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              // Revert: the blur below must not commit the (still unflushed) typed text.
              cancelRef.current = true;
              setText(fmt(shown, step));
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1) * (step / displayScale);
              const nv = clampV(value + d);
              // Keep the visible text in sync, otherwise the stale text is re-committed on blur.
              setText(fmt(nv * displayScale, step));
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

/* ---------------- ChipRow ---------------- */

/**
 * Filter chips in one horizontally scrolling row (for narrow dock panels): the vertical mouse wheel
 * scrolls it sideways, edge arrows page through it, the sides with more chips fade out, and the
 * active chip is kept in view.
 */
export function ChipRow<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, items.length]);
  useEffect(() => {
    const el = row.current;
    const chip = el?.querySelector<HTMLElement>('.ui-chip.active');
    if (!el || !chip) return;
    const pad = 26;
    if (chip.offsetLeft - pad < el.scrollLeft) el.scrollLeft = Math.max(0, chip.offsetLeft - pad);
    else if (chip.offsetLeft + chip.offsetWidth + pad > el.scrollLeft + el.clientWidth) el.scrollLeft = chip.offsetLeft + chip.offsetWidth + pad - el.clientWidth;
    measure();
  }, [value, measure]);
  const page = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * Math.max(80, row.current.clientWidth * 0.7), behavior: 'smooth' });
  const onWheel = (e: ReactWheelEvent) => {
    const el = row.current;
    if (!el || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // trackpads scroll sideways natively
    el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  };
  return (
    <div className={`ui-chips-wrap${edges.left ? ' fade-l' : ''}${edges.right ? ' fade-r' : ''}`} onWheel={onWheel}>
      <div ref={row} className="ui-chips" role="tablist" aria-label={ariaLabel} onScroll={measure}>
        {items.map((c) => (
          <button
            key={c.value}
            role="tab"
            aria-selected={value === c.value}
            className={`ui-chip${value === c.value ? ' active' : ''}`}
            title={c.title}
            onClick={() => onChange(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {edges.left && (
        <button className="ui-chips-arrow left" title="Scroll left" tabIndex={-1} onClick={() => page(-1)}>
          <ChevronLeft size={12} strokeWidth={1.8} />
        </button>
      )}
      {edges.right && (
        <button className="ui-chips-arrow right" title="More" tabIndex={-1} onClick={() => page(1)}>
          <ChevronRight size={12} strokeWidth={1.8} />
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
