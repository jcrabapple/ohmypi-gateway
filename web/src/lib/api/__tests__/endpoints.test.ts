import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client';
import { sessions } from '../endpoints';

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
