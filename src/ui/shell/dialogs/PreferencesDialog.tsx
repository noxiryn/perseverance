/** Edit ▸ Preferences (changes apply immediately and are saved). */
import type { ReactNode } from 'react';
import { Button, Checkbox, ColorField, Dialog, Select } from '../../controls';
import { toast } from '../../../state/ui';
import { PREF_DEFAULTS, resetPrefs, setPref, usePref } from '../prefs';
import { resetWorkspace } from '../workspaces';
import { fittingUiScale, MIN_UI_SIZE, UI_SCALES, useUiScaleState } from '../uiScale';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const AUTOSAVE = [0, 1, 2, 5, 10, 15, 30].map((v) => ({ value: String(v), label: v === 0 ? 'Off' : `Every ${v} min` }));
const CHECKER = [
  { value: '4', label: 'Small' },
  { value: '8', label: 'Medium' },
  { value: '16', label: 'Large' },
];
const BACKGROUNDS = [
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'custom', label: 'Custom color' },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="shell-pref-row">
      <div className="shell-pref-label">
        <span>{label}</span>
        {hint && <span className="shell-pref-hint">{hint}</span>}
      </div>
      <div className="shell-pref-control">{children}</div>
    </div>
  );
}

export function PreferencesDialog({ close }: { close: (r?: unknown) => void }) {
  const uiScale = usePref<number>('uiScale', PREF_DEFAULTS.uiScale);
  const toasts = usePref<boolean>('toasts', PREF_DEFAULTS.toasts);
  const autosave = usePref<number>('autosaveMinutes', PREF_DEFAULTS.autosaveMinutes);
  const bg = usePref<string>('defaultBackground', PREF_DEFAULTS.defaultBackground);
  const checker = usePref<number>('checkerSize', PREF_DEFAULTS.checkerSize);
  const isCustomBg = bg.startsWith('#');
  // Scales this window is too small for (the UI would be under MIN_UI_SIZE) are marked; choosing one
  // applies the largest scale that fits until the window is larger (uiScale.ts fittingUiScale).
  const win = useUiScaleState((st) => st.window);
  const applied = useUiScaleState((st) => st.applied);
  const tooBig = (v: number) => !!win && fittingUiScale(v, win.width, win.height) < v;
  const scales = UI_SCALES.map((v) => ({ value: String(v), label: tooBig(v) ? `${pct(v)} (needs a larger window)` : pct(v) }));

  return (
    <Dialog
      title="Preferences"
      onClose={() => close()}
      width={520}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              resetPrefs();
              toast('Preferences restored to defaults', 'info');
            }}
          >
            Restore Defaults
          </Button>
          <span style={{ flex: 1 }} />
          <Button variant="primary" onClick={() => close()}>
            Done
          </Button>
        </>
      }
    >
      <div className="shell-prefs">
        <div className="shell-pref-section">Interface</div>
        <Row label="UI scale" hint="Size of menus, panels and text">
          <div className="shell-pref-stack">
            <Select
              value={String(scales.find((s) => Number(s.value) === uiScale)?.value ?? '1')}
              options={scales}
              onChange={(v) => setPref('uiScale', Number(v))}
              width={210}
            />
            {applied < uiScale - 1e-6 && (
              <span className="shell-pref-note" data-ui-scale-note="">
                Using {pct(applied)} — this window is too small for {pct(uiScale)} (the editor needs {MIN_UI_SIZE.width} × {MIN_UI_SIZE.height} px at that size).
              </span>
            )}
          </div>
        </Row>
        <Row label="Action toasts" hint="“Delete Layer completed.” notifications">
          <Checkbox checked={toasts} onChange={(v) => setPref('toasts', v)} label={toasts ? 'On' : 'Off'} />
        </Row>
        <Row label="Workspace" hint="Panel layout of the current workspace">
          <Button size="small" onClick={() => resetWorkspace()}>
            Reset Workspace
          </Button>
        </Row>

        <div className="shell-pref-section">Documents</div>
        <Row label="New document background" hint="Used by quick-create and blank documents">
          <div className="shell-pref-inline">
            <Select
              value={isCustomBg ? 'custom' : bg}
              options={BACKGROUNDS}
              onChange={(v) => setPref('defaultBackground', v === 'custom' ? (isCustomBg ? bg : '#202020') : v)}
              width={130}
            />
            {isCustomBg && <ColorField value={bg} onChange={(c) => setPref('defaultBackground', c.slice(0, 7))} />}
          </div>
        </Row>
        <Row label="Autosave" hint="Recovery copies of open documents">
          <Select value={String(AUTOSAVE.find((a) => Number(a.value) === autosave)?.value ?? String(PREF_DEFAULTS.autosaveMinutes))} options={AUTOSAVE} onChange={(v) => setPref('autosaveMinutes', Number(v))} width={130} />
        </Row>

        <div className="shell-pref-section">Canvas</div>
        <Row label="Transparency grid" hint="Checkerboard square size">
          <Select value={String(CHECKER.find((c) => Number(c.value) === checker)?.value ?? '8')} options={CHECKER} onChange={(v) => setPref('checkerSize', Number(v))} width={130} />
        </Row>
      </div>
    </Dialog>
  );
}
