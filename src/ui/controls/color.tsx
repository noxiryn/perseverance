import { useEffect, useRef, useState } from 'react';
import { Pipette } from 'lucide-react';
import { hsvToRgb, parseColor, rgbToHsv, toHex } from '../../core/color';
import { Popover } from './popover';
import { useEditor } from '../../state/editor';
import { palettes, useRegistry } from '../../registry';

/** Color chip with checkerboard behind (shows alpha). */
export function ColorSwatch({
  color,
  onClick,
  size = 22,
  title,
  selected,
}: {
  color: string;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  size?: number;
  title?: string;
  selected?: boolean;
}) {
  return (
    <div
      className="ui-swatch"
      title={title ?? color}
      onClick={onClick}
      style={{ width: size, height: size, outline: selected ? '2px solid var(--accent)' : undefined, outlineOffset: 1 }}
    >
      <span style={{ background: color }} />
    </div>
  );
}

interface HSVA {
  h: number;
  s: number;
  v: number;
  a: number;
}

function toHSVA(c: string): HSVA {
  const p = parseColor(c);
  const [h, s, v] = rgbToHsv(p.r, p.g, p.b);
  return { h, s, v, a: p.a };
}

function fromHSVA(c: HSVA, alpha: boolean): string {
  const [r, g, b] = hsvToRgb(c.h, c.s, c.v);
  return toHex({ r, g, b, a: alpha ? c.a : 1 }, alpha && c.a < 1);
}

function useDrag(onMove: (x: number, y: number, rect: DOMRect) => void, onEnd?: () => void) {
  return (e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const handle = (ev: PointerEvent | React.PointerEvent) => {
      onMove(
        Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
        Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)),
        rect,
      );
    };
    handle(e);
    const move = (ev: PointerEvent) => handle(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
}

/**
 * HSV color picker: saturation/value square, hue strip, optional alpha strip, hex input,
 * screen eyedropper (EyeDropper API), recent colors and the active palette.
 */
