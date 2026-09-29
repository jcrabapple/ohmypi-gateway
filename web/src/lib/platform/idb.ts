// Tiny promise keyval store over IndexedDB, no dependency. Used for caches
// (sessions list, per-session messages) where localStorage is too small.
// Every call resolves to a fallback instead of rejecting: a cache miss is
// always acceptable, a thrown error never is.

const DB_NAME = 'ompgw';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    const factory = globalThis.indexedDB as IDBFactory | undefined;
    if (!factory) return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  return run<T>('readonly', (s) => s.get(key));
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  await run('readwrite', (s) => s.put(value, key));
}

export async function idbDelete(key: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key));
}

/** Delete every key that starts with `prefix`. */
export async function idbDeletePrefix(prefix: string): Promise<void> {
  const keys = (await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? [];
  for (const k of keys) if (typeof k === 'string' && k.startsWith(prefix)) await idbDelete(k);
}

/** Cache keys share the storage scheme: origin-scoped so gateways never mix. */
export function cacheKey(...parts: string[]): string {
  return [globalThis.location?.origin ?? 'unknown', ...parts].join(':');
}
