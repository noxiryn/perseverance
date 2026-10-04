/**
 * High-level text style actions shared by the options bar, the Character panel, the Properties
 * section and the Type menu. Every action targets the edited layer / selected text layers (see
 * apply.ts) and falls back to the type tool defaults when no text layer is selected.
 */
import { useMemo } from 'react';
import type { Gradient, TextLayer, TextProps } from '../../core/types';
import { fonts } from '../../registry';
import { activeDoc, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { ensureFont, fontWeightFor } from '../../fonts/loader';
import { measureText } from '../../render/compositor';
import { applyTextChange, primaryTextTarget, useTextTarget, type Phase } from './apply';
import {
  NO_WARP,
  defaultTextGradient,
  readTypeOptions,
  textPropsFromOptions,
  useTypeOptions,
  writeTypeOptions,
  type TextWarp,
} from './options';
import { getTextStyle, presetEffects, presetTextProps } from './styles';

/** Style values the UI shows: the target layer's text, else the tool defaults (primary color fill). */
export function currentTextView(): TextProps {
  const l = primaryTextTarget();
  if (l) return l.text;
  const st = useEditor.getState();
  return textPropsFromOptions(readTypeOptions(), st.primaryColor, st.secondaryColor);
}

/** React version of currentTextView (+ the target layer). */
export function useTextView(): { text: TextProps; layer: TextLayer | null } {
  const layer = useTextTarget();
  const o = useTypeOptions();
  const primary = useEditor((s) => s.primaryColor);
  const secondary = useEditor((s) => s.secondaryColor);
  const optsKey = JSON.stringify(o);
  const fallback = useMemo(() => textPropsFromOptions(o, primary, secondary), [optsKey, primary, secondary]); // eslint-disable-line react-hooks/exhaustive-deps
  return { text: layer ? layer.text : fallback, layer };
}

function findFont(family: string) {
  return fonts.get(family) ?? fonts.list().find((f) => f.family.toLowerCase() === family.toLowerCase());
}

const withTimeout = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => window.setTimeout(r, ms))]);

/* ---------------- font ---------------- */

export async function setFontFamily(family: string) {
  const cur = currentTextView();
  const def = findFont(family);
  const weight = fontWeightFor(def?.weights, cur.fontWeight);
  const style: 'normal' | 'italic' = cur.fontStyle === 'italic' && def?.italic ? 'italic' : 'normal';
  // Let the face load first so anchors are computed with the real metrics (no fallback flash).
  await withTimeout(ensureFont(family, weight, style), 900);
  applyTextChange({ text: { fontFamily: family, fontWeight: weight, fontStyle: style } }, 'commit', 'Change Font', { fontFamily: family, fontWeight: weight, fontStyle: style });
}

export async function setWeightStyle(fontWeight: number, fontStyle: 'normal' | 'italic') {
  const cur = currentTextView();
  await withTimeout(ensureFont(cur.fontFamily, fontWeight, fontStyle), 900);
  applyTextChange({ text: { fontWeight, fontStyle } }, 'commit', 'Font Style', { fontWeight, fontStyle });
}

/* ---------------- numbers ---------------- */

export function setFontSize(v: number, phase: Phase) {
  const fontSize = Math.max(1, Math.min(2000, Math.round(v * 10) / 10));
  applyTextChange({ text: { fontSize } }, phase, 'Font Size', { fontSize });
}

export function stepFontSize(dir: 1 | -1, big = false) {
  const cur = currentTextView().fontSize;
  const step = big ? 10 : cur >= 100 ? 4 : 2;
  const next = Math.max(1, Math.round(cur + dir * step));
  if (applyTextChange({ text: { fontSize: next } }, 'commit', 'Font Size', { fontSize: next }) === 'tool') toast(`Type tool size: ${next} px`, 'info', 1200);
}

export function setLineHeight(v: number, phase: Phase) {
  const lineHeight = Math.max(0.3, Math.min(5, v));
  applyTextChange({ text: { lineHeight } }, phase, 'Leading', { lineHeight });
}

export function setTracking(v: number, phase: Phase) {
  const letterSpacing = Math.max(-200, Math.min(500, v));
  applyTextChange({ text: { letterSpacing } }, phase, 'Tracking', { letterSpacing });
}

export function setScale(axis: 'scaleX' | 'scaleY', v: number, phase: Phase) {
  const val = Math.max(0.05, Math.min(10, v));
  applyTextChange({ text: { [axis]: val } }, phase, axis === 'scaleX' ? 'Horizontal Scale' : 'Vertical Scale', { [axis]: val });
}

/* ---------------- toggles & alignment ---------------- */

export function setAlign(align: TextProps['align']) {
  applyTextChange({ text: { align } }, 'commit', 'Text Alignment', { align });
}

export type TextToggle = 'fauxBold' | 'fauxItalic' | 'uppercase';
const TOGGLE_LABEL: Record<TextToggle, string> = { fauxBold: 'Faux Bold', fauxItalic: 'Faux Italic', uppercase: 'All Caps' };

export function toggleText(key: TextToggle, value?: boolean) {
  const next = value ?? !currentTextView()[key];
  const res = applyTextChange({ text: { [key]: next } }, 'commit', TOGGLE_LABEL[key], { [key]: next });
  if (res === 'tool') toast(`${TOGGLE_LABEL[key]} ${next ? 'on' : 'off'} for new text`, 'info', 1400);
}

