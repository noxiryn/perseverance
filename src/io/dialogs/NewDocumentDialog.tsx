import { useMemo, useState } from 'react';
import { ArrowLeftRight, Clock, Film, Gamepad2, Monitor, Printer, Smartphone, Square } from 'lucide-react';
import { Button, ColorField, Dialog, NumberField, Select, TextInput } from '../../ui/controls';
import { docPresets, useRegistry, type DocPresetDef } from '../../registry';
import {
  backgroundColorOf,
  defaultBackground,
  FALLBACK_PRESETS,
  MAX_DOC_SIZE,
  PRESET_CATEGORIES,
  readRecentSizes,
  type BackgroundChoice,
  type NewDocumentSpec,
} from '../newDocument';
import { formatBytes } from '../math';
import { useDeferredSubmit } from './useDeferredSubmit';
import '../io.css';

const CAT_ICONS: Record<string, typeof Gamepad2> = {
  Recent: Clock,
  Roblox: Gamepad2,
  Social: Smartphone,
  Video: Film,
  Print: Printer,
  Common: Monitor,
};

const BG_OPTIONS: { value: BackgroundChoice; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'custom', label: 'Custom color' },
];

interface Item {
  key: string;
  name: string;
  width: number;
  height: number;
  description?: string;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/** '16:9', '1:1', … (falls back to a decimal ratio for odd sizes). */
function aspectLabel(w: number, h: number): string {
  w = Math.round(w);
  h = Math.round(h);
  if (w < 1 || h < 1) return '—';
  const g = gcd(w, h);
  const a = w / g;
  const b = h / g;
  return a <= 32 && b <= 32 ? `${a}:${b}` : `${(w / h).toFixed(2)}:1`;
}

function AspectIcon({ w, h }: { w: number; h: number }) {
  const k = 18 / Math.max(w, h);
  return (
    <span className="io-aspect">
      <span style={{ width: Math.max(4, w * k), height: Math.max(4, h * k) }} />
    </span>
  );
}

export function NewDocumentDialog({ close, initial }: { close: (r?: NewDocumentSpec) => void; initial?: Partial<NewDocumentSpec> }) {
  const registered = useRegistry(docPresets);
  const presets = registered.length ? registered : FALLBACK_PRESETS;
  const recent = useMemo(() => readRecentSizes(), []);
  const bgDefault = useMemo(() => defaultBackground(), []);

  const groups = useMemo(() => {
    const out: { cat: string; items: Item[] }[] = [];
    if (recent.length)
      out.push({ cat: 'Recent', items: recent.map((r, i) => ({ key: `recent-${i}`, name: `${r.width} × ${r.height}`, width: r.width, height: r.height })) });
    const cats = [...PRESET_CATEGORIES, ...new Set(presets.map((p) => p.category).filter((c) => !PRESET_CATEGORIES.includes(c)))];
    for (const cat of cats) {
      const items = presets
        .filter((p: DocPresetDef) => p.category === cat)
        .map((p) => ({ key: p.id, name: p.name, width: p.width, height: p.height, description: p.description }));
      if (items.length) out.push({ cat, items });
    }
    return out;
  }, [presets, recent]);

  const first = groups.find((g) => g.cat !== 'Recent')?.items[0] ?? groups[0]?.items[0];
  const [cat, setCat] = useState<string>(groups.find((g) => g.cat !== 'Recent')?.cat ?? groups[0]?.cat ?? 'Roblox');
  const [selected, setSelected] = useState<string | null>(initial?.width ? null : (first?.key ?? null));
  const [name, setName] = useState(initial?.name ?? (first && !initial?.width ? first.name : 'Untitled'));
  const [width, setWidth] = useState(initial?.width ?? first?.width ?? 1920);
  const [height, setHeight] = useState(initial?.height ?? first?.height ?? 1080);
  const [bg, setBg] = useState<BackgroundChoice>(initial?.background ?? bgDefault.choice);
  const [custom, setCustom] = useState(initial?.customColor ?? bgDefault.color);

  const pick = (it: Item, fromRecent: boolean) => {
    setSelected(it.key);
    setWidth(it.width);
    setHeight(it.height);
    if (!fromRecent) setName(it.name);
  };

  const valid = width >= 1 && height >= 1 && width <= MAX_DOC_SIZE && height <= MAX_DOC_SIZE;
  const submit = useDeferredSubmit(() => {
    if (!valid) return;
    close({ name: name.trim() || 'Untitled', width: Math.round(width), height: Math.round(height), background: bg, customColor: custom });
  });
  const color = backgroundColorOf({ background: bg, customColor: custom });
  const square = width === height;
  const landscape = width > height;
  const swap = () => {
    setWidth(height);
    setHeight(width);
  };
  const previewK = Math.min(150 / width, 96 / height);
  const activeGroup = groups.find((g) => g.cat === cat) ?? groups[0];
  const selectedItem = selected ? groups.flatMap((g) => g.items).find((it) => it.key === selected) : undefined;

  return (
    <Dialog
      title="New Document"
      width={720}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <div className="io-newdoc">
        <div className="io-newdoc-cats">
          {groups.map((g) => {
            const Icon = CAT_ICONS[g.cat] ?? Square;
            return (
              <button key={g.cat} className={`io-newdoc-cat${g.cat === activeGroup?.cat ? ' active' : ''}`} onClick={() => setCat(g.cat)}>
                <Icon size={14} strokeWidth={1.7} />
                <span>{g.cat}</span>
                <span className="io-count">{g.items.length}</span>
              </button>
            );
          })}
        </div>
        <div className="io-newdoc-presets">
          {activeGroup?.items.map((it) => (
            <button
              key={it.key}
              className={`io-preset${selected === it.key ? ' active' : ''}`}
              onClick={() => pick(it, activeGroup.cat === 'Recent')}
              onDoubleClick={() => {
                pick(it, activeGroup.cat === 'Recent');
                close({ name: activeGroup.cat === 'Recent' ? name : it.name, width: it.width, height: it.height, background: bg, customColor: custom });
              }}
              title={it.description}
            >
              <AspectIcon w={it.width} h={it.height} />
              <span className="io-preset-text">
                <span className="io-preset-name">{it.name}</span>
                <span className="io-preset-size">
                  {it.width} × {it.height} px
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="io-newdoc-form">
          <div className="io-form-label">Name</div>
          <TextInput value={name} onChange={setName} placeholder="Untitled" />
          <div className="io-form-row2">
            <div>
              <div className="io-form-label">Width</div>
              <NumberField
                value={width}
                min={1}
                max={MAX_DOC_SIZE}
                unit="px"
                onChange={(v) => {
                  setWidth(Math.round(v));
                  setSelected(null);
                }}
              />
            </div>
            <div>
              <div className="io-form-label">Height</div>
              <NumberField
                value={height}
                min={1}
                max={MAX_DOC_SIZE}
                unit="px"
                onChange={(v) => {
                  setHeight(Math.round(v));
                  setSelected(null);
                }}
              />
            </div>
          </div>
          <div className="io-form-label">Orientation</div>
          <div className="io-orient">
            <button
              className={`io-orient-btn${!landscape && !square ? ' active' : ''}`}
              title="Portrait"
              disabled={square}
              onClick={() => landscape && swap()}
            >
              <span style={{ width: 9, height: 13 }} />
            </button>
            <button
              className={`io-orient-btn${landscape ? ' active' : ''}`}
              title="Landscape"
              disabled={square}
              onClick={() => !landscape && !square && swap()}
            >
              <span style={{ width: 13, height: 9 }} />
            </button>
            <Button size="small" variant="ghost" icon={ArrowLeftRight} disabled={square} onClick={swap} title="Swap width and height">
              Swap
            </Button>
            {square && <span className="io-faint" style={{ fontSize: 'var(--fs-sm)' }}>Square</span>}
          </div>
          <div className="io-form-label">Background</div>
          <div className="ui-row">
            <Select value={bg} options={BG_OPTIONS} onChange={setBg} width={140} />
            {bg === 'custom' && <ColorField value={custom} onChange={setCustom} showHex />}
          </div>
          <div className="io-newdoc-preview">
            <div
              className={`io-newdoc-page${color ? '' : ' io-checker'}`}
              style={{ width: Math.max(6, width * previewK), height: Math.max(6, height * previewK), background: color ?? undefined }}
            />
            <div className="io-newdoc-info">
              {selectedItem && <div className="io-newdoc-preset-name">{selectedItem.name}</div>}
              <div>
                {Math.round(width)} × {Math.round(height)} px <span className="io-dim">· {aspectLabel(width, height)}</span>
              </div>
              {selectedItem?.description && <div className="io-dim">{selectedItem.description}</div>}
              <div className="io-dim">RGB · 8 bit · {formatBytes(width * height * 4)}</div>
              {!valid && <div className="io-error">Size must be 1–{MAX_DOC_SIZE} px</div>}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
