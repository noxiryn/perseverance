/**
 * Color panel: foreground/background chips (click to choose which one is edited), embedded
 * ColorPicker, HSB / RGB channel sliders with live tracks, HEX tab, harmonies (clickable) and
 * WCAG contrast against white/black.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Copy, RotateCcw, SquarePlus } from 'lucide-react';
import { hsvToRgb, parseColor, rgbToHsl, rgbToHsv, toHex } from '../core/color';
import { useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { ColorPicker, IconButton, NumberField, Section, Select, Tabs, showContextMenu } from '../ui/controls';
import { contrastRatio, describeColor, harmony, HARMONIES, normalizeHex, opaqueHex, wcagLevel, type HarmonyKind } from './colorMath';
import { MY_SWATCHES_ID, useUserPalettes } from './userPalettes';
import './presets.css';

type Target = 'primary' | 'secondary';
type Mode = 'hsb' | 'rgb' | 'hex';

const MODE_KEY = 'perseverance.color.mode';
const HARMONY_KEY = 'perseverance.color.harmony';

function readLS<T extends string>(k: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(k) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/** Shared edit target so the toolbar fg/bg and this panel agree within a session. */
let lastTarget: Target = 'primary';

function hsvHex(h: number, s: number, v: number) {
  const [r, g, b] = hsvToRgb(h, s, v);
  return toHex({ r, g, b });
}

/* ------------------------------ channel slider ------------------------------ */

