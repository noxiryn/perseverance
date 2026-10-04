/**
 * Document tabs: "Name * RGB/8" with close button (unsaved-changes confirmation), middle-click
 * close, context menu, drag to reorder, horizontal overflow scrolling.
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { commands, runCommand } from '../../registry';
import { desktop } from '../../platform';
import { useEditor } from '../../state/editor';
import { showContextMenu } from '../controls';
import { closeOtherDocuments, quickCreate, requestCloseDocument } from './documents';

const TAB_MIME = 'application/x-perseverance-tab';

interface TabInfo {
  id: string;
  name: string;
  dirty: boolean;
  path: string | null;
  w: number;
  h: number;
}

function useTabs(): TabInfo[] {
  const raw = useEditor(
    useShallow((s) =>
      s.docOrder.map((id) => {
        const se = s.sessions[id];
        return se ? `${id}\u0000${se.doc.name}\u0000${se.dirty ? 1 : 0}\u0000${se.filePath ?? ''}\u0000${se.doc.width}\u0000${se.doc.height}` : '';
      }),
    ),
  );
  return raw.filter(Boolean).map((r) => {
    const [id, name, dirty, path, w, h] = r.split('\u0000');
    return { id, name, dirty: dirty === '1', path: path || null, w: Number(w), h: Number(h) };
  });
}

export function DocTabs() {
  const tabs = useTabs();
  const activeId = useEditor((s) => s.activeDocId);
  const scroller = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState<{ id: string; after: boolean } | null>(null);

  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-doc="${activeId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  const reorder = (dragId: string, targetId: string, after: boolean) => {
    if (dragId === targetId) return;
    const order = useEditor.getState().docOrder.filter((d) => d !== dragId);
    const i = order.indexOf(targetId);
    if (i < 0) return;
    order.splice(after ? i + 1 : i, 0, dragId);
    useEditor.setState({ docOrder: order });
  };

  const menuFor = (e: React.MouseEvent, t: TabInfo) => {
    showContextMenu(e, [
      { label: 'Close', shortcut: 'Ctrl+W', run: () => void requestCloseDocument(t.id) },
      { label: 'Close Others', disabled: tabs.length < 2, run: () => void closeOtherDocuments(t.id) },
      { label: 'Close All', run: () => void closeOtherDocuments(null) },
      { separator: true },
      {
        label: 'Duplicate',
        disabled: !commands.has('image.duplicate'),
        run: () => {
          useEditor.getState().setActiveDoc(t.id);
          void runCommand('image.duplicate');
        },
      },
      ...(desktop && t.path ? [{ label: 'Reveal in Folder', run: () => desktop!.showItemInFolder(t.path!) }] : []),
    ]);
  };

  if (!tabs.length) return <div className="shell-tabs shell-tabs-empty" />;

  return (
    <div className="shell-tabs">
      <div
        className="shell-tabs-scroll"
        ref={scroller}
        onWheel={(e) => {
          if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t) => (
          <div
            key={t.id}
            data-doc={t.id}
            className={[
              'shell-tab',
              t.id === activeId && 'active',
              dragOver?.id === t.id && (dragOver.after ? 'drop-after' : 'drop-before'),
            ]
              .filter(Boolean)
              .join(' ')}
            title={`${t.path ?? t.name} — ${t.w}×${t.h}px`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_MIME, t.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(TAB_MIME)) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setDragOver({ id: t.id, after: e.clientX > r.left + r.width / 2 });
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(TAB_MIME);
              if (!id) return;
              e.preventDefault();
              e.stopPropagation();
              reorder(id, t.id, !!dragOver?.after);
              setDragOver(null);
            }}
            onDragEnd={() => setDragOver(null)}
            onPointerDown={(e) => {
              if (e.button === 1) e.preventDefault(); // no autoscroll
              if (e.button === 0) useEditor.getState().setActiveDoc(t.id);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void requestCloseDocument(t.id);
              }
            }}
            onContextMenu={(e) => menuFor(e, t)}
          >
            <span className="shell-tab-name">
              {t.name}
              {t.dirty && <span className="shell-tab-dirty"> *</span>}
            </span>
            <span className="shell-tab-mode">RGB/8</span>
            <button
              className="shell-tab-close"
              title="Close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void requestCloseDocument(t.id);
              }}
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="shell-tab-new"
        title="New document"
        onClick={() => (commands.has('file.new') ? runCommand('file.new') : quickCreate({ name: 'Untitled', width: 1920, height: 1080 }))}
      >
        <Plus size={13} strokeWidth={1.8} />
      </button>
    </div>
  );
}
