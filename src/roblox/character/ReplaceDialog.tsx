/**
 * Replace Character / Replace Contents dialog: pick an image file, use the clipboard image or
 * drop a file on the dialog; the image replaces the target layer's pixels (see replace.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardPaste, ImageUp } from 'lucide-react';
import { Button, Checkbox, Dialog } from '../../ui/controls';
import { activeDoc } from '../../state/editor';
import { openDialog, toast } from '../../state/ui';
import { openFiles } from '../../platform';
import { bitmaps } from '../../core/bitmaps';
import { blobToCanvas } from '../../core/canvas';
import { readClipboardImage } from '../../io/clipboard';
import type { RasterLayer } from '../../core/types';
import '../roblox.css';
import { IMAGE_FILE_EXTS, decodeImageFile, imageBaseName, isCharacterLayer, isPlaceholder, isReplaceableImage, replaceLayerContents } from './replace';

const PREF_KEY = 'perseverance.replace.cutout';

/** Remembered "remove the background automatically" choice (default on). */
export function autoCutoutPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAutoCutoutPref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable — keep the default */
  }
}

export interface ReplaceDialogProps extends Record<string, unknown> {
  layerId: string;
  /** 'character' → Roblox ▸ Replace Character wording. */
  mode: 'character' | 'contents';
}

type Source = { canvas: HTMLCanvasElement; name: string } | null;

function LayerThumb({ layer }: { layer: RasterLayer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const src = bitmaps.tryGet(layer.bitmapId);
    if (!c || !src) return;
    const k = Math.min(64 / src.width, 64 / src.height, 1);
    c.width = Math.max(1, Math.round(src.width * k));
    c.height = Math.max(1, Math.round(src.height * k));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    if (layer.transform.scaleX < 0) {
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(src, 0, 0, c.width, c.height);
  }, [layer]);
  return <canvas ref={ref} className="roblox-replace-thumb" />;
}

export function ReplaceDialog({ close, layerId, mode }: ReplaceDialogProps & { close: (r?: unknown) => void }) {
  const [layer] = useState(() => activeDoc()?.layers[layerId] as RasterLayer | undefined);
  const [cutout, setCutout] = useState(autoCutoutPref);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const doc = activeDoc();
  const character = mode === 'character' || isCharacterLayer(doc, layer);
  const title = mode === 'character' ? 'Replace Character' : 'Replace Contents';

  const run = useCallback(
    async (get: () => Promise<Source>) => {
      if (busy) return;
      setBusy(true);
      try {
        const src = await get();
        if (!src) return;
        setAutoCutoutPref(cutout);
        // Let the busy state paint before the (synchronous) cut-out and resampling.
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        if (replaceLayerContents(layerId, src.canvas, { name: src.name, cutout })) close(true);
      } catch (e) {
        console.error('[replace] failed', e);
        toast(`Could not use that image: ${(e as Error)?.message ?? e}`, 'error', 4000);
      } finally {
        setBusy(false);
      }
    },
    [busy, cutout, layerId, close],
  );

  const pickFile = () =>
    run(async () => {
      const [file] = await openFiles({ title: 'Choose an image', filters: [{ name: 'Images', extensions: IMAGE_FILE_EXTS }] });
      if (!file) return null;
      return { canvas: await decodeImageFile(file), name: imageBaseName(file.name) };
    });

  const fromClipboard = () =>
    run(async () => {
      const canvas = await readClipboardImage();
      if (!canvas) {
        toast('The clipboard has no image — copy your render first (or choose a file).', 'info', 3600);
        return null;
      }
      return { canvas, name: '' };
    });

  const onDrop = (e: React.DragEvent) => {
    // preventDefault also tells the window-level drop handler that the drop is taken care of.
    e.preventDefault();
    setDragOver(false);
    const file = Array.from(e.dataTransfer.files).find((f) => isReplaceableImage(f.name, f.type));
    if (!file) {
      toast('Drop an image file (PNG, JPEG, WebP, GIF or BMP).', 'warning');
      return;
    }
    void run(async () => ({ canvas: await blobToCanvas(file), name: imageBaseName(file.name) }));
  };

  if (!layer) {
    return (
      <Dialog title={title} onClose={() => close()} footer={<Button onClick={() => close()}>Close</Button>}>
        <div className="ui-empty">The layer is no longer available.</div>
      </Dialog>
    );
  }

  const kept: string[] = [];
  if (layer.filters.length) kept.push(`${layer.filters.length} smart filter${layer.filters.length === 1 ? '' : 's'}`);
  if (layer.effects.length) kept.push(`${layer.effects.length} layer effect${layer.effects.length === 1 ? '' : 's'}`);
  if (layer.mask) kept.push('its mask');

  return (
    <Dialog title={title} width={460} onClose={() => close()} footer={<Button onClick={() => close()}>Cancel</Button>}>
      <div
        className={`roblox-replace${dragOver ? ' drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="roblox-replace-target">
          <LayerThumb layer={layer} />
          <div>
            <div className="roblox-replace-name" title={layer.name}>
              {layer.name}
            </div>
            <div className="roblox-hint">
              {isPlaceholder(layer) ? 'Template placeholder — becomes your character.' : character ? 'Character layer' : 'Pixel layer'} · {Math.round(layer.width * Math.abs(layer.transform.scaleX))}×
              {Math.round(layer.height * Math.abs(layer.transform.scaleY))} px on the canvas
            </div>
          </div>
        </div>
        <div className="roblox-hint">
          Your image is fitted into this layer’s box (aspect kept{character ? ', feet on the same spot' : ', centered'}){layer.transform.scaleX < 0 ? ', mirrored like it' : ''}
          {kept.length ? ` and keeps ${kept.length > 1 ? `${kept.slice(0, -1).join(', ')} and ${kept[kept.length - 1]}` : kept[0]}` : ''}. Undo with Ctrl+Z.
        </div>
        <Checkbox
          checked={cutout}
          onChange={setCutout}
          label="Remove the background automatically (when the image has one)"
          title="Skipped when the automatic cut-out looks unreliable for the image (busy background, subject colors close to the background) — then use Roblox ▸ Remove Background… with its preview."
        />
        <div className="roblox-replace-actions">
          <Button variant="primary" icon={ImageUp} disabled={busy} onClick={() => void pickFile()}>
            Choose Image…
          </Button>
          <Button icon={ClipboardPaste} disabled={busy} onClick={() => void fromClipboard()}>
            Paste from Clipboard
          </Button>
        </div>
        <div className="roblox-dropzone">{busy ? 'Working…' : '…or drop an image file here'}</div>
      </div>
    </Dialog>
  );
}

export function openReplaceDialog(layerId: string, mode: ReplaceDialogProps['mode']) {
  return openDialog<unknown, ReplaceDialogProps>(ReplaceDialog, { layerId, mode });
}
