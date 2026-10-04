/**
 * Crop tool (C): crop box over the document with 8 handles, ratio presets + W×H ratio fields,
 * darkened outside + rule-of-thirds overlay, snapping, arrow-key nudge. Enter / double-click /
 * ✓ applies (one history step); Esc / ✗ resets the box.
 */
import { ArrowRightLeft, Check, Crop, RotateCcw, X } from 'lucide-react';
import { create } from 'zustand';
import type { Point, Rect } from '../../core/types';
import type { ToolDef, ToolPointerEvent } from '../../registry';
import { viewport } from '../../editor/viewport';
import { activeSession, toolOptions, useToolOptions } from '../../state/editor';
import { toast } from '../../state/ui';
import { Button, Checkbox, IconButton, NumberField, Select } from '../../ui/controls';
import { BOX_HANDLES, HANDLE_FRAC, boxFromDrag, fitRatio, resizeBox, roundCropRect, type BoxHandle } from '../math/crop';
import { clearSmartGuides, collectSnapTargets, snapPoint, snapRect, type SnapTargets } from '../snap';
import { drawLabel, resizeCursorForAngle } from '../draw';
import { applyCrop } from '../cropApply';
import { Label, Sep, setToolOptionSafe } from '../options/common';
import { fmtPx } from '../state';
import '../viewport.css';

export type CropPreset = 'free' | 'original' | '1:1' | '16:9' | '4:3' | '9:16' | 'roblox-icon' | 'thumbnail' | 'custom';

export const CROP_DEFAULTS = {
  preset: 'free' as CropPreset,
  rw: 0,
  rh: 0,
  deletePixels: false,
  overlay: 'thirds' as 'thirds' | 'grid' | 'none',
};

const PRESETS: { value: CropPreset; label: string; w?: number; h?: number }[] = [
  { value: 'free', label: 'Ratio (free)' },
  { value: 'original', label: 'Original Ratio' },
  { value: '1:1', label: '1 : 1 (Square)', w: 1, h: 1 },
  { value: '16:9', label: '16 : 9', w: 16, h: 9 },
  { value: '4:3', label: '4 : 3', w: 4, h: 3 },
  { value: '9:16', label: '9 : 16 (Portrait)', w: 9, h: 16 },
  { value: 'roblox-icon', label: 'Roblox Icon 1:1 (512×512)', w: 512, h: 512 },
  { value: 'thumbnail', label: 'Roblox Thumbnail 16:9 (1920×1080)', w: 1920, h: 1080 },
  { value: 'custom', label: 'Custom W × H' },
];

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

interface CropState {
  box: Rect | null;
  docId: string | null;
  docW: number;
  docH: number;
}
export const useCropStore = create<CropState>()(() => ({ box: null, docId: null, docW: 0, docH: 0 }));

/** Current crop box for the active document (initialised to the whole canvas). */
function ensureBox(): Rect | null {
  const s = activeSession();
  if (!s) return null;
  const st = useCropStore.getState();
  if (st.box && st.docId === s.doc.id && st.docW === s.doc.width && st.docH === s.doc.height) return st.box;
  const box = initialBox();
  useCropStore.setState({ box, docId: s.doc.id, docW: s.doc.width, docH: s.doc.height });
  return box;
}

function initialBox(): Rect | null {
  const s = activeSession();
  if (!s) return null;
  const full = { x: 0, y: 0, width: s.doc.width, height: s.doc.height };
  const r = currentRatio();
  return r ? fitRatio(full, r) : full;
}

function setBox(box: Rect) {
  useCropStore.setState({ box });
  viewport.requestOverlay();
}

export function currentRatio(): number | null {
  const s = activeSession();
  const o = toolOptions('crop', CROP_DEFAULTS);
  if (o.preset === 'free') return null;
  if (o.preset === 'original') return s ? s.doc.width / s.doc.height : null;
  return o.rw > 0 && o.rh > 0 ? o.rw / o.rh : null;
}

/** Change the ratio preset and refit the box inside its current extent. */
export function setCropPreset(preset: CropPreset) {
  const p = PRESETS.find((x) => x.value === preset);
  setToolOptionSafe('crop', 'preset', preset);
  if (p?.w && p.h) {
    setToolOptionSafe('crop', 'rw', p.w);
    setToolOptionSafe('crop', 'rh', p.h);
  } else if (preset === 'original') {
    const s = activeSession();
    if (s) {
      setToolOptionSafe('crop', 'rw', s.doc.width);
      setToolOptionSafe('crop', 'rh', s.doc.height);
    }
  } else if (preset === 'custom') {
    const o = toolOptions('crop', CROP_DEFAULTS);
    if (!(o.rw > 0 && o.rh > 0)) {
      const b = ensureBox();
      setToolOptionSafe('crop', 'rw', Math.round(b?.width ?? 1));
      setToolOptionSafe('crop', 'rh', Math.round(b?.height ?? 1));
    }
  }
  refitBox();
}

