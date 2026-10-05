/**
 * My Assets: images the user imported (IndexedDB). Import via button or drop zone; cards place
 * the image as a raster layer fitted to ~60% of the document; rename/delete via context menu.
 */
import { useEffect, useState } from 'react';
import { FolderHeart, ImagePlus, Pencil, Trash2, Upload } from 'lucide-react';
import { Button, Dialog, TextInput, showContextMenu } from '../../ui/controls';
import { openDialog, toast } from '../../state/ui';
import { openFiles } from '../../platform';
import { deleteUserAsset, ensureFullImage, importImages, importSummary, loadUserAssets, renameUserAsset, useUserAssets } from '../lib/userAssets';
import type { UserAssetEntry } from '../lib/userAssets';
import { startDrag } from '../lib/dnd';
import { placeAssetWhenReady } from '../place';
import { AssetThumb } from './AssetThumb';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif'];

function RenameDialog({ close, name }: { close: (r?: string) => void; name: string }) {
  const [value, setValue] = useState(name);
  return (
    <Dialog
      title="Rename Asset"
      width={340}
      onClose={() => close()}
      onSubmit={() => close(value)}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={() => close(value)} disabled={!value.trim()}>
            Rename
          </Button>
        </>
      }
    >
      <TextInput value={value} onChange={setValue} placeholder="Asset name" />
    </Dialog>
  );
}

function DeleteDialog({ close, name }: { close: (r?: boolean) => void; name: string }) {
  return (
    <Dialog
      title="Delete Asset"
      width={360}
      onClose={() => close(false)}
      onSubmit={() => close(true)}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" icon={Trash2} onClick={() => close(true)}>
            Delete
          </Button>
        </>
      }
    >
      <div className="assets-confirm">
        Remove “{name}” from My Assets? The image is deleted from this computer’s library and can’t be restored with Undo. Layers already placed in
        documents are not affected.
      </div>
    </Dialog>
  );
}

async function importBlobs(files: { name: string; blob: Blob }[]) {
  const images = files.filter((f) => f.blob.type.startsWith('image/') || IMAGE_EXTS.includes(f.name.split('.').pop()?.toLowerCase() ?? ''));
  const skipped = files.length - images.length;
  if (!images.length) {
    toast('Only image files (PNG, JPG, WebP, GIF, SVG…) can be added to My Assets', 'warning');
    return;
  }
  try {
    const { added, failed } = await importImages(images);
    const s = importSummary(
      added.map((a) => a.name),
      failed.map((f) => f.name),
    );
    toast(skipped ? `${s.message} (${skipped} non-image ${skipped === 1 ? 'file' : 'files'} skipped)` : s.message, s.kind, failed.length ? 4500 : 2600);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not import the images', 'error');
  }
}

export async function importFromDialog() {
  const files = await openFiles({ title: 'Add Images to My Assets', multiple: true, filters: [{ name: 'Images', extensions: IMAGE_EXTS }] });
  if (!files.length) return;
  await importBlobs(files.map((f) => ({ name: f.name, blob: new Blob([f.data], { type: mimeOf(f.name) }) })));
}

function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return ext ? `image/${ext}` : 'application/octet-stream';
}

function UserCard({ e }: { e: UserAssetEntry }) {
  const menu = (ev: React.MouseEvent) =>
    showContextMenu(ev, [
      { label: 'Place in Document', icon: ImagePlus, run: () => void placeAssetWhenReady(e.assetId) },
      { separator: true },
      {
        label: 'Rename…',
        icon: Pencil,
        run: async () => {
          const name = await openDialog(RenameDialog, { name: e.name });
          if (name && name.trim() && name.trim() !== e.name) await renameUserAsset(e.id, name).catch(() => toast('Could not rename the asset', 'error'));
        },
      },
      {
        label: 'Delete',
        icon: Trash2,
        run: async () => {
          if (!(await openDialog(DeleteDialog, { name: e.name }))) return;
          try {
            await deleteUserAsset(e.id);
          } catch {
            toast(`Could not delete “${e.name}”`, 'error');
            return;
          }
          toast(`Removed “${e.name}” from My Assets`, 'info');
        },
      },
    ]);
  return (
    <div
      className="assets-card"
      title={`${e.name} (${e.width}×${e.height}) — click to place, drag onto the canvas, right-click for options`}
      draggable
      onDragStart={(ev) => startDrag(ev, { kind: 'asset', id: e.assetId })}
      onClick={() => void placeAssetWhenReady(e.assetId)}
      onPointerEnter={() => void ensureFullImage(e.id)}
      onContextMenu={menu}
    >
      <AssetThumb assetId={e.assetId} square />
      <div className="assets-card-name">{e.name}</div>
    </div>
  );
}

export function MyAssetsTab() {
  const { items, loaded, error } = useUserAssets();
  const [over, setOver] = useState(false);
  useEffect(() => {
    void loadUserAssets();
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void importBlobs(files.map((f) => ({ name: f.name, blob: f })));
  };
  const dragProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop,
  };

  return (
    <div className="assets-scroll" {...dragProps}>
      <div className={`assets-drop${over ? ' over' : ''}${items.length ? ' compact' : ''}`}>
        {!items.length && <Upload size={18} />}
        <span>{over ? 'Drop to add to My Assets' : items.length ? 'Drop images here or' : 'Drop PNG/JPG/WebP/SVG images here to keep them in your library'}</span>
        <Button size="small" icon={ImagePlus} onClick={() => void importFromDialog()}>
          Add Images…
        </Button>
      </div>
      {error ? (
        <div className="assets-empty">Your asset library could not be opened ({error}).</div>
      ) : !loaded ? (
        <div className="assets-empty">Loading…</div>
      ) : !items.length ? (
        <div className="assets-empty">
          <FolderHeart size={18} />
          Logos, characters and renders you add here are saved on this computer and can be reused in any document.
        </div>
      ) : (
        <div className="assets-grid">
          {items.map((e) => (
            <UserCard key={e.id} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}
