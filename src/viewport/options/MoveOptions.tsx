import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Check,
  FlipHorizontal2,
  FlipVertical2,
  Link2,
  Unlink,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Checkbox, IconButton, NumberField, Select } from '../../ui/controls';
import { setToolOptionSafe } from './common';
import { useToolOptions } from '../../state/editor';
import { useUI } from '../../state/ui';
import { alignLayers, distributeLayers } from '../tools/moveOps';
import { cancelTransform, commitTransform, useTransformStore } from '../transform/controller';
import '../viewport.css';

const DEFAULTS = { autoSelect: false, autoSelectTarget: 'layer' as 'layer' | 'group' };

export function MoveOptionsBar() {
  const session = useTransformStore((s) => s.session);
  if (session) return <TransformOptionsBar />;
  return <MoveOptions />;
}

function MoveOptions() {
  const o = useToolOptions('move', DEFAULTS);
  const showTc = useUI((s) => s.view.transformControls);
  const snap = useUI((s) => s.view.snap);
  const toggleView = useUI((s) => s.toggleView);
  return (
    <div className="viewport-opts">
      <Checkbox checked={o.autoSelect} onChange={(v) => setToolOptionSafe('move', 'autoSelect', v)} label="Auto-Select" title="Select the topmost layer under the cursor when clicking (hold Ctrl to toggle temporarily)" />
      <span className="viewport-opts-label">Auto-Select Target</span>
      <Select
        value={o.autoSelectTarget}
        width={78}
        options={[
          { value: 'layer', label: 'Layer' },
          { value: 'group', label: 'Group' },
        ]}
        onChange={(v) => setToolOptionSafe('move', 'autoSelectTarget', v)}
      />
      <Checkbox checked={showTc} onChange={(v) => toggleView('transformControls', v)} label="Show Transform Controls" />
      <Checkbox checked={snap} onChange={(v) => toggleView('snap', v)} label="Snap" title="Snap to canvas, guides and layers (View ▸ Snap)" />
      <span className="viewport-opts-sep" />
      <IconButton icon={AlignStartVertical} size="sm" iconSize={15} title="Align left edges" onClick={() => alignLayers('left')} />
      <IconButton icon={AlignCenterVertical} size="sm" iconSize={15} title="Align horizontal centers" onClick={() => alignLayers('hcenter')} />
      <IconButton icon={AlignEndVertical} size="sm" iconSize={15} title="Align right edges" onClick={() => alignLayers('right')} />
      <IconButton icon={AlignStartHorizontal} size="sm" iconSize={15} title="Align top edges" onClick={() => alignLayers('top')} />
      <IconButton icon={AlignCenterHorizontal} size="sm" iconSize={15} title="Align vertical centers" onClick={() => alignLayers('vcenter')} />
      <IconButton icon={AlignEndHorizontal} size="sm" iconSize={15} title="Align bottom edges" onClick={() => alignLayers('bottom')} />
      <span className="viewport-opts-sep" />
      <IconButton icon={AlignHorizontalDistributeCenter} size="sm" iconSize={15} title="Distribute horizontal centers (3+ layers)" onClick={() => distributeLayers('horizontal')} />
      <IconButton icon={AlignVerticalDistributeCenter} size="sm" iconSize={15} title="Distribute vertical centers (3+ layers)" onClick={() => distributeLayers('vertical')} />
    </div>
  );
}

function TransformOptionsBar() {
  const session = useTransformStore((s) => s.session);
  useTransformStore((s) => s.rev);
  const [linked, setLinked] = useState<boolean | null>(null);
  if (!session) return null;
  const t = session.frameTransform();
  const isLinked = linked ?? session.proportionalDefault;
  const singleLayer = session.kind === 'layers' && session.targets.length === 1;
  const pct = (v: number) => Math.round(v * 10000) / 100;
  return (
    <div className="viewport-opts">
      <span className="viewport-opts-title">{session.kind === 'selection' ? 'Transform Selection' : session.skewMode ? 'Skew' : 'Free Transform'}</span>
      <span className="viewport-opts-sep" />
      <NumberField
        scrubLabel="X"
        value={session.pivot.x}
        step={1}
        unit="px"
        width={68}
        title="Reference point X"
        onChange={(v) => session.setFields({ x: v })}
      />
      <NumberField
        scrubLabel="Y"
        value={session.pivot.y}
        step={1}
        unit="px"
        width={68}
        title="Reference point Y"
        onChange={(v) => session.setFields({ y: v })}
      />
      <span className="viewport-opts-sep" />
      <NumberField
        scrubLabel="W"
        value={pct(t.scaleX)}
        step={0.1}
        unit="%"
        width={64}
        title={singleLayer ? 'Width (% of the layer’s original size)' : 'Width (% of the size when the transform began)'}
        onChange={(v) => {
          const sx = v / 100;
          session.setFields(isLinked ? { sx, sy: (t.scaleY / (t.scaleX || 1)) * sx } : { sx });
        }}
      />
      <IconButton
        icon={isLinked ? Link2 : Unlink}
        size="sm"
        active={isLinked}
        title={isLinked ? 'Maintain aspect ratio (on)' : 'Maintain aspect ratio (off)'}
        onClick={() => {
          setLinked(!isLinked);
          session.proportionalDefault = !isLinked;
        }}
      />
      <NumberField
        scrubLabel="H"
        value={pct(t.scaleY)}
        step={0.1}
        unit="%"
        width={64}
        title="Height (%)"
        onChange={(v) => {
          const sy = v / 100;
          session.setFields(isLinked ? { sy, sx: (t.scaleX / (t.scaleY || 1)) * sy } : { sy });
        }}
      />
      <span className="viewport-opts-sep" />
      <NumberField scrubLabel="∠" value={Math.round(t.rotation * 100) / 100} step={0.1} unit="°" width={60} title="Rotation" onChange={(v) => session.setFields({ rotation: v })} />
      <NumberField scrubLabel="H°" value={Math.round((t.skewX ?? 0) * 100) / 100} step={0.1} unit="°" width={56} title="Horizontal skew" onChange={(v) => session.setFields({ skew: v })} />
      <span className="viewport-opts-sep" />
      <IconButton icon={FlipHorizontal2} size="sm" iconSize={15} title="Flip horizontal" onClick={() => session.flip(true)} />
      <IconButton icon={FlipVertical2} size="sm" iconSize={15} title="Flip vertical" onClick={() => session.flip(false)} />
      <span className="viewport-opts-spacer" />
      <span className="viewport-opts-hint">Shift: {session.proportionalDefault ? 'free' : 'proportional'} · Alt: from center · Ctrl+side: skew</span>
      <IconButton icon={X} size="sm" iconSize={16} title="Cancel transform (Esc)" onClick={() => cancelTransform()} />
      <IconButton icon={Check} size="sm" iconSize={16} className="viewport-opts-commit" title="Commit transform (Enter)" onClick={() => commitTransform()} />
    </div>
  );
}
