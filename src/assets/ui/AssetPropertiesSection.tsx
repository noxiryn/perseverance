/**
 * Properties ▸ Asset: re-edit a generated asset layer (params + seed). Edits preview live
 * (debounced, at reduced resolution while dragging) and create a single history step.
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
import { assetIdOfLayer, renderAssetBitmap } from '../place';
import { blendLabel } from './blend';
import '../assets.css';

/** Preview resolution while scrubbing (full resolution on commit). */
const PREVIEW_SCALE = 0.5;

export function AssetPropertiesSection({ layerId }: { layerId: ID }) {
  const layer = useEditor((s) => {
    const sess = s.activeDocId ? s.sessions[s.activeDocId] : null;
    const l = sess?.doc.layers[layerId];
    return l && l.type === 'raster' ? l : null;
  });
  const assetId = assetIdOfLayer(layer);
  const def = assetId ? assets.get(assetId) : undefined;
  const values = useMemo(() => (def && layer ? resolveParams(def, layer.generator?.params as ParamValues | undefined) : {}), [def, layer]);
  // what the controls show while a (debounced) preview is pending
  const [draft, setDraft] = useState<ParamValues | null>(null);
  useEffect(() => setDraft(null), [layerId]);

  // live preview scheduling: latest params win; one render in flight at a time
  const pending = useRef<ParamValues | null>(null);
  const timer = useRef(0);
  const dirty = useRef(false);

  const apply = useCallback(
    (params: ParamValues, final: boolean) => {
      const st = useEditor.getState();
      const sess = st.activeDocId ? st.sessions[st.activeDocId] : null;
      const l = sess?.doc.layers[layerId];
      if (!def || !assetId || !l || l.type !== 'raster') return;
      let canvas: HTMLCanvasElement | null = null;
      try {
        canvas = renderAssetBitmap(assetId, params, l.width, l.height, final ? 1 : PREVIEW_SCALE);
      } catch (err) {
        console.error('[assets] regenerate failed', err);
        toast(`Could not regenerate “${def.name}”`, 'error');
        return;
      }
      if (!canvas) return;
      const bitmapId = bitmaps.add(canvas);
      const p = resolveParams(def, params);
      const recipe = (d: Document) => {
        const dl = d.layers[layerId];
        if (!dl || dl.type !== 'raster') return;
        dl.bitmapId = bitmapId;
        dl.generator = { kind: `asset:${assetId}`, params: p };
      };
      if (final) {
        st.commit('Edit Asset', recipe);
        dirty.current = false;
      } else {
        st.preview(recipe);
        dirty.current = true;
      }
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
        if (p) apply(p, false);
      }, 90);
    },
    [apply],
  );

  const commit = useCallback(
    (params: ParamValues) => {
      window.clearTimeout(timer.current);
      timer.current = 0;
      pending.current = null;
      setDraft(null);
      apply(params, true);
    },
    [apply],
  );

  // leaving mid-preview: settle the preview into a real history step
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (dirty.current) {
        const st = useEditor.getState();
        if (st.activeDocId) st.commit('Edit Asset');
        dirty.current = false;
      }
    },
    [layerId],
  );

  if (!layer || !assetId) return null;
  if (!def)
    return <div className="ui-label">The asset “{assetId}” used by this layer is not available in this version.</div>;
  if (!def.params.length) return <div className="ui-label">“{def.name}” has no adjustable settings.</div>;
  const hasSeed = def.params.some((p) => p.type === 'seed');

  return (
    <div className="assets-props">
      <div className="assets-props-head">
        <div className="assets-props-name" title={`${def.name} · ${def.category}`}>
          {def.name}
          <small>{blendLabel(layer.blendMode)}</small>
        </div>
        {hasSeed && (
          <IconButton icon={Dices} size="sm" title="New random seed" onClick={() => commit({ ...values, seed: Math.floor(Math.random() * 999999) })} />
        )}
        <IconButton icon={RotateCcw} size="sm" title="Reset to defaults" onClick={() => commit(resolveParams(def, {}))} />
      </div>
      <ParamEditor
        defs={def.params}
        values={draft ?? values}
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

export function appliesToAssetLayer(layerId: ID): boolean {
  const st = useEditor.getState();
  const l = st.activeDocId ? st.sessions[st.activeDocId]?.doc.layers[layerId] : undefined;
  const id = assetIdOfLayer(l);
  return !!id && !!assets.get(id);
}
