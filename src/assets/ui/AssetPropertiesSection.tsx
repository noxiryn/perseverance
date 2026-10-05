/**
 * Properties ▸ Asset: re-edit a generated asset layer (params + seed). While a control is being
 * dragged the layer previews live at reduced resolution (throttled, drawn into one reusable
 * preview bitmap so memory stays flat); releasing the control regenerates at full resolution
 * through `regenerateAssetLayer`, which lands as a single history step.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dices, RotateCcw } from 'lucide-react';
import type { Document, ID, ParamValues } from '../../core/types';
import { assets } from '../../registry';
import { bitmaps } from '../../core/bitmaps';
import { resolveParams } from '../../filters/engine';
import { IconButton, ParamEditor } from '../../ui/controls';
import { useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { assetIdOfLayer, regenerateAssetLayer } from '../place';
import { blendLabel } from './blend';
import '../assets.css';

/** Preview resolution while scrubbing (full resolution on commit). */
const PREVIEW_SCALE = 0.5;
/** Minimum delay between two live previews (ms). */
const PREVIEW_INTERVAL = 90;

function liveLayer(layerId: ID) {
  const st = useEditor.getState();
  const sess = st.activeDocId ? st.sessions[st.activeDocId] : null;
  const l = sess?.doc.layers[layerId];
  return l && l.type === 'raster' ? l : null;
}

export function AssetPropertiesSection({ layerId }: { layerId: ID }) {
  const layer = useEditor((s) => {
    const sess = s.activeDocId ? s.sessions[s.activeDocId] : null;
    const l = sess?.doc.layers[layerId];
    return l && l.type === 'raster' ? l : null;
  });
  const assetId = assetIdOfLayer(layer);
  const def = assetId ? assets.get(assetId) : undefined;
  const values = useMemo(() => (def && layer ? resolveParams(def, layer.generator?.params as ParamValues | undefined) : {}), [def, layer]);
  // what the controls show while a live preview is pending
  const [draft, setDraft] = useState<ParamValues | null>(null);

  const pending = useRef<ParamValues | null>(null);
  /** params of the last live preview that has not been committed yet */
  const previewed = useRef<ParamValues | null>(null);
  const timer = useRef(0);
  const preview = useRef<{ id: ID; w: number; h: number } | null>(null);

  /** Render a reduced-resolution preview into the reusable preview bitmap. */
  const renderPreview = useCallback(
    (params: ParamValues) => {
      const l = liveLayer(layerId);
      if (!def || !assetId || !l) return;
      const p = resolveParams(def, params);
      let lo: HTMLCanvasElement;
      try {
        lo = def.generate(p, { width: Math.max(1, Math.round(l.width * PREVIEW_SCALE)), height: Math.max(1, Math.round(l.height * PREVIEW_SCALE)) });
      } catch (err) {
        console.error('[assets] preview failed', err);
        return;
      }
      let pv = preview.current;
      if (!pv || pv.w !== l.width || pv.h !== l.height || !bitmaps.has(pv.id)) {
        pv = { id: bitmaps.create(l.width, l.height), w: l.width, h: l.height };
        preview.current = pv;
      }
      const canvas = bitmaps.get(pv.id);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(lo, 0, 0, canvas.width, canvas.height);
      bitmaps.touch(pv.id);
      const id = pv.id;
      useEditor.getState().preview((d: Document) => {
        const dl = d.layers[layerId];
        if (!dl || dl.type !== 'raster') return;
        dl.bitmapId = id;
        dl.generator = { kind: `asset:${assetId}`, params: p };
      });
      previewed.current = params;
      viewport.requestRender();
    },
    [def, assetId, layerId],
  );

  const schedulePreview = useCallback(
    (params: ParamValues) => {
      pending.current = params;
      if (timer.current) return;
      timer.current = window.setTimeout(() => {
        timer.current = 0;
        const p = pending.current;
        pending.current = null;
        if (p) renderPreview(p);
      }, PREVIEW_INTERVAL);
    },
    [renderPreview],
  );

  /** Full-resolution regenerate + single history step. */
  const commit = useCallback(
    (params: ParamValues) => {
      window.clearTimeout(timer.current);
      timer.current = 0;
      pending.current = null;
      previewed.current = null;
      setDraft(null);
      if (!liveLayer(layerId)) return;
      regenerateAssetLayer(layerId, params);
    },
    [layerId],
  );

  // switching layers / unmounting mid-drag: settle the preview at full resolution
  useEffect(() => {
    setDraft(null);
    return () => {
      window.clearTimeout(timer.current);
      timer.current = 0;
      const last = pending.current ?? previewed.current;
      pending.current = null;
      previewed.current = null;
      preview.current = null;
      if (last && liveLayer(layerId)) regenerateAssetLayer(layerId, last);
    };
  }, [layerId]);

  if (!layer || !assetId) return null;
  if (!def) return <div className="ui-label">The asset “{assetId}” used by this layer is not available in this version.</div>;
  if (!def.params.length) return <div className="ui-label">“{def.name}” has no adjustable settings.</div>;
  const hasSeed = def.params.some((p) => p.type === 'seed');
  const shown = draft ?? values;

  return (
    <div className="assets-props">
      <div className="assets-props-head">
        <div className="assets-props-name" title={`${def.name} · ${def.category}`}>
          {def.name}
          <small>{blendLabel(layer.blendMode)}</small>
        </div>
        {hasSeed && (
          <IconButton
            icon={Dices}
            size="sm"
            title="New random seed"
            onClick={() => commit({ ...shown, seed: Math.floor(Math.random() * 999_999) })}
          />
        )}
        <IconButton
          icon={RotateCcw}
          size="sm"
          title="Reset to defaults"
          onClick={() => {
            commit(resolveParams(def, {}));
            toast(`Reset “${def.name}” to its defaults`, 'info');
          }}
        />
      </div>
      <ParamEditor
        defs={def.params}
        values={shown}
        compact
        onChange={(_k, _v, all) => {
          setDraft(all);
          schedulePreview(all);
        }}
        onCommit={(_k, _v, all) => commit(all)}
      />
    </div>
  );
}

/** The section shows for raster layers produced by a registered, adjustable library asset. */
export function appliesToAssetLayer(layerId: ID): boolean {
  const st = useEditor.getState();
  const l = st.activeDocId ? st.sessions[st.activeDocId]?.doc.layers[layerId] : undefined;
  const id = assetIdOfLayer(l);
  if (!id) return false;
  const def = assets.get(id);
  return !!def && def.params.length > 0;
}
