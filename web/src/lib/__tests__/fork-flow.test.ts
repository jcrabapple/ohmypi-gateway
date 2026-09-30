import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { forkFromItem, forkLatest } from '../actions.svelte';
import { sessions as sessionsApi } from '../api/endpoints';
import type * as Endpoints from '../api/endpoints';
import type { SessionEntry, SessionInfo } from '../api/types';
import { loadDraft } from '../composer/drafts';
import { emptyTranscript } from '../transcript/reducer';
import type { Item, UserItem } from '../transcript/types';
import { active, nav, sessionsStore, ui } from '../state';
import { session } from '../palette/__tests__/factories';

vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof Endpoints>();
  return {
    ...actual,
    sessions: {
      ...actual.sessions,
      list: vi.fn(async () => ({ live: [], saved: [] })),
      entries: vi.fn(),
      fork: vi.fn(),
      info: vi.fn(),
      messages: vi.fn(),
    },
  };
});

const mocked = vi.mocked({
  entries: sessionsApi.entries,
  fork: sessionsApi.fork,
  info: sessionsApi.info,
  messages: sessionsApi.messages,
});

function user(text: string, ts: number, over: Partial<UserItem> = {}): UserItem {
  return { kind: 'user', id: `u:${ts}`, text, images: 0, pending: false, timestamp: ts, ...over };
}

function transcript(items: Item[]): void {
  active.transcript = { ...emptyTranscript(), items };
}

const ENTRY: SessionEntry = { entryId: 'e1', role: 'user', timestamp: 1000 };
const INFO: SessionInfo = session('fork-child');

afterEach(() => {
  vi.restoreAllMocks();
  active.close();
  sessionsStore.live = [];
  sessionsStore.forked = {};
  ui.toasts.forEach((t) => ui.dismissToast(t.id));
  localStorage.clear();
});

beforeEach(() => {
  active.gwId = 'gw-parent';
  nav.open = vi.fn();
});

