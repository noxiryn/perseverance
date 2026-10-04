/**
 * Shell module entry (imported by src/features.ts): registers the Window/Help/Preferences
 * commands, restores the persisted workspace and tool memory. The chrome itself is rendered by
 * <Shell/> (src/ui/shell/Shell.tsx) from src/App.tsx.
 */
import { registerShellCommands } from './commands';
import { installToolMemory } from './toolMemory';
import { initWorkspacePersistence } from './workspaces';

registerShellCommands();
initWorkspacePersistence();
installToolMemory();

export { getPref, setPref, usePref, PREF_DEFAULTS } from './prefs';
export { WORKSPACE_PRESETS, applyWorkspace, resetWorkspace } from './workspaces';
export { requestCloseDocument, createBlankDocument } from './documents';
