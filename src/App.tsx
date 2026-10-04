/**
 * App root. Owned by the shell module (src/ui/shell): it renders the full editor layout.
 *
 * DEV HARNESS (must keep working after the shell replaces this file):
 *   ?demo=1          open the demo document on start
 *   ?panel=<id>      render only the registered panel <id> in a 300×100vh column (for panel dev)
 *   ?view=1          render only the canvas viewport (src/viewport/Viewport.tsx) + toolbar-less
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { DialogHost, MenuHost } from './ui/controls';
import { panels, useRegistry } from './registry';
import { openDemoDocument } from './dev/demo';

const params = new URLSearchParams(location.search);

function PanelHarness({ id }: { id: string }) {
  const list = useRegistry(panels);
  const p = list.find((x) => x.id === id);
  if (!p) return <div className="ui-empty">Panel “{id}” is not registered</div>;
  const C = p.component;
  return (
    <div style={{ width: 300, height: '100vh', background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
      <div style={{ height: 28, display: 'flex', alignItems: 'center', padding: '0 8px', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{p.title}</div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <C />
      </div>
    </div>
  );
}

const ViewportHarness = lazy(async () => {
  const path = '/src/viewport/Viewport.tsx';
  const m = (await import(/* @vite-ignore */ path)) as { Viewport: React.ComponentType };
  return { default: m.Viewport };
});

export function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (params.get('demo')) openDemoDocument();
    setReady(true);
  }, []);
  if (!ready) return null;
  const panelId = params.get('panel');
  return (
    <div style={{ height: '100%', display: 'flex' }}>
      {panelId ? (
        <PanelHarness id={panelId} />
      ) : params.get('view') ? (
        <div style={{ flex: 1, position: 'relative' }}>
          <Suspense fallback={null}>
            <ViewportHarness />
          </Suspense>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-dim)' }}>Perseverance — editor shell not built yet</div>
      )}
      <DialogHost />
      <MenuHost />
    </div>
  );
}
