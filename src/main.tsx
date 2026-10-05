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
import { blurBackend, blurBackendInfo, setBlurBackend } from './core/blur';

// Automation/debug handle (used by scripts/shot.mjs and tests).
(window as unknown as { __app: unknown }).__app = {
  ...registries,
  useEditor,
  useUI,
  bitmaps,
  documentUtils,
  openDemoDocument,
  // which CPU blur kernels run ('wasm' | 'js', and why), and a switch for benchmarks
  blurBackend,
  blurBackendInfo,
  setBlurBackend,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
