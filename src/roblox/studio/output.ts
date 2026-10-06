/** Render the studio view and add it to the document as a raster layer (or replace a re-edited one). */
import type { GeneratorSource, RasterLayer } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctx2d, opaqueBounds } from '../../core/canvas';
import { makeRasterLayer, nextLayerName } from '../../core/document';
import { activeDoc, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { newTransparentDocument } from '../util';
import { isPlaceholder, replaceLayerContents } from '../character/replace';
import type { Document, Layer } from '../../core/types';

/** The active layer when it is a template placeholder (renders replace it), else null. */
export function activePlaceholder(doc: Document): Layer | null {
  const st = useEditor.getState();
  const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
  if (!s || s.doc.id !== doc.id || !s.activeLayerId) return null;
  const l = doc.layers[s.activeLayerId];
  return l && isPlaceholder(l) ? l : null;
}
import { freshTransform, outputFrameSize, padCrop, readPlacement, reeditTransform, type Placement } from './placement';
import type { StudioScene } from './scene';
import type { StudioOutput } from './types';

export interface CommitRenderOptions {
  output: StudioOutput;
  /** Generator kind ('rig' for Pose Studio, 'model' for imports). */
  kind: string;
  /** JSON params stored on the layer (placement is added automatically). */
  params: Record<string, unknown>;
  name: string;
  /** Re-edit: replace this layer's pixels instead of adding a new layer. */
  replaceLayerId?: string | null;
  newDocName?: string;
}

/** Frame size the render will use for the active (or a new) document. */
export function frameSizeFor(output: StudioOutput): { width: number; height: number } {
  const doc = activeDoc();
  return outputFrameSize(output.size, doc?.width ?? null, doc?.height ?? null);
}

/** Whether a render's visible pixels reach the bottom edge of its frame (the figure is cut there). */
export function rendersCutOff(opaque: { y: number; height: number }, frameH: number): boolean {
  return opaque.y + opaque.height >= frameH - 1;
}

export function commitRender(scene: StudioScene, opts: CommitRenderOptions): boolean {
  let doc = activeDoc();
  const target = opts.replaceLayerId ? doc?.layers[opts.replaceLayerId] : undefined;
  if (target && (target.locks.all || target.locks.pixels)) {
    toast(`“${target.name}” is locked — unlock its pixels to update the render.`, 'warning', 4000);
    return false;
  }
  const frame = outputFrameSize(opts.output.size, doc?.width ?? null, doc?.height ?? null);
  const full = scene.renderToCanvas(frame.width, frame.height);
  const b = opaqueBounds(full, 2);
  if (!b) {
    toast('Nothing visible in the render — adjust the camera or framing.', 'warning');
    return false;
  }
  const pad = Math.max(8, Math.round(Math.max(frame.width, frame.height) * 0.015));
  const crop = padCrop(b, frame.width, frame.height, pad);
  const cropped = createCanvas(crop.width, crop.height);
  ctx2d(cropped).drawImage(full, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const placement: Placement = { frameW: frame.width, frameH: frame.height, crop };
  const generator: GeneratorSource = { kind: opts.kind, params: { ...opts.params, placement } as Record<string, unknown> };

  if (!doc) doc = newTransparentDocument(opts.newDocName ?? 'Roblox Character', frame.width, frame.height);
  const st = useEditor.getState();
  const old = opts.replaceLayerId ? doc.layers[opts.replaceLayerId] : undefined;
  const bitmapId = bitmaps.add(cropped);
  const what = opts.kind === 'model' ? 'Model Render' : 'Pose Studio Render';

  if (old && old.type === 'raster') {
    const oldPlacement = readPlacement((old.generator?.params as Record<string, unknown> | undefined)?.placement);
    const transform = oldPlacement ? reeditTransform(oldPlacement, old.transform, placement) : freshTransform(placement, doc.width, doc.height);
    st.commit(
      `Edit ${what}`,
      (d) => {
        const l = d.layers[old.id] as RasterLayer | undefined;
        if (!l) return;
        l.bitmapId = bitmapId;
        l.width = crop.width;
        l.height = crop.height;
        l.transform = transform;
        l.generator = generator;
      },
      { activeLayerId: old.id },
    );
    toast(`Updated “${old.name}” (${opts.kind === 'model' ? 'model render' : 'Pose Studio render'})`, 'success');
  } else if (!opts.replaceLayerId && isPlaceholder(activePlaceholder(doc))) {
    // A template's placeholder is selected: the render takes its place, size and styling.
    const ph = activePlaceholder(doc)!;
    replaceLayerContents(ph.id, cropped, {
      name: nextLayerName(doc, opts.name),
      keepResolution: true,
      generator,
      meta: { roblox: { kind: 'character', source: opts.kind } },
      label: `Replace Character (${what})`,
      // Head / waist-up framings (or a close camera) cut the figure at the frame's bottom edge:
      // it then fills the placeholder's on-canvas part with the cut on the canvas edge (fit.ts).
      cutOff: rendersCutOff(b, frame.height),
    });
  } else {
    const layer = makeRasterLayer({
      name: nextLayerName(doc, opts.name),
      bitmapId,
      width: crop.width,
      height: crop.height,
      transform: freshTransform(placement, doc.width, doc.height),
    });
    layer.generator = generator;
    layer.meta = { roblox: { kind: 'character', source: opts.kind } };
    st.addLayer(layer, { label: `Add ${what}` });
    toast(`Added “${layer.name}”`, 'success');
  }
  viewport.requestRender();
  return true;
}
