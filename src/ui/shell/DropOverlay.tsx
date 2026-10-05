/**
 * File drag & drop onto the window: overlay "Drop to open"; .pgfx/.psd, no open document or Shift
 * held → open as new document, otherwise images are placed as layers. Drags carrying library
 * assets (application/x-perseverance-asset) or internal tab/panel drags are ignored.
 */
import { useEffect } from 'react';
import { FileUp } from 'lucide-react';
import { useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { dropMode, isSupportedDrop } from './docInfo';
import { openFileWithIo } from './documents';
import { useShell } from './shellStore';
import { claimFileDrop, fileDropHints } from './dropHooks';

const ASSET_MIME = 'application/x-perseverance-asset';

function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  const list = Array.from(types);
  return list.includes('Files') && !list.includes(ASSET_MIME);
}

export function useFileDrop() {
  const setFileDrag = useShell((s) => s.setFileDrag);
  useEffect(() => {
    let depth = 0;
    let hideTimer = 0;
    const armHide = () => {
      window.clearTimeout(hideTimer);
      // Some platforms do not fire dragleave when leaving the window: hide after inactivity.
      hideTimer = window.setTimeout(() => {
        depth = 0;
        setFileDrag(false);
      }, 400);
    };
    const enter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth++;
      setFileDrag(true);
      armHide();
    };
    const over = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setFileDrag(true);
      armHide();
    };
    const leave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setFileDrag(false);
    };
    const drop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      window.clearTimeout(hideTimer);
      depth = 0;
      setFileDrag(false);
      if (e.defaultPrevented) return; // a panel handled it
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      const hasDoc = !!useEditor.getState().activeDocId;
      const shift = e.shiftKey;
      for (const f of files) {
        if (!isSupportedDrop(f.name, f.type)) {
          toast(`“${f.name}” is not a supported file type`, 'warning');
          continue;
        }
        try {
          const data = await f.arrayBuffer();
          // Feature hooks (e.g. Replace Character on a selected placeholder) may claim the file.
          if (await claimFileDrop({ file: f, data, count: files.length, hasDoc, shift, clientX: e.clientX, clientY: e.clientY })) continue;
          await openFileWithIo({ path: null, name: f.name, data }, { asNewDocument: dropMode(f.name, hasDoc, shift) === 'new' });
        } catch (err) {
          console.error(err);
          toast(`Could not read “${f.name}”`, 'error');
        }
      }
    };
    // Prevent the browser from navigating to files dropped outside handled zones.
    const preventNav = (e: DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    document.addEventListener('dragover', preventNav);
    return () => {
      window.clearTimeout(hideTimer);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      document.removeEventListener('dragover', preventNav);
    };
  }, [setFileDrag]);
}

export function DropOverlay() {
  const active = useShell((s) => s.fileDrag);
  const hasDoc = useEditor((s) => !!s.activeDocId);
  if (!active) return null;
  return (
    <div className="shell-drop">
      <div className="shell-drop-card">
        <FileUp size={28} strokeWidth={1.5} />
        <div className="shell-drop-title">Drop to open</div>
        <div className="shell-drop-hint">
          {hasDoc ? (
            <>
              Images are placed as new layers · hold <kbd className="shell-kbd">Shift</kbd> to open as a new document
            </>
          ) : (
            <>Images, .pgfx projects and .psd files open as new documents</>
          )}
        </div>
        {hasDoc &&
          fileDropHints().map((h) => (
            <div key={h} className="shell-drop-hint">
              {h}
            </div>
          ))}
      </div>
    </div>
  );
}
