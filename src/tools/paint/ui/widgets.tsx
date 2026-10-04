/** Small UI building blocks for the paint options bars and the Brushes panel. */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { IconButton, NumberField, Popover, Select, Slider } from '../../../ui/controls';
import { BRUSH_BLEND_OPTIONS, type BrushBlend } from '../options';
import '../paint.css';

export function OptSep() {
  return <span className="paint-opt-sep" />;
}

export function OptLabel({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="paint-opt-label" title={title}>
      {children}
    </span>
  );
}

/** Label + scrubbable number + a slider popover (like Photoshop's Opacity: [100% ▾]). */
export function ScrubNumber({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  displayScale = 1,
  width = 46,
  title,
  sliderMax,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  displayScale?: number;
  width?: number;
  title?: string;
  /** Upper bound of the popover slider (defaults to max). */
  sliderMax?: number;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const sMax = sliderMax ?? max;
  return (
    <div className="paint-scrub" title={title}>
      <NumberField
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        unit={unit}
        displayScale={displayScale}
        width={width}
        scrubLabel={<span className="paint-opt-label">{label}</span>}
      />
      <button className="paint-scrub-btn" title={`${label} slider`} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <ChevronDown size={10} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-end">
          <div className="paint-scrub-pop">
            <Slider value={Math.min(value, sMax)} onChange={onChange} min={min} max={sMax} step={step} displayScale={displayScale} unit={unit} />
          </div>
        </Popover>
      )}
    </div>
  );
}

export function ToggleIcon({
  icon,
  active,
  onClick,
  title,
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  return <IconButton icon={icon} size="sm" iconSize={14} active={active} title={title} onClick={onClick} className="paint-toggle" />;
}

export function BlendSelect({ value, onChange, width = 112, exclude }: { value: BrushBlend; onChange: (v: BrushBlend) => void; width?: number; exclude?: BrushBlend[] }) {
  const options = exclude ? BRUSH_BLEND_OPTIONS.filter((o) => !exclude.includes(o.value)) : BRUSH_BLEND_OPTIONS;
  return (
    <div className="paint-opt-group">
      <OptLabel>Mode</OptLabel>
      <Select value={value} options={options} onChange={onChange} width={width} title="Blend mode" />
    </div>
  );
}

/** Draws a (cached) source canvas into a DOM canvas at CSS size w×h. */
export function CanvasView({ source, width, height, className }: { source: HTMLCanvasElement | null; width: number; height: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const W = Math.round(width * ratio),
      H = Math.round(height * ratio);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (source) ctx.drawImage(source, 0, 0, W, H);
  }, [source, width, height]);
  return <canvas ref={ref} className={className} style={{ width, height }} />;
}
