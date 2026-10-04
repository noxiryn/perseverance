/**
 * IO module entry (imported by src/features.ts): File / Edit / Image menu commands, New Document,
 * open/save (.pgfx), export (PNG/JPEG/WebP/PSD), PSD import, clipboard, recent files, autosave and
 * crash recovery.
 */
import { registerIoCommands } from './commands';
import { refreshRecentCommands } from './recent';
import { installPasteListener } from './clipboard';
import { startAutosave } from './autosave';

registerIoCommands();
refreshRecentCommands();

if (typeof window !== 'undefined') {
  installPasteListener();
  startAutosave();
}

export { openFile, placeImageBlob } from './open';
export { saveDocument } from './save';
export { encodeProject, decodeProject } from './project';
export { createNewDocument, showNewDocumentDialog } from './newDocument';
export { renderForExport } from './exportRender';
