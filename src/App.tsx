/**
 * App root (owned by the shell module): renders the full editor chrome from src/ui/shell.
 *
 * DEV HARNESS (kept working for module development and automated screenshots):
 *   ?demo=1          open the demo document on start (works with every mode)
 *   ?panel=<id>      render only the registered panel <id> in a 300×100vh column (for panel dev)
 *   ?view=1          render only the canvas viewport (src/viewport/Viewport.tsx), no chrome
 */
import { useEffect, useState } from 'react';
import { DialogHost, MenuHost } from './ui/controls';
import { panels, useRegistry } from './registry';
import { openDemoDocument } from './dev/demo';
import { Shell } from './ui/shell/Shell';
import { ErrorBoundary } from './ui/shell/ErrorBoundary';
import { Toasts } from './ui/shell/Toasts';
import { ViewportHost } from './ui/shell/ViewportHost';
import { installKeyboard } from './ui/shell/keyboard';
import './ui/shell/shell.css';

const params = new URLSearchParams(location.search);

/** Open the demo document once (StrictMode runs mount effects twice in dev). */
let demoOpened = false;
function openDemoOnce() {
  if (demoOpened) return;
  demoOpened = true;
  openDemoDocument();
}

function PanelHarness({ id }: { id: string }) {
  const list = useRegistry(panels);
  const p = list.find((x) => x.id === id);
  if (!p) return <div className="ui-empty">Panel “{id}” is not registered</div>;
  const C = p.component;
  return (
    <div style={{ width: 300, height: '100vh', background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
      <div style={{ height: 28, display: 'flex', alignItems: 'center', padding: '0 8px', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{p.title}</div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ErrorBoundary name={`${p.title} panel`}>
          <C />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function ViewHarness() {
  useEffect(() => installKeyboard(), []);
  return (
    <div className="shell-canvas" style={{ flex: 1 }}>
      <ViewportHost />
      <Toasts />
    </div>
  );
}

export function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (params.get('demo')) openDemoOnce();
    setReady(true);
  }, []);
  if (!ready) return null;

  const panelId = params.get('panel');
  let content;
  if (panelId) {
    content = (
      <div style={{ height: '100%', display: 'flex' }}>
        <PanelHarness id={panelId} />
        <div style={{ position: 'relative', flex: 1 }}>
          <Toasts />
        </div>
      </div>
    );
  } else if (params.get('view')) {
    content = (
      <div style={{ height: '100%', display: 'flex' }}>
        <ViewHarness />
      </div>
    );
  } else {
    content = <Shell />;
  }

  return (
    <>
      {content}
      <DialogHost />
      <MenuHost />
    </>
  );
}
