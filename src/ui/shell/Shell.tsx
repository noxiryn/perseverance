/**
 * The editor chrome (matches docs/reference/ref5-ui-reference.png):
 *
 *   title bar (32) ───────────────────────────────────────────────
 *   options bar (34) ─────────────────────────────────────────────
 *   toolbar │ tabs / canvas (viewport | start screen) │ strip │ dock
 *   status bar (24) ────────────────────────────┘     (full height)
 */
import { useEffect } from 'react';
import { useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { CommandPalette } from './CommandPalette';
import { DockArea } from './Dock';
import { DocTabs } from './DocTabs';
import { DropOverlay, useFileDrop } from './DropOverlay';
import { installDesktopIntegration } from './desktopIntegration';
import { installHistoryToasts } from './historyToasts';
import { installKeyboard } from './keyboard';
import { OptionsBar } from './OptionsBar';
import { PREF_DEFAULTS, usePref } from './prefs';
import { StartScreen } from './StartScreen';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { Toasts } from './Toasts';
import { Toolbar } from './Toolbar';
import { ViewportFallback, ViewportHost } from './ViewportHost';
import './shell.css';

function CanvasArea() {
  const hasDocs = useEditor((s) => s.docOrder.length > 0);
  const showStart = useUI((s) => s.showStart);
  return (
    <div className="shell-canvas">
      {hasDocs ? <ViewportHost /> : showStart ? <StartScreen /> : <ViewportFallback />}
      <Toasts />
    </div>
  );
}

function useUiScale() {
  const scale = usePref<number>('uiScale', PREF_DEFAULTS.uiScale);
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    const s = Math.max(0.5, Math.min(2, Number(scale) || 1));
    root.style.zoom = s === 1 ? '' : String(s);
    // Reserved native-window-button areas are specified in device px: compensate for the zoom.
    document.documentElement.style.setProperty('--shell-ui-scale', String(s));
    return () => {
      root.style.zoom = '';
      document.documentElement.style.removeProperty('--shell-ui-scale');
    };
  }, [scale]);
}

export function Shell() {
  useUiScale();
  useFileDrop();
  useEffect(() => installKeyboard(), []);
  useEffect(() => installDesktopIntegration(), []);
  useEffect(() => installHistoryToasts(), []);

  return (
    <div className="shell-root">
      <TitleBar />
      <OptionsBar />
      <div className="shell-body">
        <div className="shell-main">
          <div className="shell-work">
            <Toolbar />
            <div className="shell-center">
              <DocTabs />
              <CanvasArea />
            </div>
          </div>
          <StatusBar />
        </div>
        <DockArea />
      </div>
      <CommandPalette />
      <DropOverlay />
    </div>
  );
}
