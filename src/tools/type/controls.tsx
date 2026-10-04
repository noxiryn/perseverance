/** Small shared controls of the type UI (options bar, Character panel, Properties section). */
import { useState, type ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, CaseUpper, ChevronDown, Italic } from 'lucide-react';
import type { Gradient, TextProps } from '../../core/types';
import { fonts, useRegistry } from '../../registry';
import { ColorPicker, FontSelect, GradientEditor, IconButton, NumberField, Popover, Select, gradientToCss, showMenuAt } from '../../ui/controls';
import { useEditor } from '../../state/editor';
import { setAlign, setFillColor, setFillGradient, setFillType, setFontFamily, setFontSize, setWeightStyle, toggleText, useTextView } from './actions';
import { SIZE_PRESETS, defaultTextGradient, parseWeightValue, weightChoices, weightLabel, weightValue } from './options';
import './type.css';

/* ---------------- font ---------------- */

export function FontFamilyField({ width = '100%' }: { width?: number | string }) {
  const { text } = useTextView();
  return <FontSelect value={text.fontFamily} onChange={(f) => void setFontFamily(f)} width={width} />;
}

export function WeightStyleSelect({ width = '100%' }: { width?: number | string }) {
  const { text } = useTextView();
  const list = useRegistry(fonts);
  const def = list.find((f) => f.family.toLowerCase() === text.fontFamily.toLowerCase());
  const options = weightChoices(def?.weights, def?.italic);
  const value = weightValue(text.fontWeight, text.fontStyle);
  if (!options.some((o) => o.value === value)) options.unshift({ value, label: weightLabel(text.fontWeight, text.fontStyle === 'italic') });
  return (
    <Select
      value={value}
      options={options}
      width={width}
      title="Font style"
      onChange={(v) => {
        const p = parseWeightValue(v);
        void setWeightStyle(p.fontWeight, p.fontStyle);
      }}
    />
  );
}

/* ---------------- size ---------------- */

export function FontSizeField({ width = 64, label }: { width?: number | string; label?: ReactNode }) {
  const { text } = useTextView();
  return (
    <div className="type-size">
      <NumberField
        value={text.fontSize}
        min={1}
        max={2000}
        step={1}
        unit="px"
        width={width}
        title="Font size"
        scrubLabel={label}
        onChange={(v) => setFontSize(v, 'live')}
        onCommit={(v) => setFontSize(v, 'commit')}
      />
      <button
        className="type-size-presets"
        title="Size presets"
        onClick={(e) =>
          showMenuAt(
            e.currentTarget,
            SIZE_PRESETS.map((s) => ({ label: `${s} px`, checked: Math.round(text.fontSize) === s, run: () => setFontSize(s, 'commit') })),
            90,
          )
        }
      >
        <ChevronDown size={11} />
      </button>
    </div>
  );
}

/* ---------------- alignment & toggles ---------------- */

export function AlignButtons({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const { text } = useTextView();
  const items: { v: TextProps['align']; icon: typeof AlignLeft; title: string }[] = [
    { v: 'left', icon: AlignLeft, title: 'Align left' },
    { v: 'center', icon: AlignCenter, title: 'Align center' },
    { v: 'right', icon: AlignRight, title: 'Align right' },
  ];
  return (
    <div className="type-btn-group" role="group" aria-label="Alignment">
      {items.map((i) => (
        <IconButton key={i.v} icon={i.icon} title={i.title} size={size} active={text.align === i.v} onClick={() => setAlign(i.v)} />
      ))}
    </div>
  );
}

export function StyleToggles({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const { text } = useTextView();
  return (
    <div className="type-btn-group" role="group" aria-label="Text style">
      <IconButton icon={Bold} title="Faux Bold" size={size} active={text.fauxBold} onClick={() => toggleText('fauxBold')} />
      <IconButton icon={Italic} title="Faux Italic" size={size} active={text.fauxItalic} onClick={() => toggleText('fauxItalic')} />
      <IconButton icon={CaseUpper} title="All Caps" size={size} active={text.uppercase} onClick={() => toggleText('uppercase')} />
    </div>
  );
}

/* ---------------- fill ---------------- */

export function fillCss(text: TextProps): string {
  const f = text.fill;
  if (f.type === 'solid') return f.color;
  if (f.type === 'gradient') return gradientToCss(f.gradient, 135);
  return '#888888';
}

function FillModes({ value, onChange }: { value: 'solid' | 'gradient'; onChange: (v: 'solid' | 'gradient') => void }) {
  return (
    <div className="type-seg" role="tablist">
      {(['solid', 'gradient'] as const).map((m) => (
        <button key={m} role="tab" aria-selected={value === m} className={`type-seg-btn${value === m ? ' active' : ''}`} onClick={() => onChange(m)}>
          {m === 'solid' ? 'Color' : 'Gradient'}
        </button>
      ))}
    </div>
  );
}

/** Editor body: Color | Gradient tabs with the matching picker. */
export function TextFillEditor() {
  const { text } = useTextView();
  const primary = useEditor((s) => s.primaryColor);
  const secondary = useEditor((s) => s.secondaryColor);
  const mode = text.fill.type === 'gradient' ? 'gradient' : 'solid';
  const color = text.fill.type === 'solid' ? text.fill.color : primary;
  const gradient: Gradient = text.fill.type === 'gradient' ? text.fill.gradient : defaultTextGradient(color, secondary);
  return (
    <div className="type-fill-editor">
      <FillModes value={mode} onChange={setFillType} />
      {mode === 'solid' ? (
        <ColorPicker value={color} onChange={(c) => setFillColor(c, 'live')} onCommit={(c) => setFillColor(c, 'commit')} alpha />
      ) : (
        <GradientEditor value={gradient} onChange={(g) => setFillGradient(g, 'live')} onCommit={(g) => setFillGradient(g, 'commit')} />
      )}
    </div>
  );
}

/** Chip showing the text fill; opens the fill editor. */
export function TextFillChip({ size = 22, title = 'Text color', placement = 'bottom-start' }: { size?: number; title?: string; placement?: 'bottom-start' | 'left-start' }) {
  const { text } = useTextView();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        className={`type-chip${anchor ? ' active' : ''}`}
        style={{ width: size, height: size }}
        title={`${title}: ${text.fill.type === 'solid' ? text.fill.color : 'Gradient'}`}
        aria-label={title}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <span className="type-chip-paint" style={{ background: fillCss(text) }} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement={placement} className="type-pop">
          <TextFillEditor />
        </Popover>
      )}
    </>
  );
}

/* ---------------- labelled numeric cell ---------------- */

export function NumCell({
  icon,
  title,
  value,
  onLive,
  onCommit,
  min,
  max,
  step = 1,
  unit,
  displayScale,
}: {
  icon: ReactNode;
  title: string;
  value: number;
  onLive: (v: number) => void;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  displayScale?: number;
}) {
  return (
    <div className="type-cell" title={title}>
      <NumberField
        value={value}
        min={min}
        max={max}
        step={step}
        unit={unit}
        width="100%"
        displayScale={displayScale}
        scrubLabel={<span className="type-cell-icon">{icon}</span>}
        onChange={onLive}
        onCommit={onCommit}
      />
    </div>
  );
}
