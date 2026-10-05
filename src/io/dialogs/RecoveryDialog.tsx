import { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { Button, Checkbox, Dialog } from '../../ui/controls';
import { discardEntries, recoverEntries, type RecoveryEntry } from '../autosave';
import { formatBytes } from '../math';
import '../io.css';

function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function RecoveryDialog({ close, entries }: { close: (r?: string) => void; entries: RecoveryEntry[] }) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(entries.map((e) => e.id)));
  const [busy, setBusy] = useState(false);
  const chosen = entries.filter((e) => checked.has(e.id));

  const recover = async () => {
    setBusy(true);
    const rest = entries.filter((e) => !checked.has(e.id));
    await recoverEntries(chosen);
    await discardEntries(rest);
    close('recover');
  };
  const discard = async () => {
    setBusy(true);
    await discardEntries(entries);
    close('discard');
  };

  return (
    <Dialog
      title={
        <span className="ui-row">
          <LifeBuoy size={16} /> Recover unsaved documents?
        </span>
      }
      width={480}
      onClose={() => close()}
      onSubmit={chosen.length && !busy ? recover : undefined}
      footer={
        <>
          <Button variant="danger" disabled={busy} onClick={discard}>
            Discard
          </Button>
          <span style={{ flex: 1 }} />
          <Button disabled={busy} onClick={() => close()}>
            Later
          </Button>
          <Button variant="primary" disabled={busy || !chosen.length} onClick={recover}>
            {busy ? 'Recovering…' : `Recover${chosen.length > 1 ? ` ${chosen.length}` : ''}`}
          </Button>
        </>
      }
    >
      <div className="io-note">
        Perseverance closed before these documents were saved. Autosaved copies were found — recover them to continue where you left off.
      </div>
      <div className="io-recover-list">
        {entries.map((e) => (
          <div key={e.id} className="io-recover-item">
            <Checkbox
              checked={checked.has(e.id)}
              onChange={(v) =>
                setChecked((prev) => {
                  const n = new Set(prev);
                  if (v) n.add(e.id);
                  else n.delete(e.id);
                  return n;
                })
              }
            />
            <div className="io-recover-thumb">{e.thumb ? <img src={e.thumb} alt="" /> : <span className="io-checker" />}</div>
            <div style={{ minWidth: 0 }}>
              <div className="io-recover-name">{e.name}</div>
              <div className="io-recover-meta">
                {e.width} × {e.height} px · autosaved {ago(e.time)} · {formatBytes(e.data.byteLength)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
