/**
 * Best-effort Roblox avatar fetch by username:
 *   POST users.roblox.com/v1/usernames/users → user id
 *   GET  thumbnails.roblox.com/v1/users/avatar[-bust|-headshot] → image URL (retries while Pending)
 *   GET  image → Blob
 * Every request has a timeout and honours an abort signal, so the UI never hangs. Network / CORS
 * failures are reported as AvatarError('network') so the UI can explain the manual fallback.
 */

export type AvatarKind = 'full' | 'bust' | 'headshot';

export const AVATAR_KINDS: { value: AvatarKind; label: string; endpoint: string; size: string }[] = [
  { value: 'full', label: 'Full body', endpoint: 'avatar', size: '720x720' },
  { value: 'bust', label: 'Bust', endpoint: 'avatar-bust', size: '420x420' },
  { value: 'headshot', label: 'Headshot', endpoint: 'avatar-headshot', size: '720x720' },
];

export type AvatarErrorKind = 'invalid' | 'notFound' | 'network' | 'timeout' | 'blocked' | 'pending' | 'server' | 'aborted';

export class AvatarError extends Error {
  constructor(
    readonly kind: AvatarErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AvatarError';
  }
}

export interface AvatarResult {
  userId: number;
  name: string;
  displayName: string;
  imageUrl: string;
  blob: Blob;
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Delay between "Pending" retries (ms). */
  retryDelayMs?: number;
  onStatus?: (msg: string) => void;
}

/** Roblox usernames: 3–20 characters, letters, digits and at most one underscore (not at the ends). */
export function validateUsername(raw: string): string | null {
  const name = raw.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return null;
  if (name.startsWith('_') || name.endsWith('_') || (name.match(/_/g)?.length ?? 0) > 1) return null;
  return name;
}

export function thumbnailUrl(userId: number, kind: AvatarKind): string {
  const k = AVATAR_KINDS.find((x) => x.value === kind) ?? AVATAR_KINDS[0];
  return `https://thumbnails.roblox.com/v1/users/${k.endpoint}?userIds=${userId}&size=${k.size}&format=Png&isCircular=false`;
}

export function profileUrl(name: string): string {
  return `https://www.roblox.com/users/profile?username=${encodeURIComponent(name)}`;
}

async function request(url: string, init: RequestInit, opts: FetchOptions, what: string): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) throw new AvatarError('aborted', 'Cancelled.');
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? 12000);
  try {
    const res = await f(url, { ...init, signal: ctrl.signal });
    return res;
  } catch (err) {
    if (timedOut) throw new AvatarError('timeout', `${what} timed out.`);
    if (opts.signal?.aborted) throw new AvatarError('aborted', 'Cancelled.');
    throw new AvatarError('network', `${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

async function json(res: Response, what: string): Promise<unknown> {
  if (res.status === 429) throw new AvatarError('server', 'Roblox is rate-limiting requests — wait a minute and try again.');
  if (!res.ok) throw new AvatarError('server', `${what} returned HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new AvatarError('server', `${what} returned an unexpected response.`);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AvatarError('aborted', 'Cancelled.'));
      },
      { once: true },
    );
  });

export async function fetchAvatar(username: string, kind: AvatarKind, opts: FetchOptions = {}): Promise<AvatarResult> {
  const name = validateUsername(username);
  if (!name) throw new AvatarError('invalid', 'Enter a valid Roblox username (3–20 letters, numbers or one underscore).');

  opts.onStatus?.('Looking up user…');
  const userRes = await request(
    'https://users.roblox.com/v1/usernames/users',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }) },
    opts,
    'User lookup',
  );
  const users = (await json(userRes, 'User lookup')) as { data?: { id?: number; name?: string; displayName?: string }[] };
  const user = users.data?.[0];
  if (!user || typeof user.id !== 'number') throw new AvatarError('notFound', `No Roblox user named “${name}”.`);

  let imageUrl = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    opts.onStatus?.(attempt ? 'Avatar render is being generated…' : 'Requesting avatar render…');
    const res = await request(thumbnailUrl(user.id, kind), { headers: { Accept: 'application/json' } }, opts, 'Avatar render request');
    const body = (await json(res, 'Avatar render request')) as { data?: { state?: string; imageUrl?: string | null }[] };
    const item = body.data?.[0];
    const state = item?.state ?? 'Error';
    if (state === 'Completed' && item?.imageUrl) {
      imageUrl = item.imageUrl;
      break;
    }
    if (state === 'Blocked') throw new AvatarError('blocked', 'This avatar render is not available (moderated or blocked).');
    if (state !== 'Pending') throw new AvatarError('server', 'Roblox could not render this avatar right now.');
    await sleep(opts.retryDelayMs ?? 1500, opts.signal);
  }
  if (!imageUrl) throw new AvatarError('pending', 'The avatar render is still being generated — try again in a few seconds.');

  opts.onStatus?.('Downloading image…');
  const imgRes = await request(imageUrl, {}, opts, 'Image download');
  if (!imgRes.ok) throw new AvatarError('server', `Image download returned HTTP ${imgRes.status}.`);
  const blob = await imgRes.blob();
  if (blob.size === 0 || (blob.type && !blob.type.startsWith('image/'))) throw new AvatarError('server', 'The downloaded file is not an image.');
  return { userId: user.id, name: user.name ?? name, displayName: user.displayName ?? user.name ?? name, imageUrl, blob };
}

/** User-facing explanation for an error (with the manual fallback for network/CORS problems). */
export function describeAvatarError(err: unknown, username: string): { title: string; detail: string; fallback: boolean } {
  const e = err instanceof AvatarError ? err : new AvatarError('network', err instanceof Error ? err.message : String(err));
  if (e.kind === 'network' || e.kind === 'timeout') {
    return {
      title: e.kind === 'timeout' ? 'Roblox did not respond in time.' : 'Could not reach Roblox from the app (offline or blocked by CORS).',
      detail: `Open ${username ? `${username}'s profile` : 'the profile'} in your browser, right-click the avatar render → “Save image as…”, then drag the PNG into Perseverance (or use File ▸ Place Image).`,
      fallback: true,
    };
  }
  return { title: e.message, detail: '', fallback: e.kind === 'server' || e.kind === 'pending' };
}
