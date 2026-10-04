/**
 * App root. Owned by the shell module (src/ui/shell): it renders the full editor layout.
 * This placeholder only mounts the global hosts so the app runs before the shell is built.
 */
import { DialogHost, MenuHost } from './ui/controls';

export function App() {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-dim)' }}>
      Perseverance — loading editor shell…
      <DialogHost />
      <MenuHost />
    </div>
  );
}
