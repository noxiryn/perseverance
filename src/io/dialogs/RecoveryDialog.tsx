import { useMemo, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { Button, Checkbox, Dialog } from '../../ui/controls';
import { fileNameOf } from '../../platform';
import { useEditor } from '../../state/editor';
import { discardEntries, recoverEntries, recoveryTarget, savedAfter, type RecoveryInfo } from '../autosave';
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
 *
 * A copy older than the last save of its project (kept with "Later", then the project was reopened,
 * edited and saved) starts unticked, says so, isn't recovered by Enter, and recovers as a separate
 * unsaved document — never over the newer file (recoverEntries).
 */
export function RecoveryDialog({ close, entries }: { close: (r?: string) => void; entries: RecoveryInfo[] }) {
  // When each entry's project was saved after it (null: it wasn't).
  const older = useMemo(() => new Map(entries.map((e) => [e.id, savedAfter(e)])), [entries]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(entries.filter((e) => older.get(e.id) == null).map((e) => e.id)));
  const [busy, setBusy] = useState(false);
  // Re-render when documents open or close: an entry may belong to a project opened meanwhile.
  const sessions = useEditor((s) => s.sessions);
  const chosen = entries.filter((e) => checked.has(e.id));
  const n = chosen.length > 1 ? ` ${chosen.length}` : '';
  const allOlder = entries.every((e) => older.get(e.id) != null);
  const someOlder = entries.some((e) => older.get(e.id) != null);
  // Enter recovers only when a copy that is newer than its saved file is ticked.
  const enterRecovers = chosen.some((e) => older.get(e.id) == null);

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
      onSubmit={enterRecovers && !busy ? recover : undefined}
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
        {allOlder
          ? `${entries.length > 1 ? 'These autosaved copies are' : 'This autosaved copy is'} older than the version of the project you saved since. Recovering opens a separate unsaved copy — your saved file stays as it is.`
          : 'Perseverance closed before these documents were saved. Autosaved copies were found — recover them to continue where you left off.'}
        {!allOlder && someOlder ? ' Copies older than their saved project are unticked and open as separate copies.' : ''}
        {entries.length > 1 ? ' Unticked copies are kept for later.' : ''}
      </div>
      <div className="io-recover-list">
        {entries.map((e) => {
          const savedAt = older.get(e.id) ?? null;
          const target = savedAt == null ? recoveryTarget(e, sessions) : null;
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
                  {e.width} × {e.height} px · autosaved {ago(e.time)} · {formatBytes(e.bytes)}
                </div>
                {savedAt != null && (
                  <div className="io-recover-open io-recover-older" data-older="">
                    Older than the version you saved {ago(savedAt)} — opens as a separate unsaved copy.
                  </div>
                )}
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
