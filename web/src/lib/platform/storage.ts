// localStorage with keys scoped per origin and per scope, so two gateways on
// different origins (or two sessions) never read each other's data.
//   ompgw:v1:<origin>:<scope>:<key>
// Scopes: `device` (settings, layout) or `session:<gwId>` (drafts, scroll).
// Every call tolerates a missing or blocked localStorage (private mode, quota).

export type Scope = 'device' | `session:${string}`;

const PREFIX = 'ompgw:v1';

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function origin(): string {
  return globalThis.location?.origin ?? 'unknown';
}

export function storageKey(scope: Scope, key: string): string {
  return `${PREFIX}:${origin()}:${scope}:${key}`;
}

export function getItem<T>(scope: Scope, key: string, fallback: T): T {
  const raw = store()?.getItem(storageKey(scope, key));
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setItem(scope: Scope, key: string, value: unknown): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(storageKey(scope, key), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeItem(scope: Scope, key: string): void {
  try {
    store()?.removeItem(storageKey(scope, key));
  } catch {
    /* ignore */
  }
}

/** Drop everything stored under one scope on this origin, e.g. when a session is stopped. */
export function clearScope(scope: Scope): void {
  const s = store();
  if (!s) return;
  const prefix = `${PREFIX}:${origin()}:${scope}:`;
  const doomed: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith(prefix)) doomed.push(k);
  }
  for (const k of doomed) s.removeItem(k);
}

export const device = {
  get: <T>(key: string, fallback: T) => getItem<T>('device', key, fallback),
  set: (key: string, value: unknown) => setItem('device', key, value),
  remove: (key: string) => removeItem('device', key),
};

export function sessionScope(gwId: string): Scope {
  return `session:${gwId}`;
}
