// Stale-while-revalidate: the cached copy paints first, the network copy replaces it, and a
// failed fetch never blanks what is already on screen.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/stream', () => ({
  SessionStream: class {
    start() {}
    stop() {}
    reconnectNow() {}
  },
}));

import { sessions as api } from '../../api/endpoints';
import { idbDeletePrefix, idbGet, idbSet, cacheKey } from '../../platform/idb';
import type { OmpMessage, SessionInfo, SessionsList } from '../../api/types';
import { active } from '../active.svelte';
import { sessionsStore } from '../sessions.svelte';
import { session } from '../../palette/__tests__/factories';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

const LIST_KEY = cacheKey('sessions-list');

describe('sessions list cache', () => {
  beforeEach(async () => {
    await idbDeletePrefix('');
    sessionsStore.stop();
    sessionsStore.live = [];
    sessionsStore.saved = [];
    sessionsStore.loaded = false;
    sessionsStore.error = null;
  });
  afterEach(() => sessionsStore.stop());

  it('shows no data and stays unloaded (skeleton) when there is no cache and the fetch is pending', async () => {
    const net = deferred<SessionsList>();
    vi.spyOn(api, 'list').mockReturnValue(net.promise);
    sessionsStore.start();
    await flush();
    expect(sessionsStore.loaded).toBe(false);
    expect(sessionsStore.live).toEqual([]);
    net.resolve({ live: [], saved: [] });
  });

  it('paints the cached list before the network answers, then reconciles and rewrites the cache', async () => {
    await idbSet(LIST_KEY, { live: [session('old')], saved: [] } satisfies SessionsList);
    const net = deferred<SessionsList>();
    vi.spyOn(api, 'list').mockReturnValue(net.promise);

    sessionsStore.start();
    await flush();
    expect(sessionsStore.loaded).toBe(true);
    expect(sessionsStore.live.map((s) => s.gwId)).toEqual(['old']);

    net.resolve({ live: [session('new')], saved: [] });
    await flush();
    expect(sessionsStore.live.map((s) => s.gwId)).toEqual(['new']);
    const stored = await idbGet<SessionsList>(LIST_KEY);
    expect(stored?.live.map((s) => s.gwId)).toEqual(['new']);
  });

  it('a slow cache read never overwrites a list that already arrived from the network', async () => {
    await idbSet(LIST_KEY, { live: [session('stale')], saved: [] } satisfies SessionsList);
    vi.spyOn(api, 'list').mockResolvedValue({ live: [session('fresh')], saved: [] });
    sessionsStore.start();
    await flush();
    expect(sessionsStore.live.map((s) => s.gwId)).toEqual(['fresh']);
  });

  it('keeps the cached list on screen and reports the error when the fetch fails', async () => {
    await idbSet(LIST_KEY, { live: [session('cached')], saved: [] } satisfies SessionsList);
    vi.spyOn(api, 'list').mockRejectedValue(new Error('offline'));
    sessionsStore.start();
    await flush();
    expect(sessionsStore.live.map((s) => s.gwId)).toEqual(['cached']);
    expect(sessionsStore.loaded).toBe(true);
    expect(sessionsStore.error).toBe('offline');
  });
});

const user = (text: string, timestamp: number): OmpMessage => ({ role: 'user', content: text, timestamp });
const texts = () => active.transcript.items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text);

describe('session messages cache', () => {
  const MSG_KEY = cacheKey('messages', 'g1');

  beforeEach(async () => {
    await idbDeletePrefix('');
    active.close();
    vi.spyOn(api, 'commands').mockResolvedValue({ data: { commands: [] } });
    vi.spyOn(api, 'stats').mockRejectedValue(new Error('skip'));
    vi.spyOn(api, 'state').mockRejectedValue(new Error('skip'));
  });
  afterEach(() => active.close());

  it('paints cached messages while the network is pending, then swaps in the fresh history', async () => {
    await idbSet(MSG_KEY, [user('cached question', 1)]);
    const info = deferred<SessionInfo>();
    const msgs = deferred<{ messages: OmpMessage[]; totalMessages: number }>();
    vi.spyOn(api, 'info').mockReturnValue(info.promise);
    vi.spyOn(api, 'messages').mockReturnValue(msgs.promise);

    void active.open('g1');
    await flush();
    expect(active.phase).toBe('loading');
    expect(texts()).toEqual(['cached question']);

    info.resolve(session('g1'));
    msgs.resolve({ messages: [user('cached question', 1), user('newer question', 2)], totalMessages: 2 });
    await flush();
    expect(active.phase).toBe('ready');
    expect(texts()).toEqual(['cached question', 'newer question']);
    expect((await idbGet<OmpMessage[]>(MSG_KEY))?.length).toBe(2);
  });

  it('shows nothing (skeleton state) when there is no cache and the network is pending', async () => {
    vi.spyOn(api, 'info').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'messages').mockReturnValue(new Promise(() => {}));
    void active.open('g1');
    await flush();
    expect(active.phase).toBe('loading');
    expect(active.transcript.items).toHaveLength(0);
  });

  it('does not paint a cache that arrives after the network', async () => {
    await idbSet(MSG_KEY, [user('stale', 1)]);
    vi.spyOn(api, 'info').mockResolvedValue(session('g1'));
    vi.spyOn(api, 'messages').mockResolvedValue({ messages: [user('fresh', 2)], totalMessages: 1 });
    await active.open('g1');
    await flush();
    expect(texts()).toEqual(['fresh']);
  });

  it('caps what it stores to the last 200 messages', async () => {
    const many = Array.from({ length: 260 }, (_, i) => user(`m${i}`, i + 1));
    vi.spyOn(api, 'info').mockResolvedValue(session('g1'));
    vi.spyOn(api, 'messages').mockResolvedValue({ messages: many, totalMessages: 260 });
    await active.open('g1');
    await flush();
    const stored = (await idbGet<OmpMessage[]>(MSG_KEY))!;
    expect(stored).toHaveLength(200);
    expect((stored.at(-1) as { content: string }).content).toBe('m259');
  });

  it('forgetCache removes the stored transcript', async () => {
    await idbSet(MSG_KEY, [user('x', 1)]);
    await active.forgetCache('g1');
    expect(await idbGet(MSG_KEY)).toBeUndefined();
  });
});
