// The single fetch wrapper. Components and stores never call fetch directly.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSec: number | null;
  readonly body: unknown;

  constructor(status: number, message: string, opts: { code?: string | null; retryAfterSec?: number | null; body?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = opts.code ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.body = opts.body;
  }
}

export interface ApiOptions {
  method?: string;
  /** Objects are sent as JSON. Strings are sent raw; set `headers['Content-Type']` for non-text bodies. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Abort the request after this long. Default 30 s; the model catalog can take a minute. */
  timeoutMs?: number;
}

// ------------------------------------------------------------------ base URL

let baseUrl = '';

/** Empty means same origin. Desktop and Android shells set the gateway URL. */
export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, '');
}

export function getBaseUrl(): string {
  return baseUrl || (typeof location !== 'undefined' ? location.origin : '');
}

export function wsBaseUrl(): string {
  return getBaseUrl().replace(/^http/, 'ws');
}

// ---------------------------------------------------------------- signed-out

type Listener = () => void;
const signedOutListeners = new Set<Listener>();
let signedOutEmitted = false;

/** App-level signal that the gateway rejected our credentials. Fires once until `resetSignedOut`. */
export function onSignedOut(fn: Listener): () => void {
  signedOutListeners.add(fn);
  return () => signedOutListeners.delete(fn);
}

export function emitSignedOut(): void {
  if (signedOutEmitted) return;
  signedOutEmitted = true;
  for (const fn of [...signedOutListeners]) fn();
}

export function resetSignedOut(): void {
  signedOutEmitted = false;
}

// ----------------------------------------------------------------------- api

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function errorMessage(status: number, statusText: string, data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (typeof d.error === 'string' && d.error) return d.error;
    if (typeof d.detail === 'string' && d.detail) return d.detail;
    if (Array.isArray(d.detail) && d.detail.length) {
      const first = d.detail[0] as { msg?: unknown } | string;
      if (typeof first === 'string') return first;
      if (first && typeof first.msg === 'string') return first.msg;
    }
  }
  return statusText || `HTTP ${status}`;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') {
      body = opts.body;
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'text/plain;charset=UTF-8';
    } else {
      body = JSON.stringify(opts.body);
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    }
  }

  const ctl = new AbortController();
  const relay = () => ctl.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) relay();
    else opts.signal.addEventListener('abort', relay, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), opts.timeoutMs ?? 30_000);

  let res: Response;
  try {
    res = await fetch(getBaseUrl() + path, {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: ctl.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    if (ctl.signal.aborted) throw new ApiError(0, 'Request timed out', { code: 'timeout' });
    throw new ApiError(0, 'Could not reach the gateway', { code: 'network' });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', relay);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') emitSignedOut();
    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const retry = res.headers.get('Retry-After');
    throw new ApiError(res.status, errorMessage(res.status, res.statusText, data), {
      code: obj && typeof obj.code === 'string' ? obj.code : null,
      retryAfterSec: typeof obj?.retryAfterSec === 'number' ? obj.retryAfterSec : retry ? Number(retry) || null : null,
      body: data,
    });
  }
  return data as T;
}

function hasHeader(h: Record<string, string>, name: string): boolean {
  return Object.keys(h).some((k) => k.toLowerCase() === name);
}
