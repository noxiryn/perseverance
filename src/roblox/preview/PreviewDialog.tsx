/**
 * Roblox Preview: shows the current document inside a generic, logo-free mock of a game discovery
 * page — tile cards at real on-screen sizes, small icons, a wide 16:9 tile and a game page header —
 * in dark or light theme, to check readability at small sizes.
 */
import { useMemo, useState } from 'react';
import { Moon, Play, Sun, ThumbsUp, Users } from 'lucide-react';
import { Button, Dialog, TextInput } from '../../ui/controls';
import { activeDoc } from '../../state/editor';
import { openDialog } from '../../state/ui';
import { createCanvas, ctx2d } from '../../core/canvas';
import { rng } from '../../core/noise';
import { renderDocument } from '../../render/compositor';
import type { Document } from '../../core/types';
import '../roblox.css';
import { ICON_CORNER } from './safeZones';

interface Art {
  icon: string;
  thumb: string;
  isSquare: boolean;
  isWide: boolean;
}

/** Center-crop (cover) the composite into a w×h image. */
function cover(src: HTMLCanvasElement, w: number, h: number): string {
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  const s = Math.max(w / src.width, h / src.height);
  const dw = src.width * s,
    dh = src.height * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return c.toDataURL('image/png');
}

function makeArt(doc: Document): Art {
  const scale = Math.min(1, 1280 / Math.max(doc.width, doc.height));
  const comp = renderDocument(doc, { scale, background: true });
  // Flatten over white (exports default to a white/opaque background).
  const flat = createCanvas(comp.width, comp.height);
  const fctx = ctx2d(flat);
  fctx.fillStyle = doc.background ?? '#ffffff';
  fctx.fillRect(0, 0, flat.width, flat.height);
  fctx.drawImage(comp, 0, 0);
  const r = doc.width / doc.height;
  return {
    icon: cover(flat, 512, 512),
    thumb: cover(flat, 1280, 720),
    isSquare: Math.abs(r - 1) < 0.02,
    isWide: Math.abs(r - 16 / 9) < 0.04,
  };
}

const NEIGHBORS = [
  { name: 'Mega Obby Rush', like: 91, players: '12.4K', hue: 205 },
  { name: 'Tycoon Tales', like: 87, players: '8.1K', hue: 35 },
  { name: 'Pet Valley Simulator', like: 93, players: '31.2K', hue: 135 },
  { name: 'Sword Arena', like: 84, players: '4.7K', hue: 0 },
  { name: 'Night Shift Horror', like: 89, players: '6.3K', hue: 270 },
];

/** Procedural placeholder art for neighbouring (fake) games. */
function neighborArt(seed: number, hue: number, w: number, h: number): string {
  const c = createCanvas(w, h);
  const g = ctx2d(c);
  const R = rng(seed * 977 + 13);
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue} 70% 58%)`);
  grad.addColorStop(1, `hsl(${(hue + 40) % 360} 65% 28%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 7; i++) {
    g.fillStyle = `hsla(${(hue + R() * 80) % 360} 80% ${40 + R() * 40}% / ${0.25 + R() * 0.4})`;
    const s = (0.15 + R() * 0.35) * Math.min(w, h);
    g.save();
    g.translate(R() * w, R() * h);
    g.rotate(R() * Math.PI);
    g.fillRect(-s / 2, -s / 2, s, s);
    g.restore();
  }
  // Blocky figure silhouette
  const u = Math.min(w, h) / 7;
  const cx = w * (0.35 + R() * 0.3),
    by = h * 0.92;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(cx - u, by - u * 2, u * 0.95, u * 2);
  g.fillRect(cx + u * 0.05, by - u * 2, u * 0.95, u * 2);
  g.fillRect(cx - u, by - u * 4, u * 2, u * 2);
  g.fillRect(cx - u * 2, by - u * 4, u * 0.95, u * 2);
  g.fillRect(cx + u * 1.05, by - u * 4, u * 0.95, u * 2);
  g.beginPath();
  g.roundRect(cx - u * 0.62, by - u * 5.3, u * 1.24, u * 1.25, u * 0.3);
  g.fill();
  return c.toDataURL('image/png');
}

let lastTitle = '';
let lastCreator = 'YourStudio';
let lastTheme: 'dark' | 'light' = 'dark';

function Tile({ img, size, title, like, players, radius = ICON_CORNER, highlight }: { img: string; size: number; title: string; like: number; players: string; radius?: number; highlight?: boolean }) {
  return (
    <div className={`rbxp-tile${highlight ? ' mine' : ''}`} style={{ width: size }}>
      <img src={img} alt="" style={{ width: size, height: size, borderRadius: size * radius }} draggable={false} />
      <div className="rbxp-tile-title" title={title}>
        {title}
      </div>
      <div className="rbxp-tile-stats">
        <span>
          <ThumbsUp size={11} /> {like}%
        </span>
        <span>
          <Users size={11} /> {players}
        </span>
      </div>
    </div>
  );
}

