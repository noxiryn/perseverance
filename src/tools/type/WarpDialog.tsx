/** Warp Text dialog: style + bend / horizontal / vertical distortion with live canvas preview. */
import { useMemo, useState } from 'react';
import type { TextWarpStyle } from '../../core/types';
import { warpPoint } from '../../render/warpMath';
import { Button, Dialog, Field, Slider } from '../../ui/controls';
import { openDialog, toast } from '../../state/ui';
import { activeSession, useEditor } from '../../state/editor';
import { primaryTextTarget } from './apply';
import { setWarp } from './actions';
import { NO_WARP, type TextWarp } from './options';
import { isEditing } from './session';
import './type.css';

export const WARP_STYLES: { value: TextWarpStyle; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'arc', label: 'Arc' },
  { value: 'arch', label: 'Arch' },
  { value: 'bulge', label: 'Bulge' },
  { value: 'flag', label: 'Flag' },
  { value: 'wave', label: 'Wave' },
  { value: 'rise', label: 'Rise' },
  { value: 'fisheye', label: 'Fisheye' },
  { value: 'squeeze', label: 'Squeeze' },
];

/** Default bend when picking a style from "None". */
export const DEFAULT_BEND: Record<TextWarpStyle, number> = { none: 0, arc: 50, arch: 50, bulge: 50, flag: 50, wave: 50, rise: 50, fisheye: 50, squeeze: 40 };

/** Small SVG of a warped grid (for style tiles and the dialog preview). */
export function WarpGlyph({ warp, width = 44, height = 26, lines = 4, strokeWidth = 1.2 }: { warp: TextWarp; width?: number; height?: number; lines?: number; strokeWidth?: number }) {
  const paths = useMemo(() => {
    const a = width * 0.38;
    const c = height * 0.26;
    const cx = width / 2;
    const cy = height / 2;
    const map = (x: number, y: number) => {
      const [X, Y] = warp.style === 'none' ? [x, y] : warpPoint(warp, x, y, a, c);
      return `${(cx + X).toFixed(2)} ${(cy + Y).toFixed(2)}`;
    };
    const out: string[] = [];
    const N = 24;
    for (let j = 0; j <= lines; j++) {
      const y = -c + (2 * c * j) / lines;
      let d = '';
      for (let i = 0; i <= N; i++) d += `${i ? 'L' : 'M'}${map(-a + (2 * a * i) / N, y)}`;
      out.push(d);
    }
    for (let i = 0; i <= lines + 2; i++) {
      const x = -a + (2 * a * i) / (lines + 2);
      let d = '';
      for (let k = 0; k <= 8; k++) d += `${k ? 'L' : 'M'}${map(x, -c + (2 * c * k) / 8)}`;
      out.push(d);
    }
    return out;
  }, [warp, width, height, lines]);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="type-warp-glyph">
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      ))}
    </svg>
  );
}

function WarpDialog({ close, initial }: { close: (r?: TextWarp) => void; initial: TextWarp }) {
  const [w, setW] = useState<TextWarp>(initial);
  const push = (next: TextWarp) => {
    setW(next);
    setWarp(next, 'live');
  };
  // Reverting the preview happens in openWarpDialog (also covers closing via the backdrop).
  const cancel = () => close();
  const ok = () => {
    setWarp(w, 'commit');
    close(w);
  };
  const active = w.style !== 'none';
  return (
    <Dialog
      title="Warp Text"
      onClose={cancel}
      onSubmit={ok}
      width={420}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => push({ ...NO_WARP })}
            disabled={!active && !w.bend && !w.horizontal && !w.vertical}
          >
            Reset
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" onClick={ok}>
            OK
          </Button>
        </>
      }
    >
      <div className="type-warp">
        <div className="type-warp-styles" role="listbox" aria-label="Warp style">
          {WARP_STYLES.map((s) => {
            const sample: TextWarp = { style: s.value, bend: s.value === 'none' ? 0 : w.style === s.value ? w.bend || DEFAULT_BEND[s.value] : DEFAULT_BEND[s.value], horizontal: 0, vertical: 0 };
            return (
              <button
                key={s.value}
                role="option"
                aria-selected={w.style === s.value}
                className={`type-warp-style${w.style === s.value ? ' active' : ''}`}
                title={s.label}
                onClick={() => push({ ...w, style: s.value, bend: s.value === 'none' ? 0 : w.style === 'none' || !w.bend ? DEFAULT_BEND[s.value] : w.bend })}
              >
                <WarpGlyph warp={sample} />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
        <div className="type-warp-preview">
          <WarpGlyph warp={w} width={360} height={120} lines={6} strokeWidth={1.1} />
        </div>
        <Field label="Bend">
          <Slider value={w.bend} min={-100} max={100} step={1} unit="%" onChange={(v) => push({ ...w, bend: v, style: w.style === 'none' ? 'arc' : w.style })} />
        </Field>
        <Field label="Horizontal">
          <Slider value={w.horizontal} min={-100} max={100} step={1} unit="%" onChange={(v) => push({ ...w, horizontal: v, style: w.style === 'none' ? 'arc' : w.style })} />
        </Field>
        <Field label="Vertical">
          <Slider value={w.vertical} min={-100} max={100} step={1} unit="%" onChange={(v) => push({ ...w, vertical: v, style: w.style === 'none' ? 'arc' : w.style })} />
        </Field>
        <div className="type-warp-hint">Changes preview live on the canvas. Warp stays editable — the text remains a text layer.</div>
      </div>
    </Dialog>
  );
}

/** Type ▸ Warp Text… */
export function openWarpDialog() {
  if (!activeSession()) {
    toast('Open a document and select a text layer to warp it', 'info');
    return;
  }
  const l = primaryTextTarget();
  if (!l) {
    toast('Select a text layer to warp it', 'info');
    return;
  }
  if (l.locks.all) {
    toast(`“${l.name}” is locked — unlock it to warp it`, 'warning');
    return;
  }
  const initial: TextWarp = { ...NO_WARP, ...l.text.warp };
  void openDialog<TextWarp, { initial: TextWarp }>(WarpDialog, { initial }).then((res) => {
    if (res) return;
    // Cancelled: drop the live preview.
    if (isEditing()) setWarp(initial, 'live');
    else useEditor.getState().cancelPreview();
  });
}
