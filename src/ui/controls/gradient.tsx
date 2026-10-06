import { useState } from 'react';
import { ArrowLeftRight, Trash2 } from 'lucide-react';
import type { Gradient, GradientKind, GradientStop } from '../../core/types';
import { mixColors } from '../../core/color';
import { gradientPresets, useRegistry } from '../../registry';
import { ColorField, clickOnEnterOrSpace } from './color';
import { Popover } from './popover';
import { IconButton, NumberField, Select } from './basic';

export function gradientToCss(g: Gradient, angle = 90): string {
  const stops = [...g.stops].sort((a, b) => a.offset - b.offset);
  const list = (g.reverse ? stops.map((s) => ({ ...s, offset: 1 - s.offset })).reverse() : stops)
    .map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`)
    .join(', ');
  return `linear-gradient(${angle}deg, ${list}), repeating-conic-gradient(#888 0% 25%, #bbb 0% 50%) 50% / 8px 8px`;
}

/** Gradient strip; with `onClick` a keyboard-focusable button (see ColorSwatch). */
export function GradientPreview({
  gradient,
  height = 18,
  onClick,
  title,
}: {
  gradient: Gradient;
  height?: number;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  title?: string;
}) {
  return (
    <div
      title={title}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? (title ?? 'Gradient') : undefined}
      onKeyDown={onClick ? clickOnEnterOrSpace : undefined}
      style={{
        height,
        borderRadius: 3,
        border: '1px solid #444',
        background: gradientToCss(gradient),
        cursor: onClick ? 'pointer' : undefined,
      }}
    />
  );
}

const KINDS: { value: GradientKind; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'angle', label: 'Angle' },
  { value: 'reflected', label: 'Reflected' },
  { value: 'diamond', label: 'Diamond' },
];

/** Full gradient editor: stops bar, stop color/position, kind, angle, scale, reverse, presets. */
export function GradientEditor({
  value,
  onChange,
  onCommit,
  showGeometry = true,
}: {
  value: Gradient;
  onChange: (g: Gradient) => void;
  onCommit?: (g: Gradient) => void;
  showGeometry?: boolean;
}) {
  const [sel, setSel] = useState(0);
  const presets = useRegistry(gradientPresets);
  const stops = value.stops;
  const set = (g: Gradient, commit = false) => {
    onChange(g);
    if (commit) onCommit?.(g);
  };
  const setStops = (s: GradientStop[], commit = false) => set({ ...value, stops: s }, commit);

  const addStopAt = (offset: number) => {
    const sorted = [...stops].sort((a, b) => a.offset - b.offset);
    let color = sorted[0]?.color ?? '#000000';
    for (let i = 0; i < sorted.length - 1; i++) {
      if (offset >= sorted[i].offset && offset <= sorted[i + 1].offset) {
        const t = (offset - sorted[i].offset) / (sorted[i + 1].offset - sorted[i].offset || 1);
        color = mixColors(sorted[i].color, sorted[i + 1].color, t);
      }
    }
    const next = [...stops, { offset, color }];
    setStops(next, true);
    setSel(next.length - 1);
  };

  const dragStop = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setSel(i);
    const bar = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    let latest = stops;
    const move = (ev: PointerEvent) => {
      const off = Math.max(0, Math.min(1, (ev.clientX - bar.left) / bar.width));
      // Drag far below the bar to delete (if >2 stops).
      if (ev.clientY - bar.bottom > 40 && stops.length > 2) {
        latest = stops.filter((_, k) => k !== i);
      } else {
        latest = stops.map((s, k) => (k === i ? { ...s, offset: off } : s));
      }
      setStops(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setStops(latest, true);
      if (latest.length < stops.length) setSel(0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const cur = stops[sel] ?? stops[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 260 }}>
      {presets.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, maxHeight: 112, overflow: 'auto' }}>
          {presets.map((p) => (
            <div
              key={p.id}
              title={p.name}
              onClick={() => set({ ...value, stops: structuredClone(p.gradient.stops) }, true)}
              style={{ height: 22, borderRadius: 3, border: '1px solid #444', cursor: 'pointer', background: gradientToCss(p.gradient) }}
            />
          ))}
        </div>
      )}
      <div style={{ paddingBottom: 14, position: 'relative' }}>
        <div
          className="ui-gradient-bar"
          style={{ background: gradientToCss({ ...value, reverse: false }) }}
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            addStopAt(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
          }}
        >
          {stops.map((s, i) => (
            <div
              key={i}
              className={`ui-gradient-stop${i === sel ? ' selected' : ''}`}
              style={{ left: `${s.offset * 100}%`, background: s.color }}
              onPointerDown={dragStop(i)}
            />
          ))}
        </div>
      </div>
      {cur && (
        <div className="ui-row">
          <ColorField
            value={cur.color}
            alpha
            onChange={(c) => setStops(stops.map((s, k) => (k === sel ? { ...s, color: c } : s)))}
            onCommit={(c) => setStops(stops.map((s, k) => (k === sel ? { ...s, color: c } : s)), true)}
          />
          <span className="ui-label">Location</span>
          <NumberField
            width={64}
            value={cur.offset}
            min={0}
            max={1}
            step={1}
            displayScale={100}
            unit="%"
            onChange={(v) => setStops(stops.map((s, k) => (k === sel ? { ...s, offset: v } : s)))}
            onCommit={(v) => setStops(stops.map((s, k) => (k === sel ? { ...s, offset: v } : s)), true)}
          />
          <IconButton
            icon={Trash2}
            size="sm"
            title="Delete stop"
            disabled={stops.length <= 2}
            onClick={() => {
              setStops(
                stops.filter((_, k) => k !== sel),
                true,
              );
              setSel(0);
            }}
          />
        </div>
      )}
      {showGeometry && (
        <>
          <div className="ui-row">
            <Select value={value.kind} options={KINDS} onChange={(k) => set({ ...value, kind: k }, true)} width={96} />
            <IconButton
              icon={ArrowLeftRight}
              size="sm"
              title="Reverse"
              active={!!value.reverse}
              onClick={() => set({ ...value, reverse: !value.reverse }, true)}
            />
            <span className="ui-label">Angle</span>
            <NumberField
              width={56}
              value={value.angle}
              min={-360}
              max={360}
              unit="°"
              onChange={(v) => set({ ...value, angle: v })}
              onCommit={(v) => set({ ...value, angle: v }, true)}
            />
          </div>
          <div className="ui-row">
            <span className="ui-label">Scale</span>
            <NumberField
              width={64}
              value={value.scale}
              min={0.05}
              max={5}
              step={1}
              displayScale={100}
              unit="%"
              onChange={(v) => set({ ...value, scale: v })}
              onCommit={(v) => set({ ...value, scale: v }, true)}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Gradient preview bar that opens the editor in a popover. */
export function GradientField({
  value,
  onChange,
  onCommit,
  showGeometry,
}: {
  value: Gradient;
  onChange: (g: Gradient) => void;
  onCommit?: (g: Gradient) => void;
  showGeometry?: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <GradientPreview gradient={value} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} title="Edit gradient" />
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="left-start">
          <GradientEditor value={value} onChange={onChange} onCommit={onCommit} showGeometry={showGeometry} />
        </Popover>
      )}
    </>
  );
}
