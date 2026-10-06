/**
 * Start screen shown in the canvas area when no documents are open: brand, New/Open, quick-create
 * Roblox formats, "start from your character" entry points, templates gallery (real rendered
 * previews), recent files and tips.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowRight,
  Box,
  CloudDownload,
  FileImage,
  FilePlus2,
  FolderOpen,
  Gamepad2,
  ImageUp,
  LayoutTemplate,
  Lightbulb,
  Monitor,
  PersonStanding,
  Ratio,
  Sparkles,
  X,
} from 'lucide-react';
import { commands, docPresets, runCommand, templates, useRegistry, type TemplateDef } from '../../registry';
import { isDesktop } from '../../platform';
import { useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { cancelPendingTemplatePreviews, pauseTemplatePreviews, useTemplatePreviewState } from '../../templates/previews';
import { openTipsGuide } from './dialogs/TipsDialog';
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

/** Loading placeholder: the template's swatch colors. */
function templateBackground(t: TemplateDef): string {
  const sw = t.swatch?.length ? t.swatch : ['#2a2a2a', '#0e0e0e'];
  if (sw.length === 1) return sw[0];
  const stops = sw.map((c, i) => `${c} ${Math.round((i / (sw.length - 1)) * 100)}%`).join(', ');
  return `linear-gradient(135deg, ${stops})`;
}

/** True once the element has come (nearly) on screen; previews are rendered lazily. */
function useOnScreen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return [ref, visible];
}

/** Every card uses the same 16:9 art box; square/portrait templates are letterboxed inside it. */
const ART_RATIO = 16 / 9;

function TemplateCard({ t, index, previewsOn }: { t: TemplateDef; index: number; previewsOn: boolean }) {
  const [busy, setBusy] = useState(false);
  const [ref, visible] = useOnScreen<HTMLButtonElement>();
  // While a dialog is up (e.g. New from Template) its own previews go first; ours resume after.
  const { url: preview, loading } = useTemplatePreviewState(t.id, visible && previewsOn, index);
  const ratio = t.width / Math.max(1, t.height);
  return (
    <button
      ref={ref}
      className={`shell-tpl${busy ? ' busy' : ''}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // Building the full-resolution document is the priority: hold preview rendering meanwhile.
        pauseTemplatePreviews(true);
        try {
          await openTemplate(t);
        } finally {
          pauseTemplatePreviews(false);
          setBusy(false);
        }
      }}
      title={t.description ? `${t.name} — ${t.description}` : t.name}
    >
      <div className="shell-tpl-art">
        <div className="shell-tpl-stage">
          <div
            className={`shell-tpl-frame${preview ? ' ready' : ''}`}
            style={{
              aspectRatio: String(ratio),
              background: preview ? undefined : templateBackground(t),
              ...(ratio >= ART_RATIO ? { width: '100%' } : { height: '100%' }),
            }}
          >
            {preview ? <img src={preview} alt="" draggable={false} /> : loading && <span className="shell-tpl-shimmer" />}
          </div>
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

/** Open an image as a new document, then straight into Remove Background. */
async function openRender() {
  const before = new Set(useEditor.getState().docOrder);
  await runCommand('file.open');
  const st = useEditor.getState();
  const id = st.activeDocId;
  if (!id || before.has(id)) return;
  const doc = st.sessions[id]?.doc;
  const only = doc && doc.rootIds.length === 1 ? doc.layers[doc.rootIds[0]] : null;
  if (only?.type === 'raster' && commands.has('roblox.removeBackground')) runCommand('roblox.removeBackground');
}

interface CharacterCard {
  key: string;
  name: string;
  description: string;
  icon: typeof Gamepad2;
  available: boolean;
  run: () => unknown;
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
  { text: 'Search commands, filters, looks, assets and fonts', keys: 'Ctrl+K' },
  { text: 'Hold Space to pan · hold Alt while painting to pick a color' },
  { text: 'Drop images on the window to place them as layers (Shift: new document)' },
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
  const previewsOn = useUI((s) => s.dialogs.length === 0);
  // Designed templates first (blank formats are in Quick start already); registration order otherwise.
  const shownTpls = useMemo(() => [...tpls].sort((a, b) => Number(a.category === 'Blank') - Number(b.category === 'Blank')).slice(0, 10), [tpls]);

  // Leaving the start screen (a document opened): drop preview jobs that haven't started, so they
  // don't compete with editing. Finished previews stay cached for next time.
  useEffect(
    () => () => {
      if (!useUI.getState().dialogs.length) cancelPendingTemplatePreviews();
    },
    [],
  );

  const character: CharacterCard[] = [
    { key: 'pose', name: 'Pose Studio', description: 'Pose an R6 / R15 avatar in 3D', icon: PersonStanding, available: has('roblox.poseStudio'), run: () => runCommand('roblox.poseStudio') },
    { key: 'avatar', name: 'Fetch Roblox Avatar', description: 'Download by Roblox username', icon: CloudDownload, available: has('roblox.fetchAvatar'), run: () => runCommand('roblox.fetchAvatar') },
    { key: 'model', name: 'Import 3D Model', description: 'OBJ / GLB from Roblox Studio', icon: Box, available: has('roblox.importModel'), run: () => runCommand('roblox.importModel') },
    { key: 'render', name: 'Open a Render', description: 'PNG / JPG, then Remove Background', icon: ImageUp, available: has('file.open'), run: openRender },
  ].filter((c) => c.available);

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
            {has('help.tips') && (
              <button className="ui-btn shell-start-btn" onClick={() => openTipsGuide({ restart: true })} title="Step-by-step guide: canvas, character, background, look, title, export">
                <Sparkles size={14} strokeWidth={1.8} /> Make a Roblox thumbnail
              </button>
            )}
          </div>
        </header>

        <Section
          title="Quick start"
          action={
            <button className="shell-start-link" onClick={newDoc} title="Any size — presets, background & more">
              Custom size… <ArrowRight size={12} />
            </button>
          }
        >
          <div className="shell-quick">
            {quick.map((q) => (
              <button
                key={q.key}
                className="shell-quick-card"
                onClick={() => createBlankDocument(q.name, q.width, q.height)}
                title={`${q.name} — ${q.width} × ${q.height} px${q.description ? `\n${q.description}` : ''}`}
              >
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
          </div>
        </Section>

        {character.length > 0 && (
          <Section title="Start from your character">
            <div className="shell-quick shell-char">
              {character.map((c) => {
                const Icon = c.icon;
                return (
                  <button key={c.key} className="shell-quick-card" data-start-character={c.key} onClick={() => void c.run()} title={`${c.name} — ${c.description}`}>
                    <div className="shell-quick-art">
                      <div className="shell-quick-frame shell-char-frame">
                        <Icon size={18} strokeWidth={1.6} />
                      </div>
                    </div>
                    <div className="shell-quick-meta">
                      <span className="shell-quick-name">{c.name}</span>
                      <span className="shell-quick-desc">{c.description}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </Section>
        )}

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
              {shownTpls.map((t, i) => (
                <TemplateCard key={t.id} t={t} index={i} previewsOn={previewsOn} />
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
            <button className="shell-start-link" onClick={() => openTipsGuide({ restart: true })}>
              <Sparkles size={12} /> Make your first Roblox thumbnail <ArrowRight size={12} />
            </button>
          </Section>
        </div>
      </div>
    </div>
  );
}
