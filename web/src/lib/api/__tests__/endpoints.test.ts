import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client';
import { browseDirs, sessionFiles, sessions } from '../endpoints';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sessions.retry', () => {
  it('POSTs to the session retry route', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);
    await sessions.retry('g1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/sessions/g1/retry');
    expect(init.method).toBe('POST');
  });

  it('surfaces an omp rejection as an ApiError with the gateway message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'nothing to retry', code: 'invalid' })));
    const err = await sessions.retry('g1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, message: 'nothing to retry', code: 'invalid' });
  });
});

describe('sessionFiles', () => {
  it('GETs the files route with the prefix encoded and returns the entries', async () => {
    const entry = { name: 'a.txt', path: 'src/a.txt', isDir: false, size: 1 };
    const fetchMock = vi.fn(async () => jsonResponse(200, { entries: [entry] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sessionFiles('g1', 'src/sub')).resolves.toEqual([entry]);
    const called = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]!);
    expect(called.pathname + called.search).toBe('/api/sessions/g1/files?prefix=src%2Fsub');
  });

  it('lets the caller see refusal statuses (confinement is not silently swallowed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'path escapes the session directory' })));
    const err = await sessionFiles('g1', '../').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403 });
  });
});

describe('browseDirs', () => {
  it('GETs the folder listing with the path encoded', async () => {
    const body = { path: '/a b', parent: '/', home: '/h', dirs: [{ name: 'c', path: '/a b/c' }], truncated: false };
    const fetchMock = vi.fn(async () => jsonResponse(200, body));
    vi.stubGlobal('fetch', fetchMock);
    await expect(browseDirs('/a b')).resolves.toEqual(body);
    const called = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]!);
    expect(called.pathname + called.search).toBe('/api/fs/dirs?path=%2Fa%20b');
  });

  it('sends an empty path when none is given so the gateway picks its default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { path: '/h', parent: '/', home: '/h', dirs: [], truncated: false }));
    vi.stubGlobal('fetch', fetchMock);
    await browseDirs('');
    const called = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]!);
    expect(called.pathname + called.search).toBe('/api/fs/dirs?path=');
  });

  it('surfaces a gateway error as an ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'no such folder' })));
    const err = await browseDirs('/nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, message: 'no such folder' });
  });
});
