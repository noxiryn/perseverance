/** Fetch Avatar dialog: username → avatar render (full body / bust / headshot) → placed as a layer. */
import { useEffect, useRef, useState } from 'react';
import { CloudDownload, ExternalLink, ImagePlus } from 'lucide-react';
import { Button, Dialog, Field, TextInput } from '../../ui/controls';
import { activeDoc } from '../../state/editor';
import { openDialog, toast } from '../../state/ui';
import { openExternal } from '../../platform';
import { placeImageBlob } from '../../io/open';
import '../roblox.css';
import { Hint, Seg } from '../studio/ui';
import { newTransparentDocument } from '../util';
import { AVATAR_KINDS, describeAvatarError, fetchAvatar, profileUrl, validateUsername, type AvatarKind, type AvatarResult } from './fetch';

let lastName = '';
let lastKind: AvatarKind = 'full';

export function AvatarDialog({ close }: { close: (r?: unknown) => void }) {
  const [name, setName] = useState(lastName);
  const [kind, setKind] = useState<AvatarKind>(lastKind);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof describeAvatarError> | null>(null);
  const [result, setResult] = useState<AvatarResult | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!result) return;
    const u = URL.createObjectURL(result.blob);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [result]);

  const busy = status !== null;
  const valid = !!validateUsername(name);

  const run = async () => {
    if (busy) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setError(null);
    setResult(null);
    setStatus('Connecting…');
    lastName = name;
    lastKind = kind;
    try {
      const r = await fetchAvatar(name, kind, { signal: ctrl.signal, onStatus: setStatus });
      if (!ctrl.signal.aborted) setResult(r);
    } catch (err) {
      if (!ctrl.signal.aborted) setError(describeAvatarError(err, validateUsername(name) ?? name.trim()));
    } finally {
      if (abort.current === ctrl) setStatus(null);
    }
  };

  const place = async () => {
    if (!result) return;
    try {
      if (!activeDoc()) newTransparentDocument(`${result.name} Avatar`, 1024, 1024);
      await placeImageBlob(result.blob, `${result.displayName} (${AVATAR_KINDS.find((k) => k.value === kind)?.label ?? 'Avatar'})`);
      close(true);
    } catch (err) {
      console.error('Placing avatar failed', err);
      toast('Could not place the avatar image.', 'error');
    }
  };

  const cleanName = validateUsername(name) ?? name.trim();

  return (
    <Dialog
      title="Fetch Roblox Avatar"
      width={460}
      onClose={() => close()}
      onSubmit={result ? place : valid ? run : undefined}
      footer={
        <>
          <Button onClick={() => close()}>{result ? 'Cancel' : 'Close'}</Button>
          {result ? (
            <Button variant="primary" icon={ImagePlus} onClick={place}>
              Place in Document
            </Button>
          ) : (
            <Button variant="primary" icon={CloudDownload} onClick={run} disabled={!valid || busy}>
              {busy ? 'Fetching…' : 'Fetch Avatar'}
            </Button>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Username">
          <TextInput value={name} onChange={(v) => { setName(v); setResult(null); setError(null); }} placeholder="e.g. Builderman" />
        </Field>
        <Field label="Render">
          <Seg value={kind} options={AVATAR_KINDS.map((k) => ({ value: k.value, label: k.label }))} onChange={(k) => { setKind(k); setResult(null); }} />
        </Field>
        {status && <div className="roblox-avatar-status">{status}</div>}
        {error && (
          <div className="roblox-avatar-error">
            <div className="title">{error.title}</div>
            {error.detail && <div>{error.detail}</div>}
            {error.fallback && cleanName && (
              <Button size="small" icon={ExternalLink} onClick={() => openExternal(profileUrl(cleanName))}>
                Open profile in browser
              </Button>
            )}
          </div>
        )}
        {result && preview && (
          <div className="roblox-avatar-result">
            <img src={preview} alt={result.displayName} />
            <div>
              <div className="name">{result.displayName}</div>
              <div className="sub">@{result.name} · id {result.userId}</div>
              <Hint>Transparent PNG render. After placing, try Remove Background ▸ Auto to clean edges, or a Character Styler style.</Hint>
            </div>
          </div>
        )}
        {!result && !error && !status && (
          <Hint>
            Downloads the public avatar render from Roblox (needs internet). If it is blocked, save the render from your browser and drag it into the app.
          </Hint>
        )}
      </div>
    </Dialog>
  );
}

export function openAvatarFetch() {
  return openDialog(AvatarDialog);
}
