import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutTemplate, Loader2 } from 'lucide-react';
import { templates, useRegistry, type TemplateDef } from '../registry';
import { Button, Dialog, SearchInput } from '../ui/controls';
import { openTemplate } from './open';
import { useTemplatePreview } from './previews';
import './templates.css';

const CATEGORY_ORDER: TemplateDef['category'][] = ['Thumbnail', 'Icon', 'Banner', 'Social', 'Blank'];
const CATEGORY_LABEL: Record<string, string> = {
  All: 'All templates',
  Thumbnail: 'Thumbnails',
  Icon: 'Icons',
  Banner: 'Banners',
  Social: 'Social',
  Blank: 'Blank formats',
};

let lastCategory = 'All';

function swatchBackground(sw: string[] | undefined): string {
  if (!sw?.length) return '#1e1e1e';
  if (sw.length === 1) return sw[0];
  const stops = sw.map((c, i) => `${c} ${Math.round((i / (sw.length - 1)) * 100)}%`).join(', ');
  return `linear-gradient(140deg, ${stops})`;
}

/** Tracks whether an element is (nearly) on screen inside its scroll container. */
function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
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
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return [ref, visible];
}

function TemplateCard({ t, index, busy, disabled, onOpen }: { t: TemplateDef; index: number; busy: boolean; disabled: boolean; onOpen: (t: TemplateDef) => void }) {
  const [ref, visible] = useVisible<HTMLButtonElement>();
  const preview = useTemplatePreview(t.id, visible, index);
  const ratio = t.width / Math.max(1, t.height);
  return (
    <button ref={ref} className={`templates-card${busy ? ' busy' : ''}`} disabled={disabled} onClick={() => onOpen(t)} title={t.description ?? t.name}>
      <div className="templates-art">
        <div
          className={`templates-frame${preview ? ' ready' : ''}${t.category === 'Blank' ? ' blank' : ''}`}
          style={{
            aspectRatio: String(ratio),
            background: preview ? undefined : swatchBackground(t.swatch),
            ...(ratio >= 1.25 ? { width: '100%' } : { height: '100%' }),
          }}
        >
          {preview ? <img src={preview} alt="" draggable={false} /> : <span className="templates-shimmer" />}
        </div>
        {busy && (
          <div className="templates-busy">
            <Loader2 size={16} className="templates-spin" /> Building…
          </div>
        )}
      </div>
      <div className="templates-meta">
        <span className="templates-name">{t.name}</span>
        <span className="templates-size">
          {t.width} × {t.height}
        </span>
      </div>
      {t.description && <div className="templates-desc">{t.description}</div>}
    </button>
  );
}

export function NewFromTemplateDialog({ close }: { close: (result?: string) => void }) {
  const all = useRegistry(templates);
  const [category, setCategory] = useState<string>(lastCategory);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m: Record<string, number> = { All: all.length };
    for (const t of all) m[t.category] = (m[t.category] ?? 0) + 1;
    return m;
  }, [all]);
  const categories = ['All', ...CATEGORY_ORDER.filter((c) => counts[c])];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = all.filter(
      (t) =>
        (category === 'All' || t.category === category) &&
        (!q || `${t.name} ${t.category} ${t.description ?? ''} ${t.width}x${t.height}`.toLowerCase().includes(q)),
    );
    // Designed templates first, blanks last; keep registration order otherwise.
    return list.sort((a, b) => Number(a.category === 'Blank') - Number(b.category === 'Blank'));
  }, [all, category, query]);

  const pick = (c: string) => {
    lastCategory = c;
    setCategory(c);
  };

  const onOpen = async (t: TemplateDef) => {
    if (busy) return;
    setBusy(t.id);
    const id = await openTemplate(t.id);
    setBusy(null);
    if (id) close(id);
  };

  return (
    <Dialog
      title={
        <span className="templates-title">
          <LayoutTemplate size={15} /> New from Template
        </span>
      }
      width={980}
      onClose={() => !busy && close()}
      footer={
        <>
          <span className="templates-foot-hint">Every template is built from editable layers — swap the placeholder character, edit text, try a look.</span>
          <Button onClick={() => close()} disabled={!!busy}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="templates-dlg">
        <aside className="templates-side">
          <SearchInput value={query} onChange={setQuery} placeholder="Search templates" autoFocus />
          <nav className="templates-cats">
            {categories.map((c) => (
              <button key={c} className={`templates-cat${category === c ? ' active' : ''}`} onClick={() => pick(c)}>
                <span>{CATEGORY_LABEL[c] ?? c}</span>
                <span className="templates-count">{counts[c] ?? 0}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="templates-main ui-scroll">
          {shown.length ? (
            <div className="templates-grid">
              {shown.map((t, i) => (
                <TemplateCard key={t.id} t={t} index={i} busy={busy === t.id} disabled={!!busy && busy !== t.id} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <div className="ui-empty">No templates match “{query}”.</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