export function PreviewDialog({ close }: { close: (r?: unknown) => void }) {
  const doc = activeDoc();
  const art = useMemo(() => {
    if (!doc) return null;
    try {
      return makeArt(doc);
    } catch (err) {
      console.error('Roblox preview render failed', err);
      return null;
    }
  }, [doc]);
  const neighbors = useMemo(() => NEIGHBORS.map((n, i) => ({ ...n, icon: neighborArt(i + 1, n.hue, 256, 256), thumb: neighborArt(i + 11, n.hue, 480, 270) })), []);
  const [theme, setTheme] = useState<'dark' | 'light'>(lastTheme);
  const [title, setTitle] = useState(lastTitle || doc?.name || 'My Awesome Game');
  const [creator, setCreator] = useState(lastCreator);
  const like = 94;
  const players = '2,481';

  const done = () => {
    lastTitle = title;
    lastCreator = creator;
    lastTheme = theme;
    close();
  };

  if (!doc || !art) {
    return (
      <Dialog title="Roblox Preview" onClose={() => close()} footer={<Button onClick={() => close()}>Close</Button>}>
        <div className="ui-empty">Open a document to preview it.</div>
      </Dialog>
    );
  }

  const formatNote = art.isSquare
    ? 'Square document → shown as the game icon (and center-cropped as a 16:9 thumbnail).'
    : art.isWide
      ? '16:9 document → shown as the thumbnail (and center-cropped for icon slots).'
      : 'Non-standard ratio — icons use a centered square crop, thumbnails a centered 16:9 crop.';

  return (
    <Dialog
      title="Roblox Preview"
      width="min(1240px, 94vw)"
      onClose={done}
      footer={
        <div className="roblox-foot">
          <span className="info">{formatNote} Mock UI for readability checks — not affiliated with Roblox.</span>
          <Button variant="primary" onClick={done}>
            Done
          </Button>
        </div>
      }
    >
      <div className="rbxp-controls">
        <div className="roblox-seg">
          <button className={theme === 'dark' ? 'active' : undefined} onClick={() => setTheme('dark')}>
            <Moon size={12} /> Dark
          </button>
          <button className={theme === 'light' ? 'active' : undefined} onClick={() => setTheme('light')}>
            <Sun size={12} /> Light
          </button>
        </div>
        <span className="ui-label">Title</span>
        <div style={{ width: 260 }}>
          <TextInput value={title} onChange={setTitle} placeholder="Game title" />
        </div>
        <span className="ui-label">Creator</span>
        <div style={{ width: 160 }}>
          <TextInput value={creator} onChange={setCreator} placeholder="Creator" />
        </div>
      </div>
      <div className={`rbxp rbxp-${theme}`}>
        <div className="rbxp-section">
          <div className="rbxp-h">Recommended For You</div>
          <div className="rbxp-row">
            <Tile img={neighbors[0].icon} size={150} title={neighbors[0].name} like={neighbors[0].like} players={neighbors[0].players} />
            <Tile img={art.icon} size={150} title={title} like={like} players={players} highlight />
            {neighbors.slice(1, 5).map((n) => (
              <Tile key={n.name} img={n.icon} size={150} title={n.name} like={n.like} players={n.players} />
            ))}
          </div>
        </div>

        <div className="rbxp-split">
          <div className="rbxp-section">
            <div className="rbxp-h">Small sizes</div>
            <div className="rbxp-row" style={{ alignItems: 'flex-end' }}>
              {[100, 75, 50].map((s) => (
                <div key={s} className="rbxp-small">
                  <img src={art.icon} alt="" style={{ width: s, height: s, borderRadius: s * ICON_CORNER }} draggable={false} />
                  <span>{s}px</span>
                </div>
              ))}
              <div className="rbxp-small">
                <img src={art.icon} alt="" style={{ width: 64, height: 64, borderRadius: '50%' }} draggable={false} />
                <span>badge</span>
              </div>
            </div>
            <div className="rbxp-list">
              {[neighbors[2], { name: title, icon: art.icon, like, players, mine: true }, neighbors[3]].map((n) => (
                <div key={n.name} className={`rbxp-list-row${'mine' in n ? ' mine' : ''}`}>
                  <img src={n.icon} alt="" style={{ width: 48, height: 48, borderRadius: 48 * ICON_CORNER }} draggable={false} />
                  <div>
                    <div className="rbxp-tile-title">{n.name}</div>
                    <div className="rbxp-tile-stats">
                      <span>
                        <ThumbsUp size={11} /> {n.like}%
                      </span>
                      <span>
                        <Users size={11} /> {n.players}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rbxp-section">
            <div className="rbxp-h">Wide tiles</div>
            <div className="rbxp-row">
              {[{ img: art.thumb, name: title, mine: true }, { img: neighbors[4].thumb, name: neighbors[4].name, mine: false }].map((t) => (
                <div key={t.name} className={`rbxp-wide${t.mine ? ' mine' : ''}`}>
                  <img src={t.img} alt="" draggable={false} />
                  <div className="rbxp-wide-band">
                    <div className="rbxp-tile-title">{t.name}</div>
                    <div className="rbxp-tile-stats">
                      <span>
                        <ThumbsUp size={11} /> {t.mine ? like : neighbors[4].like}%
                      </span>
                      <span>
                        <Users size={11} /> {t.mine ? players : neighbors[4].players}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rbxp-section">
          <div className="rbxp-h">Game page</div>
          <div className="rbxp-page">
            <div className="rbxp-page-media">
              <img src={art.thumb} alt="" draggable={false} />
              <span className="rbxp-arrow left">‹</span>
              <span className="rbxp-arrow right">›</span>
              <span className="rbxp-dots">
                <i className="on" />
                <i />
                <i />
              </span>
            </div>
            <div className="rbxp-page-info">
              <img src={art.icon} alt="" className="rbxp-page-icon" draggable={false} />
              <div className="rbxp-page-title">{title}</div>
              <div className="rbxp-page-by">
                By <b>{creator || 'Creator'}</b>
              </div>
              <button className="rbxp-play" type="button" tabIndex={-1}>
                <Play size={22} fill="currentColor" />
              </button>
              <div className="rbxp-page-stats">
                <div>
                  <b>{players}</b>
                  <span>Active</span>
                </div>
                <div>
                  <b>{like}%</b>
                  <span>Rating</span>
                </div>
                <div>
                  <b>1.2M</b>
                  <span>Visits</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export function openRobloxPreview() {
  return openDialog(PreviewDialog);
}
