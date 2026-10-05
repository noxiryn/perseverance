import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import './styles/theme.css';
import './features';
import { App } from './App';
import * as registries from './registry';
import { useEditor } from './state/editor';
import { useUI } from './state/ui';
import { bitmaps } from './core/bitmaps';
import * as documentUtils from './core/document';
import { openDemoDocument } from './dev/demo';
import { renderDocument } from './render/compositor';

// Automation/debug handle (used by scripts/shot.mjs and tests).
(window as unknown as { __app: unknown }).__app = {
  ...registries,
  useEditor,
  useUI,
  bitmaps,
  documentUtils,
  openDemoDocument,
  renderDocument,
  // Lazy, like the app's own PSD import/export (keeps ag-psd out of the main chunk).
  loadPsd: () => import('./io/psd'),
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
