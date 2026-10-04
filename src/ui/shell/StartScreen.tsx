/**
 * Start screen shown in the canvas area when no documents are open: brand, New/Open, quick-create
 * Roblox formats, templates gallery, recent files and tips.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, FileImage, FilePlus2, FolderOpen, Gamepad2, LayoutTemplate, Lightbulb, Monitor, Ratio, Sparkles, X } from 'lucide-react';
import { commands, docPresets, runCommand, templates, useRegistry, type TemplateDef } from '../../registry';
import { isDesktop } from '../../platform';
import { Keys } from './Keys';
import { LogoLarge } from './Logo';
import { BUILTIN_QUICK_PRESETS, createBlankDocument, openRecent, openTemplate, readRecent, removeRecent, timeAgo, type RecentEntry } from './documents';

interface QuickCard {
  key: string;
  name: string;
  width: number;
  height: number;
  description: string;
  icon: typeof Gamepad2;
}

function useQuickCards(): QuickCard[] {
  const presets = useRegistry(docPresets);
  return useMemo(() => {
    const cards: QuickCard[] = BUILTIN_QUICK_PRESETS.map((p) => {
      const reg = presets.find((d) => d.width === p.width && d.height === p.height && d.category === 'Roblox') ?? presets.find((d) => d.width === p.width && d.height === p.height);
      return {
        key: reg?.id ?? p.id,
        name: reg?.name ?? p.name,
        width: p.width,
        height: p.height,
        description: reg?.description ?? p.description,
        icon: p.width === p.height ? Gamepad2 : Monitor,
      };
    });
    // Up to two more Roblox presets from the registry.
    for (const d of presets) {
      if (cards.length >= 4) break;
      if (d.category !== 'Roblox' || cards.some((c) => c.width === d.width && c.height === d.height)) continue;
      cards.push({ key: d.id, name: d.name, width: d.width, height: d.height, description: d.description ?? `${d.width} × ${d.height}`, icon: Ratio });
    }
    return cards;
  }, [presets]);
}

function FrameGlyph({ w, h, icon: Icon }: { w: number; h: number; icon: typeof Gamepad2 }) {
  const max = 54;
  const s = max / Math.max(w, h);
  return (
    <div className="shell-quick-art">
      <div className="shell-quick-frame" style={{ width: Math.max(18, w * s), height: Math.max(18, h * s) }}>
        <Icon size={16} strokeWidth={1.6} />
      </div>
    </div>
  );
}

function templateBackground(t: TemplateDef): string {
  const sw = t.swatch?.length ? t.swatch : ['#2a2a2a', '#0e0e0e'];
  if (sw.length === 1) return sw[0];
  const stops = sw.map((c, i) => `${c} ${Math.round((i / (sw.length - 1)) * 100)}%`).join(', ');
  return `linear-gradient(135deg, ${stops})`;
}

function TemplateCard({ t }: { t: TemplateDef }) {
  const [busy, setBusy] = useState(false);
  const ratio = t.width / Math.max(1, t.height);
  const fg = t.swatch?.[t.swatch.length > 2 ? 2 : 1] ?? '#f2f2f2';
  return (
    <button
      className={`shell-tpl${busy ? ' busy' : ''}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await openTemplate(t);
        } finally {
          setBusy(false);
        }
      }}
      title={t.description ?? t.name}
    >
      <div className="shell-tpl-art">
        <div className="shell-tpl-frame" style={{ aspectRatio: `${ratio}`, background: templateBackground(t), ...(ratio >= 1 ? { width: '86%' } : { height: '86%' }) }}>
          <div className="shell-tpl-dots" />
          <div className="shell-tpl-vignette" />
          <span className="shell-tpl-glyph" style={{ color: fg }}>
            {t.name.split(/\s+/).slice(0, 2).join(' ')}
          </span>
        </div>
        {busy && <div className="shell-tpl-busy">Building…</div>}
      </div>
      <div className="shell-tpl-meta">
        <span className="shell-tpl-name">{t.name}</span>
        <span className="shell-tpl-size">
          {t.category} · {t.width}×{t.height}
        </span>
      </div>
    </button>
  );
}

function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={['shell-start-section', className].filter(Boolean).join(' ')}>
      <div className="shell-start-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const TIPS: { text: ReactNode; keys?: string }[] = [
  { text: 'Search every command, filter, look, asset and font', keys: 'Ctrl+K' },
  { text: 'Hold Space to pan · hold Alt while painting to pick a color' },
  { text: 'Drop images onto the window to place them as layers — Shift opens a new document' },
  { text: 'Hide all panels for a distraction-free canvas', keys: 'Tab' },
  { text: 'See every keyboard shortcut', keys: 'F1' },
];

export function StartScreen() {
  const tpls = useRegistry(templates);
  const cmds = useRegistry(commands);
  const quick = useQuickCards();
  const [recent, setRecent] = useState<RecentEntry[]>(() => readRecent().sort((a, b) => b.time - a.time).slice(0, 8));
  const has = (id: string) => cmds.some((c) => c.id === id);

  const newDoc = () => (has('file.new') ? runCommand('file.new') : createBlankDocument('Untitled', 1920, 1080));
  const openDoc = () => runCommand('file.open');

  return (
    <div className="shell-start">
      <div className="shell-start-glow" />
      <div className="shell-start-inner">
        <header className="shell-start-hero">
          <LogoLarge size={60} />
          <div className="shell-start-brand">
            <h1>Perseverance</h1>
            <p>Stylized Roblox thumbnails, icons &amp; GFX — gothic posters, halftone comics, noir collages, crimson film looks.</p>
          </div>
          <div className="shell-start-actions">
            <button className="ui-btn primary shell-start-btn" onClick={newDoc}>
              <FilePlus2 size={14} strokeWidth={1.8} /> New…
              <Keys shortcut="Ctrl+N" className="on-accent" />
            </button>
            <button className="ui-btn shell-start-btn" onClick={openDoc} disabled={!has('file.open')}>
              <FolderOpen size={14} strokeWidth={1.8} /> Open…
              <Keys shortcut="Ctrl+O" />
            </button>
          </div>
        </header>

        <Section title="Quick start">
          <div className="shell-quick">
            {quick.map((q) => (
              <button key={q.key} className="shell-quick-card" onClick={() => createBlankDocument(q.name, q.width, q.height)}>
                <FrameGlyph w={q.width} h={q.height} icon={q.icon} />
                <div className="shell-quick-meta">
                  <span className="shell-quick-name">{q.name}</span>
                  <span className="shell-quick-size">
                    {q.width} × {q.height} px
                  </span>
                  <span className="shell-quick-desc">{q.description}</span>
                </div>
              </button>
            ))}
            <button className="shell-quick-card custom" onClick={newDoc}>
              <div className="shell-quick-art">
                <div className="shell-quick-frame dashed">
                  <FilePlus2 size={16} strokeWidth={1.6} />
                </div>
              </div>
              <div className="shell-quick-meta">
                <span className="shell-quick-name">Custom size</span>
                <span className="shell-quick-size">Any dimensions</span>
                <span className="shell-quick-desc">Presets, background &amp; more</span>
              </div>
            </button>
          </div>
        </Section>

        <Section
          title="Templates"
          action={
            has('file.newFromTemplate') ? (
              <button className="shell-start-link" onClick={() => runCommand('file.newFromTemplate')}>
                Browse all <ArrowRight size={12} />
              </button>
            ) : undefined
          }
        >
          {tpls.length ? (
            <div className="shell-tpls">
              {tpls.slice(0, 10).map((t) => (
                <TemplateCard key={t.id} t={t} />
              ))}
            </div>
          ) : (
            <div className="shell-start-empty">
              <LayoutTemplate size={16} strokeWidth={1.5} /> Templates will appear here.
            </div>
          )}
        </Section>

        <div className="shell-start-bottom">
          <Section title="Recent" className="shell-start-recent">
            {recent.length ? (
              <div className="shell-recent">
                {recent.map((r) => (
                  <div key={r.path} className="shell-recent-row" onClick={() => void openRecent(r)} title={r.path}>
                    <FileImage size={14} strokeWidth={1.6} />
                    <span className="shell-recent-name">{r.name}</span>
                    <span className="shell-recent-path">{r.path.replace(/[\\/][^\\/]*$/, '')}</span>
                    <span className="shell-recent-time">{timeAgo(r.time)}</span>
                    <button
                      className="shell-recent-x"
                      title="Remove from list"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRecent(r.path);
                        setRecent((list) => list.filter((x) => x.path !== r.path));
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="shell-start-empty">
                <FileImage size={16} strokeWidth={1.5} />
                {isDesktop ? 'Files you open or save will show up here.' : 'Recent files are listed in the desktop app.'}
              </div>
            )}
          </Section>
          <Section title="Tips" className="shell-start-tips">
            <ul className="shell-tips">
              {TIPS.map((t, i) => (
                <li key={i}>
                  <Lightbulb size={12} strokeWidth={1.7} />
                  <span>{t.text}</span>
                  {t.keys && <Keys shortcut={t.keys} />}
                </li>
              ))}
            </ul>
            <button className="shell-start-link" onClick={() => runCommand('help.tips')}>
              <Sparkles size={12} /> Make your first Roblox thumbnail <ArrowRight size={12} />
            </button>
          </Section>
        </div>
      </div>
    </div>
  );
}