function refitBox() {
  const box = ensureBox();
  const r = currentRatio();
  if (box && r) setBox(fitRatio(box, r));
}

export function resetCrop() {
  const box = initialBox();
  if (box) setBox(box);
}

export function commitCrop() {
  const box = ensureBox();
  const s = activeSession();
  if (!box || !s) {
    toast('Open a document to crop.', 'info');
    return;
  }
  const o = toolOptions('crop', CROP_DEFAULTS);
  const r = roundCropRect(box);
  if (applyCrop(r, { deletePixels: o.deletePixels })) {
    toast(`Cropped to ${r.width} × ${r.height} px`, 'success');
  }
  useCropStore.setState({ box: null, docId: null });
  ensureBox();
  viewport.requestOverlay();
}

/* ------------------------------------------------------------------ */
/* interaction                                                         */
/* ------------------------------------------------------------------ */

type Hit = { kind: 'handle'; handle: BoxHandle } | { kind: 'inside' } | { kind: 'outside' };

interface Drag {
  kind: 'new' | 'move' | 'handle';
  handle?: BoxHandle;
  start: Point;
  screen0: Point;
  box0: Rect;
  targets: SnapTargets | null;
  moved: boolean;
}
let drag: Drag | null = null;

function screenBox(box: Rect) {
  const p0 = viewport.docToScreen({ x: box.x, y: box.y });
  const p1 = viewport.docToScreen({ x: box.x + box.width, y: box.y + box.height });
  return { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
}

function hitTest(screen: Point, box: Rect): Hit {
  const b = screenBox(box);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  for (const hd of BOX_HANDLES) {
    const [fx, fy] = HANDLE_FRAC[hd];
    const isSide = hd.length === 1;
    if (isSide && (hd === 't' || hd === 'b' ? w : h) < 30) continue;
    const hx = b.x0 + fx * w;
    const hy = b.y0 + fy * h;
    if (Math.abs(screen.x - hx) <= 9 && Math.abs(screen.y - hy) <= 9) return { kind: 'handle', handle: hd };
  }
  const inX = screen.x >= b.x0 - 5 && screen.x <= b.x1 + 5;
  const inY = screen.y >= b.y0 - 5 && screen.y <= b.y1 + 5;
  if (inY && Math.abs(screen.x - b.x0) <= 5) return { kind: 'handle', handle: 'l' };
  if (inY && Math.abs(screen.x - b.x1) <= 5) return { kind: 'handle', handle: 'r' };
  if (inX && Math.abs(screen.y - b.y0) <= 5) return { kind: 'handle', handle: 't' };
  if (inX && Math.abs(screen.y - b.y1) <= 5) return { kind: 'handle', handle: 'b' };
  if (screen.x > b.x0 && screen.x < b.x1 && screen.y > b.y0 && screen.y < b.y1) return { kind: 'inside' };
  return { kind: 'outside' };
}

function cursorFor(hit: Hit): string {
  if (hit.kind === 'inside') return 'move';
  if (hit.kind === 'outside') return 'crosshair';
  const [fx, fy] = HANDLE_FRAC[hit.handle];
  return resizeCursorForAngle((Math.atan2(fy - 0.5, fx - 0.5) * 180) / Math.PI);
}

function onPointerDown(e: ToolPointerEvent) {
  if (e.button !== 0) return;
  const s = activeSession();
  const box = ensureBox();
  if (!s || !box) return;
  const hit = hitTest({ x: e.screenX, y: e.screenY }, box);
  drag = {
    kind: hit.kind === 'handle' ? 'handle' : hit.kind === 'inside' ? 'move' : 'new',
    handle: hit.kind === 'handle' ? hit.handle : undefined,
    start: { x: e.docX, y: e.docY },
    screen0: { x: e.screenX, y: e.screenY },
    box0: { ...box },
    targets: collectSnapTargets(s.doc),
    moved: false,
  };
}

function onPointerMove(e: ToolPointerEvent) {
  const d = drag;
  if (!d) return;
  if (!d.moved && Math.hypot(e.screenX - d.screen0.x, e.screenY - d.screen0.y) < 3) return;
  d.moved = true;
  let ratio = currentRatio();
  if (!ratio && e.shiftKey) ratio = d.kind === 'new' ? 1 : d.box0.width / Math.max(1e-6, d.box0.height);
  let q = { x: e.docX, y: e.docY };
  if (d.kind === 'move') {
    const r = { ...d.box0, x: d.box0.x + (q.x - d.start.x), y: d.box0.y + (q.y - d.start.y) };
    if (d.targets) {
      const sn = snapRect(r, { targets: d.targets });
      r.x += sn.dx;
      r.y += sn.dy;
    }
    setBox(r);
    return;
  }
  if (d.targets) {
    const axes = d.kind === 'handle' && d.handle ? { x: HANDLE_FRAC[d.handle][0] !== 0.5, y: HANDLE_FRAC[d.handle][1] !== 0.5 } : undefined;
    const sp = snapPoint(q, { targets: d.targets, axes, disabled: !!ratio && d.kind === 'handle' && d.handle?.length === 2 });
    q = { x: sp.x, y: sp.y };
  }
  if (d.kind === 'new') {
    const a = d.start;
    setBox(boxFromDrag(a, q, { ratio, fromCenter: e.altKey }));
  } else if (d.handle) {
    setBox(resizeBox(d.box0, d.handle, q, { ratio, fromCenter: e.altKey }));
  }
}

function onPointerUp() {
  const d = drag;
  drag = null;
  clearSmartGuides();
  if (!d) return;
  if (d.kind === 'new' && !d.moved) {
    // A click outside the box without dragging keeps the previous box.
    setBox(d.box0);
  }
  const box = useCropStore.getState().box;
  if (box && (box.width < 1 || box.height < 1)) setBox(d.box0);
  viewport.requestOverlay();
}

function onHover(e: ToolPointerEvent) {
  const box = ensureBox();
  if (!box) return;
  viewport.setCursor(cursorFor(hitTest({ x: e.screenX, y: e.screenY }, box)));
}

function onDoubleClick(e: ToolPointerEvent) {
  const box = ensureBox();
  if (box && hitTest({ x: e.screenX, y: e.screenY }, box).kind === 'inside') commitCrop();
}

function onKeyDown(e: KeyboardEvent): boolean {
  if (!activeSession()) return false;
  if (e.key === 'Enter') {
    commitCrop();
    return true;
  }
  if (e.key === 'Escape') {
    drag = null;
    resetCrop();
    return true;
  }
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const a = arrows[e.key];
  if (a && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const box = ensureBox();
    if (!box) return false;
    const k = e.shiftKey ? 10 : 1;
    setBox({ ...box, x: box.x + a[0] * k, y: box.y + a[1] * k });
    return true;
  }
  return false;
}

function renderOverlay(ctx: CanvasRenderingContext2D) {
  const box = ensureBox();
  if (!box) return;
  const size = viewport.getSize();
  const b = screenBox(box);
  const x0 = Math.round(b.x0);
  const y0 = Math.round(b.y0);
  const x1 = Math.round(b.x1);
  const y1 = Math.round(b.y1);
  const w = x1 - x0;
  const h = y1 - y0;
  ctx.save();
  // darken outside
  ctx.beginPath();
  ctx.rect(0, 0, size.width, size.height);
  ctx.rect(x0, y0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.58)';
  ctx.fill('evenodd');
  // overlay grid
  const o = toolOptions('crop', CROP_DEFAULTS);
  const showGrid = o.overlay !== 'none' && (o.overlay === 'thirds' || drag?.moved || o.overlay === 'grid');
  if (showGrid && w > 12 && h > 12) {
    ctx.beginPath();
    const n = o.overlay === 'grid' ? Math.max(2, Math.min(12, Math.round(Math.min(w, h) / 60))) : 3;
    for (let i = 1; i < n; i++) {
      const gx = Math.round(x0 + (w * i) / n) + 0.5;
      const gy = Math.round(y0 + (h * i) / n) + 0.5;
      ctx.moveTo(gx, y0);
      ctx.lineTo(gx, y1);
      ctx.moveTo(x0, gy);
      ctx.lineTo(x1, gy);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.stroke();
  }
  // border
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.strokeRect(x0 - 0.5, y0 - 0.5, w + 1, h + 1);
  ctx.strokeStyle = '#ffffff';
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
  // L-shaped corner handles + edge bars
  const L = Math.min(16, Math.max(6, Math.min(w, h) / 3));
  const T = 3;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 2;
  const corner = (cx: number, cy: number, sx: number, sy: number) => {
    ctx.fillRect(sx > 0 ? cx : cx - L, sy > 0 ? cy : cy - T, L, T);
    ctx.fillRect(sx > 0 ? cx : cx - T, sy > 0 ? cy : cy - L, T, L);
  };
  corner(x0 - T, y0 - T, 1, 1);
  corner(x1 + T, y0 - T, -1, 1);
  corner(x1 + T, y1 + T, -1, -1);
  corner(x0 - T, y1 + T, 1, -1);
  const mx = Math.round((x0 + x1) / 2);
  const my = Math.round((y0 + y1) / 2);
  if (w >= 30) {
    ctx.fillRect(mx - L / 2, y0 - T, L, T);
    ctx.fillRect(mx - L / 2, y1, L, T);
  }
  if (h >= 30) {
    ctx.fillRect(x0 - T, my - L / 2, T, L);
    ctx.fillRect(x1, my - L / 2, T, L);
  }
  ctx.restore();
  if (drag?.moved) {
    const r = roundCropRect(box);
    const at = viewport.docToScreen({ x: box.x + box.width, y: box.y + box.height });
    drawLabel(ctx, [`W: ${fmtPx(r.width)} px`, `H: ${fmtPx(r.height)} px`], at);
  }
}

export const cropTool: ToolDef = {
  id: 'crop',
  name: 'Crop Tool',
  shortcut: 'C',
  icon: Crop,
  group: 'crop',
  order: 50,
  cursor: 'crosshair',
  OptionsBar: CropOptions,
  defaultOptions: { ...CROP_DEFAULTS },
  onActivate() {
    useCropStore.setState({ box: null, docId: null });
    ensureBox();
    viewport.requestOverlay();
  },
  onDeactivate() {
    drag = null;
    clearSmartGuides();
    useCropStore.setState({ box: null, docId: null });
  },
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onHover,
  onDoubleClick,
  onKeyDown,
  renderOverlay,
};

/* ------------------------------------------------------------------ */
/* options bar                                                         */
/* ------------------------------------------------------------------ */

function CropOptions() {
  const o = useToolOptions('crop', CROP_DEFAULTS);
  const box = useCropStore((s) => s.box);
  const showFields = o.preset !== 'free';
  const setRatioField = (key: 'rw' | 'rh', v: number) => {
    setToolOptionSafe('crop', key, v);
    if (o.preset !== 'custom') setToolOptionSafe('crop', 'preset', 'custom');
    refitBox();
  };
  const r = box ? roundCropRect(box) : null;
  return (
    <div className="viewport-opts">
      <Select value={o.preset} width={200} options={PRESETS.map((p) => ({ value: p.value, label: p.label }))} onChange={(v) => setCropPreset(v)} />
      {showFields && (
        <>
          <NumberField value={o.rw} min={0.01} max={100000} step={0.01} width={64} title="Ratio width" onChange={(v) => setRatioField('rw', v)} />
          <IconButton
            icon={ArrowRightLeft}
            size="sm"
            title="Swap width and height"
            onClick={() => {
              setToolOptionSafe('crop', 'rw', o.rh);
              setToolOptionSafe('crop', 'rh', o.rw);
              if (o.preset !== 'custom' && o.preset !== 'original') setToolOptionSafe('crop', 'preset', 'custom');
              refitBox();
            }}
          />
          <NumberField value={o.rh} min={0.01} max={100000} step={0.01} width={64} title="Ratio height" onChange={(v) => setRatioField('rh', v)} />
          <Button size="small" variant="ghost" onClick={() => setCropPreset('free')} title="Clear the ratio">
            Clear
          </Button>
        </>
      )}
      <Sep />
      <Label>Overlay</Label>
      <Select
        value={o.overlay}
        width={112}
        options={[
          { value: 'thirds', label: 'Rule of Thirds' },
          { value: 'grid', label: 'Grid' },
          { value: 'none', label: 'None' },
        ]}
        onChange={(v) => {
          setToolOptionSafe('crop', 'overlay', v);
          viewport.requestOverlay();
        }}
      />
      <Checkbox
        checked={o.deletePixels}
        onChange={(v) => setToolOptionSafe('crop', 'deletePixels', v)}
        label="Delete Cropped Pixels"
        title="Trim pixel layers to the new canvas (otherwise hidden pixels are kept outside the canvas)"
      />
      {r && <span className="viewport-opts-hint">{`${r.width} × ${r.height} px`}</span>}
      <span className="viewport-opts-spacer" />
      <IconButton icon={RotateCcw} size="sm" iconSize={15} title="Reset crop box" onClick={resetCrop} />
      <IconButton icon={X} size="sm" iconSize={16} title="Cancel (Esc)" onClick={resetCrop} />
      <IconButton icon={Check} size="sm" iconSize={16} className="viewport-opts-commit" title="Commit crop (Enter)" onClick={commitCrop} />
    </div>
  );
}
