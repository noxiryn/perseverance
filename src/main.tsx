import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './styles/theme.css';
import './features';
import { App } from './App';
import * as registries from './registry';
import { useEditor } from './state/editor';
import { useUI } from './state/ui';
import { bitmaps } from './core/bitmaps';
import * as documentUtils from './core/document';

// Automation/debug handle (used by scripts/shot.mjs and tests).
(window as unknown as { __app: unknown }).__app = {
  ...registries,
  useEditor,
  useUI,
  bitmaps,
  documentUtils,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
