/** Properties panel section for text layers: compact character controls + quick actions. */
import { ArrowLeftRight, ArrowUpDown, PanelRight, Pencil, Spline } from 'lucide-react';
import { Button, Field } from '../../ui/controls';
import { useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { setLineHeight, setTracking } from './actions';
import { AlignButtons, FontFamilyField, FontSizeField, NumCell, StyleToggles, TextFillChip, WeightStyleSelect } from './controls';
import { editTextLayer } from './session';
import { openWarpDialog } from './WarpDialog';
import './type.css';

export function TextProperties({ layerId }: { layerId: string }) {
  const layer = useEditor((s) => {
    const l = s.activeDocId ? s.sessions[s.activeDocId]?.doc.layers[layerId] : null;
    return l && l.type === 'text' ? l : null;
  });
  if (!layer) return <div className="type-hint">Select a text layer.</div>;
  const t = layer.text;
  return (
    <div className="type-props">
      <FontFamilyField />
      <div className="type-row2">
        <WeightStyleSelect />
        <FontSizeField width="100%" />
      </div>
      <div className="type-grid2">
        <NumCell
          icon={<ArrowUpDown size={12} />}
          title="Leading (% of size)"
          value={t.lineHeight}
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
          title="Tracking (px)"
          value={t.letterSpacing}
          min={-200}
          max={500}
          step={0.5}
          unit="px"
          onLive={(v) => setTracking(v, 'live')}
          onCommit={(v) => setTracking(v, 'commit')}
        />
      </div>
      <Field label="Color">
        <div className="type-row">
          <TextFillChip placement="left-start" />
          <span className="type-mono">{t.fill.type === 'solid' ? t.fill.color : 'Gradient'}</span>
        </div>
      </Field>
      <div className="type-row">
        <StyleToggles size="sm" />
        <span className="type-spacer" />
        <AlignButtons size="sm" />
      </div>
      <div className="type-row type-props-actions">
        <Button size="small" icon={Pencil} disabled={layer.locks.all} onClick={() => editTextLayer(layer.id, { selectAll: true })} title="Edit the text on the canvas">
          Edit
        </Button>
        <Button size="small" icon={Spline} onClick={openWarpDialog} title="Warp Text…">
          Warp
        </Button>
        <Button size="small" icon={PanelRight} onClick={() => useUI.getState().showPanel('character')} title="Open the Character panel">
          Character
        </Button>
      </div>
    </div>
  );
}
