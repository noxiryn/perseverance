/**
 * "Asset settings": live preview + ParamEditor + blend/opacity for the selected library asset.
 * Used by the Libraries panel drawer and the Place Asset dialog.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Dices, ImagePlus, RotateCcw, X } from 'lucide-react';
import type { ParamValues } from '../../core/types';
import type { AssetDef } from '../../registry';
import { resolveParams } from '../../filters/engine';
import { Button, Field, IconButton, ParamEditor, Select, Slider } from '../../ui/controls';
import { useActiveDoc } from '../../state/editor';
import { assetMeta } from '../lib/params';
import { loadAssetFonts } from '../lib/fonts';
import { renderPreview } from '../lib/thumbs';
import { placeAsset } from '../place';
import { BLEND_OPTIONS } from './blend';
import { useLibrary } from './store';

/** Live preview canvas, re-rendered (debounced) when params change. */
export function LivePreview({ def, params, max = 260 }: { def: AssetDef; params: ParamValues; max?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(true);
  const doc = useActiveDoc();
  const aspect = doc ? doc.width / doc.height : 16 / 9;
  useEffect(() => {
    let alive = true;
    setBusy(true);
    const t = window.setTimeout(
      async () => {
        if (assetMeta.get(def.id)?.fonts) await loadAssetFonts();
        if (!alive) return;
        const c = renderPreview(def, params, max, 1.6, aspect);
        const el = host.current;
        if (!alive || !el) return;
        el.querySelector('canvas')?.remove();
        el.prepend(c);
        setBusy(false);
      },
      host.current?.querySelector('canvas') ? 160 : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [def, params, max, aspect]);
  return <div ref={host} className={`assets-preview${busy ? ' busy' : ''}`} />;
}

export function AssetSettings({
  def,
  onClose,
  onPlaced,
  compactFooter,
  backButton,
}: {
  def: AssetDef;
  onClose?: () => void;
  onPlaced?: () => void;
  compactFooter?: boolean;
  /** Show a "back to the library" chevron instead of the close cross (full-panel overlay mode). */
  backButton?: boolean;
}) {
  const st = useLibrary((s) => s.settings[def.id]);
  const setParams = useLibrary((s) => s.setParams);
  const setLayerOpts = useLibrary((s) => s.setLayerOpts);
  const reset = useLibrary((s) => s.reset);
  const doc = useActiveDoc();
  const values = useMemo(() => resolveParams(def, st?.params), [def, st?.params]);
  const blend = st?.blendMode ?? def.defaultBlendMode ?? 'normal';
  const opacity = st?.opacity ?? def.defaultOpacity ?? 1;
  const hasSeed = def.params.some((p) => p.type === 'seed');

  const place = () => {
    const id = placeAsset(def.id, values, { blendMode: blend, opacity });
    if (id) onPlaced?.();
  };

  return (
    <>
      <div className="assets-drawer-head">
        {backButton && onClose && <IconButton icon={ChevronLeft} size="sm" title="Back to the library" onClick={onClose} />}
        <div className="assets-drawer-title">
          {def.name}
          <span className="assets-drawer-sub">{def.sizing === 'document' ? 'Canvas-size' : `${def.sizing.width}×${def.sizing.height}`}</span>
        </div>
        {hasSeed && (
          <IconButton
            icon={Dices}
            size="sm"
            title="Randomize seed"
            onClick={() => setParams(def.id, { ...values, seed: Math.floor(Math.random() * 999999) })}
          />
        )}
        <IconButton icon={RotateCcw} size="sm" title="Reset to defaults" onClick={() => reset(def.id)} />
        {onClose && !backButton && <IconButton icon={X} size="sm" title="Close" onClick={onClose} />}
      </div>
      <div className="assets-drawer-body">
        <LivePreview def={def} params={values} />
        {def.params.length > 0 ? (
          <ParamEditor
            defs={def.params}
            values={values}
            compact
            onChange={(_k, _v, all) => setParams(def.id, all)}
            onCommit={(_k, _v, all) => setParams(def.id, all)}
          />
        ) : (
          <div className="ui-label">This asset has no settings.</div>
        )}
        <div className="assets-sep" />
        <Field label="Blend">
          <Select value={blend} options={BLEND_OPTIONS} width="100%" onChange={(b) => setLayerOpts(def.id, { blendMode: b })} />
        </Field>
        <Field label="Opacity">
          <Slider
            value={opacity}
            min={0}
            max={1}
            step={0.01}
            displayScale={100}
            unit="%"
            onChange={(v) => setLayerOpts(def.id, { opacity: v })}
          />
        </Field>
      </div>
      <div className="assets-drawer-foot">
        {!compactFooter && onClose && (
          <Button size="small" onClick={onClose}>
            Close
          </Button>
        )}
        <Button variant="primary" icon={ImagePlus} disabled={!doc} title={doc ? 'Add as a new layer' : 'Open a document first'} onClick={place}>
          Place
        </Button>
      </div>
    </>
  );
}