export function ColorPicker({
  value,
  onChange,
  onCommit,
  alpha = false,
}: {
  value: string;
  onChange: (c: string) => void;
  onCommit?: (c: string) => void;
  alpha?: boolean;
}) {
  const [hsva, setHsva] = useState<HSVA>(() => toHSVA(value));
  const last = useRef(value);
  const recent = useEditor((s) => s.recentColors);
  const pushRecent = useEditor((s) => s.pushRecentColor);
  const pals = useRegistry(palettes);

  useEffect(() => {
    if (value.toLowerCase() !== last.current.toLowerCase()) {
      last.current = value;
      setHsva((prev) => {
        const n = toHSVA(value);
        // Preserve hue when the color is gray/black (hue undefined).
        if (n.s === 0 || n.v === 0) n.h = prev.h;
        return n;
      });
    }
  }, [value]);

  const update = (n: HSVA) => {
    setHsva(n);
    const c = fromHSVA(n, alpha);
    last.current = c;
    onChange(c);
  };
  const commit = () => {
    const c = fromHSVA(hsva, alpha);
    pushRecent(c);
    onCommit?.(c);
  };

  const hueColor = toHex({ r: hsvToRgb(hsva.h, 1, 1)[0], g: hsvToRgb(hsva.h, 1, 1)[1], b: hsvToRgb(hsva.h, 1, 1)[2] });
  const current = fromHSVA(hsva, alpha);
  const [hex, setHex] = useState(current);
  useEffect(() => setHex(current), [current]);

  const svDrag = useDrag((x, y) => update({ ...hsva, s: x, v: 1 - y }), commit);
  const hueDrag = useDrag((x) => update({ ...hsva, h: x * 360 }), commit);
  const alphaDrag = useDrag((x) => update({ ...hsva, a: x }), commit);

  const pickScreen = async () => {
    const ED = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!ED) return;
    try {
      const r = await new ED().open();
      const n = toHSVA(r.sRGBHex);
      update({ ...n, a: hsva.a });
      pushRecent(r.sRGBHex);
      onCommit?.(r.sRGBHex);
    } catch {
      /* cancelled */
    }
  };

  const activePalette = pals[0];

  return (
    <div style={{ width: 232, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        onPointerDown={svDrag}
        style={{
          position: 'relative',
          height: 150,
          borderRadius: 4,
          cursor: 'crosshair',
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: `${hsva.s * 100}%`,
            top: `${(1 - hsva.v) * 100}%`,
            width: 12,
            height: 12,
            marginLeft: -6,
            marginTop: -6,
            borderRadius: '50%',
            border: '2px solid #fff',
            boxShadow: '0 0 0 1px rgba(0,0,0,.6)',
            pointerEvents: 'none',
          }}
        />
      </div>
      <div
        onPointerDown={hueDrag}
        style={{
          position: 'relative',
          height: 12,
          borderRadius: 6,
          cursor: 'ew-resize',
          background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)',
        }}
      >
        <Thumb x={hsva.h / 360} />
      </div>
      {alpha && (
        <div
          onPointerDown={alphaDrag}
          className="ui-swatch"
          style={{ position: 'relative', width: '100%', height: 12, borderRadius: 6, cursor: 'ew-resize', overflow: 'visible' }}
        >
          <span style={{ borderRadius: 6, background: `linear-gradient(to right, transparent, ${fromHSVA({ ...hsva, a: 1 }, false)})` }} />
          <Thumb x={hsva.a} />
        </div>
      )}
      <div className="ui-row">
        <ColorSwatch color={current} size={26} />
        <input
          className="ui-input"
          style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          onBlur={() => {
            const v = hex.startsWith('#') ? hex : `#${hex}`;
            if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) {
              update(toHSVA(v));
              pushRecent(v);
              onCommit?.(v);
            } else setHex(current);
          }}
        />
        {'EyeDropper' in window && (
          <button className="ui-icon-btn" title="Pick color from screen" onClick={pickScreen}>
            <Pipette size={14} />
          </button>
        )}
      </div>
      {recent.length > 0 && (
        <div>
          <div className="ui-label" style={{ marginBottom: 4 }}>
            Recent
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {recent.slice(0, 16).map((c) => (
              <ColorSwatch
                key={c}
                color={c}
                size={16}
                onClick={() => {
                  update(toHSVA(c));
                  onCommit?.(c);
                }}
              />
            ))}
          </div>
        </div>
      )}
      {activePalette && (
        <div>
          <div className="ui-label" style={{ marginBottom: 4 }}>
            {activePalette.name}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {activePalette.colors.slice(0, 24).map((c, i) => (
              <ColorSwatch
                key={i}
                color={c}
                size={16}
                onClick={() => {
                  update(toHSVA(c));
                  pushRecent(c);
                  onCommit?.(c);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Thumb({ x }: { x: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x * 100}%`,
        top: '50%',
        width: 12,
        height: 12,
        marginLeft: -6,
        marginTop: -6,
        borderRadius: '50%',
        border: '2px solid #fff',
        boxShadow: '0 0 0 1px rgba(0,0,0,.6)',
        pointerEvents: 'none',
      }}
    />
  );
}

/** Swatch that opens a ColorPicker popover. `onChange` fires live; `onCommit` once per edit. */
export function ColorField({
  value,
  onChange,
  onCommit,
  alpha,
  size = 22,
  showHex = false,
  title,
}: {
  value: string;
  onChange: (c: string) => void;
  onCommit?: (c: string) => void;
  alpha?: boolean;
  size?: number;
  showHex?: boolean;
  title?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div className="ui-row" style={{ gap: 6, minHeight: 0 }}>
      <ColorSwatch color={value} size={size} title={title} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} />
      {showHex && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{value}</span>}
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="left-start">
          <ColorPicker value={value} onChange={onChange} onCommit={onCommit} alpha={alpha} />
        </Popover>
      )}
    </div>
  );
}