describe('forkFromItem', () => {
  it('forks, registers the child with the rail, seeds the draft and navigates', async () => {
    transcript([user('hello', 1000), user('second', 2000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY, { entryId: 'e2', role: 'user', timestamp: 2000 }] });
    mocked.fork.mockResolvedValue({ gwId: 'fork-child', text: 'second' });
    mocked.info.mockResolvedValue(INFO);
    mocked.messages.mockResolvedValue({ messages: [{ role: 'user', content: 'hello' }], totalMessages: 1 });
    // The poll after the fork sees the child on the gateway.
    vi.mocked(sessionsApi.list).mockResolvedValue({ live: [INFO], saved: [] });

    await forkFromItem(user('second', 2000));

    expect(mocked.fork).toHaveBeenCalledWith('gw-parent', 'e2');
    expect(nav.open).toHaveBeenCalledWith('fork-child');
    expect(sessionsStore.live.map((s) => s.gwId)).toContain('fork-child');
    expect(sessionsStore.forked['fork-child']).toBe('gw-parent');
    expect(loadDraft('fork-child')).toBe('second');
    expect(ui.toasts.some((t) => t.text === 'Forked to new session')).toBe(true);
  });

  it('offers Fork latest instead of navigating when the item is gone from live history', async () => {
    transcript([user('hello', 1000)]);
    mocked.entries.mockResolvedValue({ entries: [{ entryId: 'e9', role: 'user', timestamp: 5555 }] });

    await forkFromItem(user('hello', 1000));

    expect(mocked.fork).not.toHaveBeenCalled();
    expect(nav.open).not.toHaveBeenCalled();
    const t = ui.toasts.at(-1);
    expect(t?.text).toBe('This session has changed since it loaded');
    expect(t?.action?.label).toBe('Fork latest');
  });

  it('offers Fork latest when the gateway rejects the entry as stale (422)', async () => {
    transcript([user('hello', 1000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY] });
    mocked.fork.mockRejectedValue(Object.assign(new Error('unknown entryId'), { status: 422 }));

    await forkFromItem(user('hello', 1000));

    expect(mocked.fork).toHaveBeenCalledWith('gw-parent', 'e1');
    expect(nav.open).not.toHaveBeenCalled();
    expect(ui.toasts.at(-1)?.action?.label).toBe('Fork latest');
  });

  it('offers Fork latest when omp loses a compaction race (400 about the entry)', async () => {
    transcript([user('hello', 1000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY] });
    mocked.fork.mockRejectedValue(Object.assign(
      new Error('branch: Invalid entry ID for branching'), { status: 400 },
    ));

    await forkFromItem(user('hello', 1000));

    expect(ui.toasts.at(-1)?.action?.label).toBe('Fork latest');
  });

  it('keeps a 400 that does not mention the entry or branch a plain error', async () => {
    transcript([user('hello', 1000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY] });
    mocked.fork.mockRejectedValue(Object.assign(new Error('boom: omp exploded'), { status: 400 }));

    await forkFromItem(user('hello', 1000));

    expect(ui.toasts.at(-1)?.text).toBe('boom: omp exploded');
  });

  it('surfaces other fork errors as plain error toasts', async () => {
    transcript([user('hello', 1000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY] });
    mocked.fork.mockRejectedValue(new Error('omp exploded'));

    await forkFromItem(user('hello', 1000));

    expect(ui.toasts.at(-1)?.text).toBe('omp exploded');
    expect(nav.open).not.toHaveBeenCalled();
  });

  it('navigates anyway and notes missing history when the ancestor prefix diverged', async () => {
    transcript([user('hello', 1000), user('second', 2000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY, { entryId: 'e2', role: 'user', timestamp: 2000 }] });
    mocked.fork.mockResolvedValue({ gwId: 'fork-child' });
    mocked.info.mockResolvedValue(INFO);
    // Compacted fork: the prefix is gone from the child transcript.
    mocked.messages.mockResolvedValue({ messages: [], totalMessages: 0 });

    await forkFromItem(user('second', 2000));

    // The parent is stopped server-side, so the user lands on the child either
    // way; the mismatch is a note, not a blocking choice on a dead session.
    expect(nav.open).toHaveBeenCalledWith('fork-child');
    expect(sessionsStore.forked['fork-child']).toBe('gw-parent');
    const t = ui.toasts.at(-1);
    expect(t?.text).toBe('The forked session is missing part of this history');
    expect(t?.action).toBeUndefined();
  });

  it('navigates anyway when the forked transcript cannot be verified', async () => {
    transcript([user('hello', 1000), user('second', 2000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY, { entryId: 'e2', role: 'user', timestamp: 2000 }] });
    mocked.fork.mockResolvedValue({ gwId: 'fork-child', text: 'second' });
    mocked.info.mockResolvedValue(INFO);
    mocked.messages.mockRejectedValue(new Error('gateway restarted'));

    await forkFromItem(user('second', 2000));

    expect(nav.open).toHaveBeenCalledWith('fork-child');
    expect(ui.toasts.at(-1)?.text).toBe('Could not verify the forked session history');
  });

  it('surfaces the child gwId when opening the fork fails', async () => {
    transcript([user('hello', 1000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY] });
    mocked.fork.mockResolvedValue({ gwId: 'fork-child' });
    mocked.info.mockRejectedValue(new Error('gone'));

    await forkFromItem(user('hello', 1000));

    expect(nav.open).not.toHaveBeenCalled();
    expect(ui.toasts.at(-1)?.text).toBe('The fork was created as fork-child but could not be opened');
  });

  it('drops the stopped parent from the rail when the fork opens', async () => {
    sessionsStore.live = [session('gw-parent')];
    transcript([user('hello', 1000), user('second', 2000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY, { entryId: 'e2', role: 'user', timestamp: 2000 }] });
    mocked.fork.mockResolvedValue({ gwId: 'fork-child', text: 'second' });
    mocked.info.mockResolvedValue(INFO);
    mocked.messages.mockResolvedValue({ messages: [{ role: 'user', content: 'hello' }], totalMessages: 1 });
    vi.mocked(sessionsApi.list).mockResolvedValue({ live: [INFO], saved: [] });

    await forkFromItem(user('second', 2000));

    expect(sessionsStore.live.map((s) => s.gwId)).not.toContain('gw-parent');
    expect(sessionsStore.live.map((s) => s.gwId)).toContain('fork-child');
  });

  it('does nothing for a pending or failed message', async () => {
    transcript([user('hello', 1000, { pending: true })]);
    await forkFromItem(user('hello', 1000, { pending: true }));
    expect(mocked.entries).not.toHaveBeenCalled();
  });
});

describe('forkLatest', () => {
  it('forks at the newest live user entry without a prefix check', async () => {
    transcript([user('hello', 1000)]);
    mocked.entries.mockResolvedValue({ entries: [ENTRY, { entryId: 'e2', role: 'user', timestamp: 2000 }] });
    mocked.fork.mockResolvedValue({ gwId: 'fork-child', text: 'second' });
    mocked.info.mockResolvedValue(INFO);

    await forkLatest();

    expect(mocked.fork).toHaveBeenCalledWith('gw-parent', 'e2');
    expect(mocked.messages).not.toHaveBeenCalled();
    expect(nav.open).toHaveBeenCalledWith('fork-child');
    // No item to prefill from: the gateway's selectedText seeds the draft.
    expect(loadDraft('fork-child')).toBe('second');
  });

  it('says so when the session has no user messages', async () => {
    mocked.entries.mockResolvedValue({ entries: [] });
    await forkLatest();
    expect(mocked.fork).not.toHaveBeenCalled();
    expect(ui.toasts.at(-1)?.text).toBe('Nothing to fork yet');
  });
});
