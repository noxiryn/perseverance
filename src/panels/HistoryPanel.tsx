/**
 * History panel (id 'history'): the active document's history entries. The first entry shows a
 * document snapshot thumbnail; click an entry to jump to it; future entries are dimmed.
 */
import { useEffect, useRef } from 'react';
import { History, Redo2, Undo2 } from 'lucide-react';
import type { HistoryEntry } from '../core/types';
import { useEditor } from '../state/editor';
import { renderThumbnail } from '../render/compositor';
import { cloneCanvas } from '../core/canvas';
import { IconButton } from '../ui/controls';
import { historyIcon } from './icons';
import { CanvasView } from './thumbs';
import './panels.css';

/** Snapshot thumbnails of first entries (rendered once, when first seen). */
const snapshots = new WeakMap<HistoryEntry, HTMLCanvasElement>();

function snapshotOf(e: HistoryEntry): HTMLCanvasElement | null {
  let c = snapshots.get(e) ?? null;
  if (!c) {
    try {
      c = cloneCanvas(renderThumbnail(e.doc, null, 64));
      snapshots.set(e, c);
    } catch {
      return null;
    }
  }
  return c;
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
                <span className="layers-hist-label">{docName || e.label}</span>
                <span className="layers-hist-time">{e.label}</span>
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
