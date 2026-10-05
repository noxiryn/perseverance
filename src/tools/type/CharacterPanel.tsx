/**
 * Character panel ('character'): edits the active text layer (or the layer being typed), or the
 * Type tool defaults when no text layer is selected. Live preview while scrubbing, coalesced commits.
 */
import { ArrowLeftRight, ArrowUpDown, Pencil, Spline, UnfoldHorizontal, UnfoldVertical, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Checkbox, ColorField, Field, IconButton, NumberField, Section, Select, Slider } from '../../ui/controls';
import { useActiveDoc } from '../../state/editor';
import {
  applyTextStyle,
  clearDefaultTextStyle,
  setAntiAlias,
  setBoxWidth,
  setFillType,
  setLineHeight,
  setParagraphMode,
  setScale,
  setStroke,
  setTracking,
  setWarp,
  useTextView,
} from './actions';
import { AlignButtons, FontFamilyField, FontSizeField, NumCell, StyleToggles, TextFillChip, WeightStyleSelect } from './controls';
import { NO_WARP, useTypeOptions, type TextWarp } from './options';
import { editTextLayer, useTypeEditing } from './session';
import { TEXT_STYLES, type TextStylePreset } from './styles';
import { DEFAULT_BEND, WARP_STYLES, openWarpDialog } from './WarpDialog';
import './type.css';

function TargetLine() {
  const { layer } = useTextView();
  const editing = useTypeEditing((s) => s.layerId);
  const doc = useActiveDoc();
  if (layer) {
    return (
      <div className="type-char-target">
        <span className="type-char-dot active" />
        <span className="type-char-target-name">{editing ? `Editing “${layer.name}”` : `“${layer.name}”`}</span>
        {!editing && !layer.locks.all && (
          <IconButton icon={Pencil} size="sm" title="Edit text on canvas" onClick={() => editTextLayer(layer.id, { selectAll: true })} />
        )}
      </div>
    );
  }
  return (
    <div className="type-char-target">
      <span className="type-char-dot" />
      <span className="type-char-target-name dim">{doc ? 'No text layer selected — settings apply to new text' : 'Settings apply to new text'}</span>
    </div>
  );
}

function CharacterBlock() {
  const { text } = useTextView();
  return (
    <div className="type-char-block">
      <FontFamilyField />
      <div className="type-row2">
        <WeightStyleSelect />
        <FontSizeField width="100%" />
      </div>
      <div className="type-grid2">
        <NumCell
          icon={<ArrowUpDown size={12} />}
          title="Leading (line height, % of size)"
          value={text.lineHeight}
          min={0.3}
          max={5}
          step={1}
          displayScale={100}
          unit="%"
          onLive={(v) => setLineHeight(v, 'live')}
          onCommit={(v) => setLineHeight(v, 'commit')}
        />
        <NumCell
          icon={<ArrowLeftRight size={12} />}
          title="Tracking (letter spacing, px)"
          value={text.letterSpacing}
          min={-200}
          max={500}
          step={0.5}
          unit="px"
          onLive={(v) => setTracking(v, 'live')}
          onCommit={(v) => setTracking(v, 'commit')}
        />
        <NumCell
          icon={<UnfoldVertical size={12} />}
          title="Vertical scale"
          value={text.scaleY}
          min={0.05}
          max={10}
          step={1}
          displayScale={100}
          unit="%"
          onLive={(v) => setScale('scaleY', v, 'live')}
          onCommit={(v) => setScale('scaleY', v, 'commit')}
        />
        <NumCell
          icon={<UnfoldHorizontal size={12} />}
          title="Horizontal scale"
          value={text.scaleX}
          min={0.05}
          max={10}
          step={1}
          displayScale={100}
          unit="%"
          onLive={(v) => setScale('scaleX', v, 'live')}
          onCommit={(v) => setScale('scaleX', v, 'commit')}
        />
      </div>
      <div className="type-row">
        <span className="type-label">Fill</span>
        <TextFillChip placement="left-start" />
        <div className="type-seg small" role="tablist">
          {(['solid', 'gradient'] as const).map((m) => (
            <button key={m} className={`type-seg-btn${(text.fill.type === 'gradient' ? 'gradient' : 'solid') === m ? ' active' : ''}`} onClick={() => setFillType(m)}>
              {m === 'solid' ? 'Color' : 'Gradient'}
            </button>
          ))}
        </div>
        <span className="type-spacer" />
        <Select
          value={text.antiAlias === false ? 'none' : 'smooth'}
          options={[
            { value: 'smooth', label: 'Smooth' },
            { value: 'none', label: 'Aliased' },
          ]}
          width={74}
          title="Anti-aliasing"
          onChange={(v) => setAntiAlias(v === 'smooth')}
        />
      </div>
      <div className="type-row">
        <StyleToggles />
        <span className="type-spacer" />
        <AlignButtons />
      </div>
    </div>
  );
}

function StrokeBlock() {
  const { text } = useTextView();
  const opts = useTypeOptions();
  const s = text.stroke;
  const color = s?.color ?? opts.strokeColor;
  const width = s?.width ?? opts.strokeWidth;
  return (
    <div className="type-row">
      <Checkbox checked={!!s} onChange={(on) => setStroke({ on }, 'commit')} label="Outline" />
      <span className="type-spacer" />
      <ColorField value={color} onChange={(c) => setStroke({ on: true, color: c }, 'live')} onCommit={(c) => setStroke({ on: true, color: c }, 'commit')} alpha title="Outline color" />
      <NumberField
        value={width}
        min={0}
        max={300}
        step={0.5}
        unit="px"
        width={64}
        title="Outline width"
        onChange={(v) => setStroke({ on: v > 0, width: v }, 'live')}
        onCommit={(v) => setStroke({ on: v > 0, width: v }, 'commit')}
      />
    </div>
  );
}