export function setAntiAlias(on: boolean) {
  applyTextChange({ text: { antiAlias: on } }, 'commit', 'Anti-alias', { antiAlias: on });
}

/* ---------------- fill & stroke ---------------- */

export function setFillColor(color: string, phase: Phase) {
  const res = applyTextChange({ text: { fill: { type: 'solid', color } } }, phase, 'Text Color', { fillType: 'solid' });
  // New text uses the primary color.
  if (res === 'tool') useEditor.getState().setPrimaryColor(color);
}

export function setFillGradient(gradient: Gradient, phase: Phase) {
  applyTextChange({ text: { fill: { type: 'gradient', gradient } } }, phase, 'Text Gradient', { fillType: 'gradient', gradient });
}

export function setFillType(type: 'solid' | 'gradient') {
  const cur = currentTextView();
  const st = useEditor.getState();
  if (type === 'solid') {
    const color = cur.fill.type === 'solid' ? cur.fill.color : cur.fill.type === 'gradient' ? (cur.fill.gradient.stops[0]?.color ?? st.primaryColor) : st.primaryColor;
    applyTextChange({ text: { fill: { type: 'solid', color } } }, 'commit', 'Text Color', { fillType: 'solid' });
  } else {
    const base = cur.fill.type === 'solid' ? cur.fill.color : st.primaryColor;
    const g = cur.fill.type === 'gradient' ? cur.fill.gradient : readTypeOptions().gradient ?? defaultTextGradient(base, st.secondaryColor);
    applyTextChange({ text: { fill: { type: 'gradient', gradient: g } } }, 'commit', 'Text Gradient', { fillType: 'gradient', gradient: g });
  }
}

export function setStroke(patch: { on?: boolean; color?: string; width?: number }, phase: Phase) {
  const cur = currentTextView().stroke;
  const o = readTypeOptions();
  const on = patch.on ?? !!cur;
  const color = patch.color ?? cur?.color ?? o.strokeColor;
  const width = Math.max(0, patch.width ?? cur?.width ?? o.strokeWidth);
  const stroke = on && width > 0 ? { color, width } : null;
  applyTextChange({ text: { stroke } }, phase, 'Text Stroke', { strokeOn: !!stroke, strokeColor: color, strokeWidth: width || o.strokeWidth });
}

/* ---------------- warp ---------------- */

export function setWarp(warp: TextWarp, phase: Phase, label = 'Warp Text') {
  applyTextChange({ text: { warp: { ...NO_WARP, ...warp } } }, phase, label, { warp: { ...NO_WARP, ...warp } });
}

/* ---------------- point / paragraph ---------------- */

export function setParagraphMode(paragraph: boolean) {
  const l = primaryTextTarget();
  if (!l) {
    toast('Select a text layer to convert between point and paragraph text', 'info');
    return;
  }
  if (paragraph === !!l.text.boxWidth) return;
  applyTextChange(
    {
      text: (t) => {
        if (paragraph) {
          // Keep the current line breaks: the box is as wide as the widest line.
          const w = Math.ceil(Math.max(16, measureWidth(t) + Math.max(4, t.fontSize * 0.1)));
          t.boxWidth = w;
        } else t.boxWidth = null;
      },
    },
    'commit',
    paragraph ? 'Convert to Paragraph Text' : 'Convert to Point Text',
  );
}

/** Width of the text laid out as point text (widest hard line). */
function measureWidth(t: TextProps): number {
  return measureText({ ...t, boxWidth: null }).width;
}

export function setBoxWidth(v: number, phase: Phase) {
  const w = Math.max(8, Math.round(v));
  applyTextChange({ text: { boxWidth: w } }, phase, 'Paragraph Width');
}

/* ---------------- style presets ---------------- */

/** Apply a text style preset (props + effects + opacity). Without a text layer it becomes the default for new text. */
export async function applyTextStyle(id: string) {
  const p = getTextStyle(id);
  if (!p) return;
  const props = presetTextProps(p);
  if (props.fontFamily) await withTimeout(ensureFont(props.fontFamily, props.fontWeight ?? 400, props.fontStyle ?? 'normal'), 900);
  const res = applyTextChange(
    {
      text: props,
      layer: (l) => {
        l.effects = presetEffects(p, l.text.fontSize);
        l.opacity = p.opacity ?? 1;
      },
    },
    'commit',
    `Text Style: ${p.name}`,
  );
  if (res === 'layers') return;
  if (res === 'none') return;
  // No text layer: make it the type tool default.
  const patch: Parameters<typeof writeTypeOptions>[0] = { stylePreset: p.id };
  for (const k of ['fontFamily', 'fontWeight', 'fontStyle', 'uppercase', 'letterSpacing', 'lineHeight', 'fauxBold', 'fauxItalic'] as const) {
    if (props[k] !== undefined) (patch as Record<string, unknown>)[k] = props[k];
  }
  patch.strokeOn = false;
  if (props.fill?.type === 'gradient') {
    patch.fillType = 'gradient';
    patch.gradient = props.fill.gradient;
  } else {
    patch.fillType = 'solid';
    if (props.fill?.type === 'solid') useEditor.getState().setPrimaryColor(props.fill.color);
  }
  writeTypeOptions(patch);
  toast(activeDoc() ? `“${p.name}” will be used for new text — click the canvas with the Type tool` : `“${p.name}” set as the default text style`, 'info');
}

export function clearDefaultTextStyle() {
  writeTypeOptions({ stylePreset: null });
}
