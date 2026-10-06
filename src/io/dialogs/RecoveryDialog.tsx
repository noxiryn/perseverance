import { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { Button, Checkbox, Dialog } from '../../ui/controls';
import { fileNameOf } from '../../platform';
import { useEditor } from '../../state/editor';
import { discardEntries, recoverEntries, recoveryTarget, type RecoveryEntry } from '../autosave';
import { formatBytes } from '../math';
import '../io.css';

function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Autosaved copies an earlier launch left behind (a crash, a forced quit, Windows shutting down).
 * Recover / Discard act on the ticked entries only; unticked ones — and everything on "Later" — stay
 * for the next start, so nothing is ever deleted without the user asking for it.
 */
export function RecoveryDialog({ close, entries }: { close: (r?: string) => void; entries: RecoveryEntry[] }) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(entries.map((e) => e.id)));
  const [busy, setBusy] = useState(false);
  // Re-render when documents open or close: an entry may belong to a project opened meanwhile.
  const sessions = useEditor((s) => s.sessions);
  const chosen = entries.filter((e) => checked.has(e.id));
  const n = chosen.length > 1 ? ` ${chosen.length}` : '';

  const recover = async () => {
    setBusy(true);
    await recoverEntries(chosen);
    close('recover');
  };
  const discard = async () => {
    setBusy(true);
    await discardEntries(chosen);
    close('discard');
  };

  return (
    <Dialog
      title={
        <span className="ui-row">
          <LifeBuoy size={16} /> Recover unsaved documents?
        </span>
      }
      width={500}
      onClose={() => close()}
      onSubmit={chosen.length && !busy ? recover : undefined}
      footer={
        <>
          <Button variant="danger" disabled={busy || !chosen.length} onClick={discard} title="Delete the ticked autosaved copies">
            {`Discard${n}`}
          </Button>
          <span style={{ flex: 1 }} />
          <Button disabled={busy} onClick={() => close()} title="Keep the autosaved copies and decide the next time Perseverance starts">
            Later
          </Button>
          <Button variant="primary" disabled={busy || !chosen.length} onClick={recover}>
            {busy ? 'Recovering…' : `Recover${n}`}
          </Button>
        </>
      }
    >
      <div className="io-note">
        Perseverance closed before these documents were saved. Autosaved copies were found — recover them to continue where you left off.
        {entries.length > 1 ? ' Unticked copies are kept for later.' : ''}
      </div>
      <div className="io-recover-list">
        {entries.map((e) => {
          const target = recoveryTarget(e, sessions);
          const file = typeof e.filePath === 'string' && e.filePath ? fileNameOf(e.filePath) : null;
          return (
            <div key={e.id} className="io-recover-item">
              <Checkbox
                checked={checked.has(e.id)}
                onChange={(v) =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(e.id);
                    else next.delete(e.id);
                    return next;
                  })
                }
              />
              <div className="io-recover-thumb">{e.thumb ? <img src={e.thumb} alt="" /> : <span className="io-checker" />}</div>
              <div style={{ minWidth: 0 }}>
                <div className="io-recover-name">{e.name}</div>
                <div className="io-recover-meta" title={e.filePath ?? undefined}>
                  {file ? `${file} · ` : ''}
                  {e.width} × {e.height} px · autosaved {ago(e.time)} · {formatBytes(e.data.byteLength)}
                </div>
                {target && (
                  <div className="io-recover-open">
                    Open now as “{target.doc.name}” — recovering adds these changes to it as a step (Edit ▸ Undo goes back).
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