function ParagraphBlock() {
  const { text, layer } = useTextView();
  const paragraph = !!text.boxWidth;
  return (
    <>
      <div className="type-row">
        <div className="type-seg" role="tablist" aria-label="Text type">
          <button className={`type-seg-btn${!paragraph ? ' active' : ''}`} disabled={!layer} onClick={() => setParagraphMode(false)} title="Point text: grows as you type, no wrapping">
            Point
          </button>
          <button className={`type-seg-btn${paragraph ? ' active' : ''}`} disabled={!layer} onClick={() => setParagraphMode(true)} title="Paragraph text: wraps inside a box">
            Paragraph
          </button>
        </div>
        <span className="type-spacer" />
        {paragraph && (
          <NumberField
            value={text.boxWidth ?? 0}
            min={8}
            max={20000}
            step={1}
            unit="px"
            width={78}
            title="Paragraph box width"
            scrubLabel={<span className="type-label">W</span>}
            onChange={(v) => setBoxWidth(v, 'live')}
            onCommit={(v) => setBoxWidth(v, 'commit')}
          />
        )}
      </div>
      {!layer && <div className="type-hint">Drag with the Type tool to create a paragraph box.</div>}
    </>
  );
}

function WarpBlock() {
  const { text, layer } = useTextView();
  const w: TextWarp = { ...NO_WARP, ...text.warp };
  const set = (patch: Partial<TextWarp>, phase: 'live' | 'commit') => {
    const next = { ...w, ...patch };
    if (next.style === 'none' && (patch.bend !== undefined || patch.horizontal !== undefined || patch.vertical !== undefined)) next.style = 'arc';
    setWarp(next, phase);
  };
  if (!layer) return <div className="type-hint">Select a text layer to warp it (arc, arch, flag, wave…).</div>;
  return (
    <div className="type-warp-inline">
      <div className="type-row">
        <Select
          value={w.style}
          options={WARP_STYLES}
          width="100%"
          title="Warp style"
          onChange={(style) => set({ style, bend: style === 'none' ? 0 : w.style === 'none' || !w.bend ? DEFAULT_BEND[style] : w.bend }, 'commit')}
        />
        <IconButton icon={Spline} title="Warp Text dialog…" onClick={openWarpDialog} />
      </div>
      {w.style !== 'none' && (
        <>
          <Field label="Bend">
            <Slider value={w.bend} min={-100} max={100} step={1} unit="%" onChange={(v) => set({ bend: v }, 'live')} onCommit={(v) => set({ bend: v }, 'commit')} />
          </Field>
          <Field label="Horiz.">
            <Slider value={w.horizontal} min={-100} max={100} step={1} unit="%" onChange={(v) => set({ horizontal: v }, 'live')} onCommit={(v) => set({ horizontal: v }, 'commit')} />
          </Field>
          <Field label="Vert.">
            <Slider value={w.vertical} min={-100} max={100} step={1} unit="%" onChange={(v) => set({ vertical: v }, 'live')} onCommit={(v) => set({ vertical: v }, 'commit')} />
          </Field>
        </>
      )}
    </div>
  );
}

function presetStyle(p: TextStylePreset): CSSProperties {
  const pv = p.preview;
  const css: CSSProperties = {
    fontFamily: `"${p.text.fontFamily}", sans-serif`,
    fontWeight: p.text.fontWeight ?? 400,
    color: pv.color,
    fontSize: pv.size ?? 22,
    letterSpacing: pv.tracking,
    textShadow: pv.shadow,
  };
  if (pv.stroke) {
    (css as Record<string, unknown>).WebkitTextStroke = pv.stroke;
    (css as Record<string, unknown>).paintOrder = 'stroke fill';
  }
  return css;
}

function StylesBlock() {
  const { layer } = useTextView();
  const opts = useTypeOptions();
  const def = TEXT_STYLES.find((s) => s.id === opts.stylePreset);
  return (
    <>
      {!layer && def && (
        <div className="type-row type-default-style">
          <span className="type-hint">
            New text uses <b>{def.name}</b>
          </span>
          <span className="type-spacer" />
          <IconButton icon={X} size="sm" title="Stop using this style for new text" onClick={clearDefaultTextStyle} />
        </div>
      )}
      <div className="type-presets">
        {TEXT_STYLES.map((p) => (
          <button
            key={p.id}
            className={`type-preset${!layer && opts.stylePreset === p.id ? ' active' : ''}`}
            title={`${p.name} — ${p.description}${layer ? '' : ' (applies to new text)'}`}
            onClick={() => void applyTextStyle(p.id)}
          >
            <span className="type-preset-sample" style={{ background: p.preview.bg }}>
              <span style={presetStyle(p)}>{p.preview.sample}</span>
            </span>
            <span className="type-preset-name">{p.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function CharacterPanel() {
  return (
    <div className="type-char">
      <TargetLine />
      <div className="type-char-scroll">
        <CharacterBlock />
        <Section title="Stroke">
          <StrokeBlock />
        </Section>
        <Section title="Paragraph">
          <ParagraphBlock />
        </Section>
        <Section title="Warp">
          <WarpBlock />
        </Section>
        <Section title="Text Styles">
          <StylesBlock />
        </Section>
      </div>
    </div>
  );
}
