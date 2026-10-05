/**
 * Eyedropper (I): click/drag samples the image into the primary color (Alt → secondary).
 * Sample size 1/3/5/11 px, current layer or all layers. A Photoshop-style loupe ring shows the
 * new color (top half) vs the previous color (bottom half) while sampling.
 */
import { Pipette } from 'lucide-react';
import type { ToolDef, ToolPointerEvent } from '../../registry';
import { createCanvas, ctxRead } from '../../core/canvas';
import { viewport } from '../../editor/viewport';
import { renderDocument } from '../../render/compositor';
import { layerPixels } from '../selectOps';
import { activeSession, toolOptions, useEditor, useToolOptions } from '../../state/editor';
import { Checkbox, Select } from '../../ui/controls';
import { CURSORS } from '../draw';
import { Label, Sep, setToolOptionSafe } from '../options/common';
import { toastOnce } from '../state';
import { averageColor, rgbToHex } from '../math/color';
import '../viewport.css';

export const EYEDROPPER_DEFAULTS = {
  sampleSize: 1 as number,
  sample: 'all' as 'all' | 'current',
  showRing: true,
};

interface Sampling {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  secondary: boolean;
  previous: string;
  current: string | null;
  screen: { x: number; y: number };
}

let sampling: Sampling | null = null;

/** Rasterize the sampling source once per gesture into a CPU-readable buffer. */
function sourceData(): { data: Uint8ClampedArray; width: number; height: number } | null {
  const s = activeSession();
  if (!s) return null;
  const doc = s.doc;
  const o = toolOptions('eyedropper', EYEDROPPER_DEFAULTS);
  let src: HTMLCanvasElement | null = null;
  try {
    if (o.sample === 'current') {
      if (!s.activeLayerId) {
        toastOnce('Select a layer to sample, or set Sample to “All Layers”.', 'info');
        return null;
      }
      // The layer's own (masked) pixels, without effects such as drop shadows or strokes.
      src = layerPixels(doc, s.activeLayerId, { mask: true });
      if (!src) {
        toastOnce('The current layer has no pixels to sample.', 'info');
        return null;
      }
    } else src = renderDocument(doc);
  } catch (err) {
    console.error('[eyedropper] sampling failed', err);
    toastOnce('Could not sample the image.', 'error');
    return null;
  }
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctxRead(c);
  ctx.drawImage(src, 0, 0, doc.width, doc.height);
  return { data: ctx.getImageData(0, 0, doc.width, doc.height).data, width: doc.width, height: doc.height };
}

function sampleAt(e: ToolPointerEvent) {
  const sm = sampling;
  if (!sm) return;
  sm.screen = { x: e.screenX, y: e.screenY };
  const size = Math.max(1, toolOptions('eyedropper', EYEDROPPER_DEFAULTS).sampleSize);
  const rgb = averageColor(sm.data, sm.width, sm.height, Math.floor(e.docX), Math.floor(e.docY), size);
  if (rgb) {
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    sm.current = hex;
    const st = useEditor.getState();
    if (sm.secondary) st.setSecondaryColor(hex);
    else st.setPrimaryColor(hex);
  }
  viewport.requestOverlay();
}

export const eyedropperTool: ToolDef = {
  id: 'eyedropper',
  name: 'Eyedropper Tool',
  shortcut: 'I',
  icon: Pipette,
  group: 'eyedropper',
  order: 60,
  cursor: CURSORS.eyedropper,
  OptionsBar: EyedropperOptions,
  defaultOptions: { ...EYEDROPPER_DEFAULTS },
  onPointerDown(e) {
    if (e.button !== 0) return;
    const src = sourceData();
    if (!src) return;
    const st = useEditor.getState();
    // When the eyedropper is held temporarily (Alt with a paint tool) Alt does not mean "secondary".
    const temporary = st.previousTool !== null;
    const secondary = e.altKey && !temporary;
    sampling = {
      ...src,
      secondary,
      previous: secondary ? st.secondaryColor : st.primaryColor,
      current: null,
      screen: { x: e.screenX, y: e.screenY },
    };
    sampleAt(e);
  },
  onPointerMove(e) {
    if (sampling) sampleAt(e);
  },
  onPointerUp() {
    const sm = sampling;
    sampling = null;
    viewport.requestOverlay();
    if (sm?.current) useEditor.getState().pushRecentColor(sm.current);
  },
  onDeactivate() {
    sampling = null;
  },
  renderOverlay(ctx) {
    const sm = sampling;
    if (!sm || !toolOptions('eyedropper', EYEDROPPER_DEFAULTS).showRing) return;
    drawLoupe(ctx, sm.screen.x, sm.screen.y, sm.current ?? sm.previous, sm.previous);
  },
};

/** Photoshop-like sampling ring: new color on top, previous color at the bottom. */
export function drawLoupe(ctx: CanvasRenderingContext2D, x: number, y: number, next: string, prev: string) {
  const R = 56;
  const r = 38;
  ctx.save();
  // Gray frame ring (annulus — the center stays clear so the sampled spot remains visible).
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(x, y, R + 2, 0, Math.PI * 2);
  ctx.arc(x, y, r - 2, 0, Math.PI * 2, true);
  ctx.fillStyle = '#5c5c5c';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  const half = (start: number, color: string) => {
    ctx.beginPath();
    ctx.arc(x, y, R, start, start + Math.PI);
    ctx.arc(x, y, r, start + Math.PI, start, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  half(Math.PI, next); // top half
  half(0, prev); // bottom half
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#8a8a8a';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r - 1, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.stroke();
  ctx.restore();
}

function EyedropperOptions() {
  const o = useToolOptions('eyedropper', EYEDROPPER_DEFAULTS);
  return (
    <div className="viewport-opts">
      <Label>Sample Size</Label>
      <Select
        value={String(o.sampleSize)}
        width={128}
        options={[
          { value: '1', label: 'Point Sample' },
          { value: '3', label: '3 by 3 Average' },
          { value: '5', label: '5 by 5 Average' },
          { value: '11', label: '11 by 11 Average' },
        ]}
        onChange={(v) => setToolOptionSafe('eyedropper', 'sampleSize', Number(v))}
      />
      <Label>Sample</Label>
      <Select
        value={o.sample}
        width={112}
        options={[
          { value: 'all', label: 'All Layers' },
          { value: 'current', label: 'Current Layer' },
        ]}
        onChange={(v) => setToolOptionSafe('eyedropper', 'sample', v)}
      />
      <Sep />
      <Checkbox checked={o.showRing} onChange={(v) => setToolOptionSafe('eyedropper', 'showRing', v)} label="Show Sampling Ring" />
      <Sep />
      <span className="viewport-opts-hint">Click or drag to pick the foreground color · Alt picks the background color</span>
    </div>
  );
}
