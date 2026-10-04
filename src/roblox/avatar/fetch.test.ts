import { describe, expect, it } from 'vitest';
import { AvatarError, describeAvatarError, fetchAvatar, thumbnailUrl, validateUsername } from './fetch';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'Content-Type': 'image/png' } });

describe('usernames', () => {
  it('validates Roblox username rules', () => {
    expect(validateUsername('Builderman')).toBe('Builderman');
    expect(validateUsername('  @roblox_fan ')).toBe('roblox_fan');
    expect(validateUsername('ab')).toBeNull();
    expect(validateUsername('a'.repeat(21))).toBeNull();
    expect(validateUsername('_lead')).toBeNull();
    expect(validateUsername('trail_')).toBeNull();
    expect(validateUsername('two_under_s')).toBeNull();
    expect(validateUsername('bad name')).toBeNull();
  });

  it('builds thumbnail URLs for each render kind', () => {
    expect(thumbnailUrl(42, 'full')).toBe('https://thumbnails.roblox.com/v1/users/avatar?userIds=42&size=720x720&format=Png&isCircular=false');
    expect(thumbnailUrl(42, 'headshot')).toContain('/avatar-headshot?userIds=42');
    expect(thumbnailUrl(42, 'bust')).toContain('/avatar-bust?userIds=42');
  });
});

describe('fetchAvatar', () => {
  it('looks up the user, waits for a pending render and downloads the PNG', async () => {
    let thumbCalls = 0;
    let lookupBody: unknown = null;
    const f = mockFetch((url, init) => {
      if (url.startsWith('https://users.roblox.com/v1/usernames/users')) {
        expect(init?.method).toBe('POST');
        lookupBody = JSON.parse(String(init?.body));
        return json({ data: [{ id: 156, name: 'Builderman', displayName: 'Builder' }] });
      }
      if (url.startsWith('https://thumbnails.roblox.com/')) {
        thumbCalls++;
        return json({ data: [thumbCalls < 2 ? { state: 'Pending', imageUrl: null } : { state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/x.png' }] });
      }
      if (url === 'https://tr.rbxcdn.com/x.png') return png();
      throw new Error(`unexpected ${url}`);
    });
    const statuses: string[] = [];
    const r = await fetchAvatar('Builderman', 'full', { fetchImpl: f, retryDelayMs: 1, onStatus: (s) => statuses.push(s) });
    expect(lookupBody).toEqual({ usernames: ['Builderman'], excludeBannedUsers: false });
    expect(r).toMatchObject({ userId: 156, name: 'Builderman', displayName: 'Builder', imageUrl: 'https://tr.rbxcdn.com/x.png' });
    expect(r.blob.size).toBe(4);
    expect(thumbCalls).toBe(2);
    expect(statuses.length).toBeGreaterThanOrEqual(3);
  });

  it('reports unknown users', async () => {
    const f = mockFetch(() => json({ data: [] }));
    await expect(fetchAvatar('NoSuchUser', 'full', { fetchImpl: f })).rejects.toMatchObject({ kind: 'notFound' });
  });

  it('rejects invalid usernames without any request', async () => {
    let called = false;
    const f = mockFetch(() => {
      called = true;
      return json({});
    });
    await expect(fetchAvatar('x', 'full', { fetchImpl: f })).rejects.toMatchObject({ kind: 'invalid' });
    expect(called).toBe(false);
  });

  it('maps network/CORS failures to a network error', async () => {
    const f = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    await expect(fetchAvatar('Builderman', 'full', { fetchImpl: f })).rejects.toMatchObject({ kind: 'network' });
  });

  it('times out instead of hanging', async () => {
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(fetchAvatar('Builderman', 'full', { fetchImpl: f, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('can be cancelled', async () => {
    const ctrl = new AbortController();
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const p = fetchAvatar('Builderman', 'full', { fetchImpl: f, signal: ctrl.signal, timeoutMs: 5000 });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('handles moderated renders, HTTP errors and still-pending renders', async () => {
    const lookup = json({ data: [{ id: 1, name: 'a_b' }] });
    const blocked = mockFetch((url) => (url.includes('users.roblox') ? lookup.clone() : json({ data: [{ state: 'Blocked' }] })));
    await expect(fetchAvatar('a_b', 'bust', { fetchImpl: blocked })).rejects.toMatchObject({ kind: 'blocked' });
    const http = mockFetch(() => json({}, 500));
    await expect(fetchAvatar('a_b', 'bust', { fetchImpl: http })).rejects.toMatchObject({ kind: 'server' });
    const pending = mockFetch((url) => (url.includes('users.roblox') ? lookup.clone() : json({ data: [{ state: 'Pending' }] })));
    await expect(fetchAvatar('a_b', 'bust', { fetchImpl: pending, retryDelayMs: 1 })).rejects.toMatchObject({ kind: 'pending' });
  });
});

describe('error descriptions', () => {
  it('explains the manual fallback for network problems', () => {
    const d = describeAvatarError(new AvatarError('network', 'x'), 'Builderman');
    expect(d.fallback).toBe(true);
    expect(d.detail).toMatch(/Save image as/);
    expect(d.detail).toMatch(/drag/i);
    expect(describeAvatarError(new TypeError('boom'), '').fallback).toBe(true);
    expect(describeAvatarError(new AvatarError('notFound', 'No user'), 'x')).toEqual({ title: 'No user', detail: '', fallback: false });
  });
});
