/**
 * Lazy entry points for the three.js dialogs, so three.js is only downloaded/parsed when Pose
 * Studio or the model importer is first opened.
 */
import { toast } from '../../state/ui';
import type { OpenedFile } from '../../platform';
import type { ModelFile } from './modelCache';

function failed(err: unknown) {
  console.error('Failed to load the 3D module', err);
  toast('Could not load the 3D module. Try again or restart the app.', 'error', 4000);
  return undefined;
}

export async function openPoseStudio(opts: { layerId?: string | null } = {}) {
  try {
    const m = await import('./PoseStudio');
    return await m.openPoseStudio(opts);
  } catch (err) {
    return failed(err);
  }
}

export async function openModelImport(opts: { files?: OpenedFile[] | ModelFile[]; layerId?: string | null; pick?: boolean } = {}) {
  try {
    const m = await import('./ModelImport');
    return await m.openModelImport(opts);
  } catch (err) {
    return failed(err);
  }
}
