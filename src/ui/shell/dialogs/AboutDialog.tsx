/** Help ▸ About Perseverance. */
import { Button, Dialog } from '../../controls';
import { appVersion, isDesktop, platformName } from '../../../platform';
import { LogoLarge } from '../Logo';

const CREDITS: [string, string][] = [
  ['Fonts', 'SIL OFL via Fontsource'],
  ['Icons', 'Lucide (ISC)'],
  ['3D', 'three.js (MIT)'],
  ['PSD', 'ag-psd (MIT)'],
  ['UI', 'React, zustand, immer'],
  ['App', 'Electron, Vite'],
];

export function AboutDialog({ close }: { close: (r?: unknown) => void }) {
  return (
    <Dialog title="About Perseverance" onClose={() => close()} width={440} footer={<Button variant="primary" onClick={() => close()}>Close</Button>}>
      <div className="shell-about">
        <LogoLarge size={72} />
        <div className="shell-about-name">Perseverance</div>
        <div className="shell-about-version">
          Version {appVersion} · {isDesktop ? `Desktop (${platformName})` : 'Web'}
        </div>
        <p className="shell-about-desc">
          A Photoshop-style editor for stylized Roblox thumbnails, icons and GFX — made for gothic paper posters, halftone comics, noir newspaper
          collages and crimson film looks. Everything works offline.
        </p>
        <div className="shell-about-credits">
          {CREDITS.map(([k, v]) => (
            <div key={k} className="shell-about-credit">
              <span>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
        <div className="shell-about-copy">© 2026 noxiryn. Not affiliated with Roblox Corporation.</div>
      </div>
    </Dialog>
  );
}
