/**
 * History panel (id 'history'): the active document's history entries. The first entry shows a
 * document snapshot thumbnail; click an entry to jump to it; future entries are dimmed.
 */
import { useEffect, useRef } from 'react';
import { History, Redo2, Undo2 } from 'lucide-react';
import type { Document, HistoryEntry } from '../core/types';
import { activeSession, useEditor } from '../state/editor';
import { renderThumbnail } from '../render/compositor';
import { bitmaps } from '../core/bitmaps';
import { cloneCanvas } from '../core/canvas';
import { IconButton } from '../ui/controls';
import { historyIcon } from './icons';
import { CanvasView } from './thumbs';
import './panels.css';

/**
 * Document snapshots for the first history entry, keyed by the entry's (immutable) document.
 * Pixels live in mutable bitmaps that later strokes paint into, so a snapshot is only correct
 * when rendered while the bitmaps still hold that entry's state. startHistorySnapshots() renders
 * each newly committed entry right away (idle time), so once old entries are trimmed the new
 * first entry still shows its own state instead of today's pixels.
 */
const snapshots = new WeakMap<Document, HTMLCanvasElement>();
const SNAPSHOT_PX = 64;

function renderSnapshot(doc: Document): HTMLCanvasElement | null {
  try {
    const c = cloneCanvas(renderThumbnail(doc, null, SNAPSHOT_PX));
    snapshots.set(doc, c);
    return c;
  } catch {
    return null;
  }
}

function snapshotOf(e: HistoryEntry): HTMLCanvasElement | null {
  return snapshots.get(e.doc) ?? renderSnapshot(e.doc);
}

let started = false;

/** Keep a snapshot of every history state of the active document as it is committed. */
export function startHistorySnapshots() {
  if (started) return;
  started = true;
  let bitmapSeq = 0;
  bitmaps.subscribe(() => void bitmapSeq++);
  let scheduled: Document | null = null;
  const idle = (fn: () => void) =>
    typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(fn, { timeout: 400 }) : window.setTimeout(fn, 60);
  useEditor.subscribe((st) => {
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    if (!s) return;
    const { entries, index } = s.history;
    const e = entries[index];
    // Only the newest state, right after its commit (undo/redo restore older pixels via patches).
    if (!e || index !== entries.length - 1 || snapshots.has(e.doc) || scheduled === e.doc) return;
    const doc = e.doc;
    const seq = bitmapSeq;
    scheduled = doc;
    idle(() => {
      const cur = activeSession();
      const ce = cur?.history.entries[cur.history.index];
      if (!cur || !ce || ce.doc !== doc || snapshots.has(doc)) return;
      if (cur.doc !== doc) {
        // A live preview is running: try again when the store settles.
        if (scheduled === doc) scheduled = null;
        return;
      }
      // Pixels were painted since the commit: this state can no longer be rendered faithfully.
      if (bitmapSeq !== seq) return;
      renderSnapshot(doc);
    });
  });
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function HistoryPanel() {
  const history = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.history ?? null) : null));
  const docName = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.doc.name ?? '') : ''));
  const listRef = useRef<HTMLDivElement>(null);
  const index = history?.index ?? -1;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.layers-hist-row.current');
    el?.scrollIntoView({ block: 'nearest' });
  }, [index, history?.entries.length]);

  if (!history) {
    return (
      <div className="layers-hist">
        <div className="layers-empty">
          <History size={22} strokeWidth={1.4} />
          <div>No document open</div>
          <div className="layers-note">Every change you make is listed here; click a step to go back to it.</div>
        </div>
      </div>
    );
  }

  const { entries } = history;
  const jump = (i: number) => useEditor.getState().jumpToHistory(i);

  return (
    <div
      className="layers-hist"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' && index > 0) {
          e.preventDefault();
          e.stopPropagation();
          jump(index - 1);
        } else if (e.key === 'ArrowDown' && index < entries.length - 1) {
          e.preventDefault();
          e.stopPropagation();
          jump(index + 1);
        }
      }}
    >
      <div className="layers-hist-list" ref={listRef}>
        {entries.map((e, i) => {
          const Icon = historyIcon(e.label);
          const state = i === index ? 'current' : i > index ? 'future' : '';
          if (i === 0) {
            return (
              <div key={e.id} className={`layers-hist-row snapshot ${state}`} onClick={() => jump(0)} title={`${e.label} — ${timeFmt.format(e.timestamp)}`}>
                <CanvasView canvas={snapshotOf(e)} width={44} height={30} className="layers-hist-thumb" />
                <span className="layers-hist-text">
                  <span className="layers-hist-label">{docName || e.label}</span>
                  {docName && docName !== e.label && <span className="layers-hist-sub">{e.label}</span>}
                </span>
              </div>
            );
          }
          return (
            <div key={e.id} className={`layers-hist-row ${state}`} onClick={() => jump(i)} title={`${e.label} — ${timeFmt.format(e.timestamp)}`}>
              <Icon size={13} strokeWidth={1.6} />
              <span className="layers-hist-label">{e.label}</span>
            </div>
          );
        })}
      </div>
      <div className="layers-hist-foot">
        <span style={{ flex: 1 }}>
          {index + 1} / {entries.length} states
        </span>
        <IconButton icon={Undo2} size="sm" title="Step backward" disabled={index <= 0} onClick={() => useEditor.getState().undo()} />
        <IconButton icon={Redo2} size="sm" title="Step forward" disabled={index >= entries.length - 1} onClick={() => useEditor.getState().redo()} />
      </div>
    </div>
  );
}