function ChannelSlider({
  label,
  value,
  max,
  unit,
  track,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  max: number;
  unit?: string;
  track: string;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const at = (x: number) => onChange(Math.round(Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * max));
    at(e.clientX);
    const move = (ev: PointerEvent) => at(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="fc-ch">
      <span className="fc-ch-label">{label}</span>
      <div className="fc-ch-track" style={{ background: track }} onPointerDown={drag}>
        <div className="fc-ch-thumb" style={{ left: `${(value / max) * 100}%` }} />
      </div>
      <NumberField
        value={value}
        min={0}
        max={max}
        step={1}
        unit={unit}
        width={52}
        onChange={(v) => onChange(Math.round(v))}
        onCommit={onCommit}
      />
    </div>
  );
}

/* ------------------------------ fg / bg chips ------------------------------ */

function ColorChips({
  primary,
  secondary,
  target,
  onTarget,
}: {
  primary: string;
  secondary: string;
  target: Target;
  onTarget: (t: Target) => void;
}) {
  const st = useEditor.getState;
  return (
    <div className="fc-chips2">
      <div className="fc-chips2-stack">
        <button
          className={`fc-chip2 back${target === 'secondary' ? ' edit' : ''}`}
          style={{ background: secondary }}
          title={`Background ${secondary} — click to edit`}
          onClick={() => onTarget('secondary')}
        />
        <button
          className={`fc-chip2 front${target === 'primary' ? ' edit' : ''}`}
          style={{ background: primary }}
          title={`Foreground ${primary} — click to edit`}
          onClick={() => onTarget('primary')}
        />
      </div>
      <div className="fc-chips2-tools">
        <IconButton icon={ArrowLeftRight} size="sm" iconSize={12} title="Swap colors (X)" onClick={() => st().swapColors()} />
        <IconButton icon={RotateCcw} size="sm" iconSize={12} title="Default colors (D)" onClick={() => st().resetColors()} />
      </div>
      <div className="fc-chips2-info">
        <div className={target === 'primary' ? 'on' : ''} onClick={() => onTarget('primary')}>
          <span>Foreground</span>
          <code>{opaqueHex(primary)}</code>
        </div>
        <div className={target === 'secondary' ? 'on' : ''} onClick={() => onTarget('secondary')}>
          <span>Background</span>
          <code>{opaqueHex(secondary)}</code>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ panel ------------------------------ */

export function ColorPanel() {
  const primary = useEditor((s) => s.primaryColor);
  const secondary = useEditor((s) => s.secondaryColor);
  const [target, setTargetState] = useState<Target>(lastTarget);
  const [mode, setModeState] = useState<Mode>(() => readLS<Mode>(MODE_KEY, 'hsb', ['hsb', 'rgb', 'hex']));
  const [kind, setKindState] = useState<HarmonyKind>(() =>
    readLS<HarmonyKind>(HARMONY_KEY, 'complementary', HARMONIES.map((h) => h.value)),
  );
  const color = target === 'primary' ? primary : secondary;
  const other = target === 'primary' ? secondary : primary;

  const setTarget = (t: Target) => {
    lastTarget = t;
    setTargetState(t);
  };
  const setMode = (m: Mode) => {
    writeLS(MODE_KEY, m);
    setModeState(m);
  };
  const setKind = (k: HarmonyKind) => {
    writeLS(HARMONY_KEY, k);
    setKindState(k);
  };

  const setColor = (c: string) => {
    const st = useEditor.getState();
    if (target === 'primary') st.setPrimaryColor(c);
    else st.setSecondaryColor(c);
  };
  const commit = (c?: string) => useEditor.getState().pushRecentColor(c ?? (target === 'primary' ? useEditor.getState().primaryColor : useEditor.getState().secondaryColor));

  /* HSV kept locally so hue/saturation survive black/gray colors. */
  const [hsv, setHsv] = useState(() => {
    const p = parseColor(color);
    return rgbToHsv(p.r, p.g, p.b);
  });
  const lastEmitted = useRef(color);
  useEffect(() => {
    if (color.toLowerCase() === lastEmitted.current.toLowerCase()) return;
    lastEmitted.current = color;
    const p = parseColor(color);
    const n = rgbToHsv(p.r, p.g, p.b);
    setHsv((prev) => {
      if (n[2] === 0) return [prev[0], prev[1], 0];
      if (n[1] === 0) return [prev[0], 0, n[2]];
      return n;
    });
  }, [color]);

  const emitHsv = (h: number, s: number, v: number) => {
    setHsv([h, s, v]);
    const c = hsvHex(h, s, v);
    lastEmitted.current = c;
    setColor(c);
  };
  const emitHex = (c: string) => {
    lastEmitted.current = c;
    const p = parseColor(c);
    const n = rgbToHsv(p.r, p.g, p.b);
    setHsv((prev) => (n[1] === 0 || n[2] === 0 ? [prev[0], n[1], n[2]] : n));
    setColor(c);
  };

  const rgb = parseColor(color);
  const [h, s, v] = hsv;
  const hueCss = hsvHex(h, 1, 1);

  return (
    <div className="fc-color">
      <ColorChips primary={primary} secondary={secondary} target={target} onTarget={setTarget} />

      <div className="fc-color-picker">
        <ColorPicker value={color} onChange={emitHex} onCommit={(c) => commit(c)} />
      </div>

      <div className="fc-color-tabs">
        <Tabs
          value={mode}
          onChange={setMode}
          tabs={[
            { value: 'hsb', label: 'HSB' },
            { value: 'rgb', label: 'RGB' },
            { value: 'hex', label: 'HEX' },
          ]}
        />
      </div>

      <div className="fc-color-channels">
        {mode === 'hsb' && (
          <>
            <ChannelSlider
              label="H"
              value={Math.round(h)}
              max={360}
              unit="°"
              track="linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)"
              onChange={(x) => emitHsv(x, s, v)}
              onCommit={() => commit()}
            />
            <ChannelSlider
              label="S"
              value={Math.round(s * 100)}
              max={100}
              unit="%"
              track={`linear-gradient(to right, ${hsvHex(h, 0, v)}, ${hsvHex(h, 1, v)})`}
              onChange={(x) => emitHsv(h, x / 100, v)}
              onCommit={() => commit()}
            />
            <ChannelSlider
              label="B"
              value={Math.round(v * 100)}
              max={100}
              unit="%"
              track={`linear-gradient(to right, #000, ${hsvHex(h, s, 1)})`}
              onChange={(x) => emitHsv(h, s, x / 100)}
              onCommit={() => commit()}
            />
          </>
        )}
        {mode === 'rgb' && (
          <>
            {(['r', 'g', 'b'] as const).map((ch) => {
              const lo = { ...rgb, [ch]: 0 };
              const hi = { ...rgb, [ch]: 255 };
              return (
                <ChannelSlider
                  key={ch}
                  label={ch.toUpperCase()}
                  value={Math.round(rgb[ch])}
                  max={255}
                  track={`linear-gradient(to right, ${toHex(lo)}, ${toHex(hi)})`}
                  onChange={(x) => emitHex(toHex({ ...rgb, a: 1, [ch]: x }))}
                  onCommit={() => commit()}
                />
              );
            })}
          </>
        )}
        {mode === 'hex' && <HexTab color={color} onColor={(c) => (emitHex(c), commit(c))} />}
      </div>

      <Section
        title="Harmonies"
        actions={<Select value={kind} onChange={setKind} options={HARMONIES} width={128} title="Harmony rule" />}
      >
        <HarmonyRow base={color} kind={kind} hueCss={hueCss} saturation={s} onPick={(c, alt) => (alt ? useEditor.getState().setSecondaryColor(c) : emitHex(c), commit(c))} />
      </Section>

      <Section title="Contrast (WCAG)" defaultOpen>
        <ContrastRows color={color} other={other} target={target} />
      </Section>
    </div>
  );
}

/* ------------------------------ HEX tab ------------------------------ */

function HexTab({ color, onColor }: { color: string; onColor: (c: string) => void }) {
  const hex = opaqueHex(color);
  const [text, setText] = useState(hex);
  useEffect(() => setText(hex), [hex]);
  const p = parseColor(color);
  const [hh, ss, ll] = rgbToHsl(p.r, p.g, p.b);
  const rgbStr = `rgb(${Math.round(p.r)}, ${Math.round(p.g)}, ${Math.round(p.b)})`;
  const hslStr = `hsl(${Math.round(hh)}, ${Math.round(ss * 100)}%, ${Math.round(ll * 100)}%)`;
  const copy = (s: string) =>
    void navigator.clipboard?.writeText(s).then(
      () => toast(`Copied ${s}`, 'success'),
      () => toast('Clipboard unavailable', 'warning'),
    );
  const apply = () => {
    const n = normalizeHex(text);
    if (n) onColor(n);
    else {
      toast('Enter a hex color like #ff8800 or f80', 'warning');
      setText(hex);
    }
  };
  return (
    <div className="fc-hex">
      <div className="fc-hex-row">
        <span className="fc-ch-label">#</span>
        <input
          className="ui-input fc-hex-input"
          value={text.replace(/^#/, '')}
          maxLength={8}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={apply}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setText(hex);
          }}
        />
        <IconButton icon={Copy} size="sm" iconSize={12} title="Copy hex" onClick={() => copy(hex)} />
      </div>
      {[rgbStr, hslStr].map((s) => (
        <div className="fc-hex-row" key={s}>
          <code className="fc-hex-code">{s}</code>
          <IconButton icon={Copy} size="sm" iconSize={12} title="Copy" onClick={() => copy(s)} />
        </div>
      ))}
      <div className="fc-note">{describeColor(color)}</div>
    </div>
  );
}

/* ------------------------------ harmonies ------------------------------ */

function HarmonyRow({
  base,
  kind,
  saturation,
  onPick,
}: {
  base: string;
  kind: HarmonyKind;
  hueCss: string;
  saturation: number;
  onPick: (c: string, alt: boolean) => void;
}) {
  const colors = harmony(base, kind);
  const baseHex = opaqueHex(base);
  const addAll = () => {
    const st = useUserPalettes.getState();
    const mine = st.palettes.find((p) => p.id === MY_SWATCHES_ID);
    const have = new Set(mine?.swatches.map((x) => x.color.toLowerCase()));
    let n = 0;
    for (const c of colors) {
      if (have.has(c.toLowerCase())) continue;
      st.addSwatch(MY_SWATCHES_ID, c);
      have.add(c.toLowerCase());
      n++;
    }
    toast(n ? `Added ${n} color${n > 1 ? 's' : ''} to My Swatches` : 'Already in My Swatches', n ? 'success' : 'info');
  };
  return (
    <div className="fc-harmony">
      <div className="fc-harmony-row">
        {colors.map((c, i) => (
          <button
            key={`${i}:${c}`}
            className={`fc-harmony-swatch${c === baseHex ? ' base' : ''}`}
            style={{ background: c }}
            title={`${describeColor(c)} ${c}\nClick: edit color · Alt-click: background · right-click: more`}
            onClick={(e) => onPick(c, e.altKey)}
            onContextMenu={(e) =>
              showContextMenu(e, [
                { label: 'Use as Foreground', run: () => useEditor.getState().setPrimaryColor(c) },
                { label: 'Use as Background', run: () => useEditor.getState().setSecondaryColor(c) },
                { label: 'Add to My Swatches', run: () => useUserPalettes.getState().addSwatch(MY_SWATCHES_ID, c) },
              ])
            }
          >
            <span>{c.slice(1)}</span>
          </button>
        ))}
        <IconButton icon={SquarePlus} size="sm" iconSize={13} title="Add these colors to My Swatches" onClick={addAll} />
      </div>
      {saturation < 0.06 && kind !== 'monochrome' && <div className="fc-note">Gray has no hue — pick a saturated color for richer harmonies.</div>}
    </div>
  );
}

/* ------------------------------ contrast ------------------------------ */

function Badge({ ratio }: { ratio: number }) {
  const lvl = wcagLevel(ratio);
  return <span className={`fc-badge ${lvl === 'Fail' ? 'fail' : lvl === 'AA Large' ? 'warn' : 'ok'}`}>{lvl}</span>;
}

function ContrastRows({ color, other, target }: { color: string; other: string; target: Target }) {
  const c = opaqueHex(color);
  const rows: { label: string; bg: string; ratio: number }[] = [
    { label: 'on White', bg: '#ffffff', ratio: contrastRatio(c, '#ffffff') },
    { label: 'on Black', bg: '#000000', ratio: contrastRatio(c, '#000000') },
    { label: target === 'primary' ? 'on Background' : 'on Foreground', bg: opaqueHex(other), ratio: contrastRatio(c, opaqueHex(other)) },
  ];
  return (
    <div className="fc-contrast">
      {rows.map((r) => (
        <div className="fc-contrast-row" key={r.label}>
          <span className="fc-contrast-sample" style={{ background: r.bg, color: c }}>
            Aa
          </span>
          <span className="fc-contrast-label">{r.label}</span>
          <span className="fc-contrast-ratio">{r.ratio.toFixed(2)}:1</span>
          <Badge ratio={r.ratio} />
        </div>
      ))}
      <div className="fc-note">AA ≥ 4.5 · AA Large ≥ 3 · AAA ≥ 7 — keep thumbnail titles ≥ 4.5:1 over their backdrop.</div>
    </div>
  );
}
