import { isAbortError } from '../api/client';
import { sessions as sessionsApi } from '../api/endpoints';
import type { SavedSession, SessionInfo } from '../api/types';
import { cacheKey, idbGet, idbSet } from '../platform/idb';
import { groupSessions } from './grouping';

const POLL_MS = 5000;
const CACHE_KEY = cacheKey('sessions-list');

class SessionsStore {
  live = $state<SessionInfo[]>([]);
  saved = $state<SavedSession[]>([]);
  /** False until the first list (cached or fresh) arrives, so the rail can show skeletons. */
  loaded = $state(false);
  error = $state<string | null>(null);
  groups = $derived(groupSessions(this.live, this.saved));

  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: AbortController | null = null;
  private polling = false;

  /** Paint from the cache, fetch, then keep polling while the tab is visible. */
  start(): void {
    if (this.polling) return;
    this.polling = true;
    void this.paintCached();
    void this.refresh();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.arm();
  }

  stop(): void {
    this.polling = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.disarm();
    this.inflight?.abort();
    this.inflight = null;
  }

  async refresh(): Promise<void> {
    this.inflight?.abort();
    const ctl = new AbortController();
    this.inflight = ctl;
    try {
      const list = await sessionsApi.list(60, ctl.signal);
      this.live = list.live;
      this.saved = list.saved;
      this.error = null;
      this.loaded = true;
      void idbSet(CACHE_KEY, list);
    } catch (e) {
      if (isAbortError(e)) return;
      this.error = e instanceof Error ? e.message : 'Could not load sessions';
    } finally {
      if (this.inflight === ctl) this.inflight = null;
    }
  }

  get(gwId: string): SessionInfo | undefined {
    return this.live.find((s) => s.gwId === gwId);
  }

  /** Replace one live session with a fresher copy (from auth_ok or a state fetch) without waiting for the poll. */
  patch(info: SessionInfo): void {
    const i = this.live.findIndex((s) => s.gwId === info.gwId);
    if (i < 0) this.live = [info, ...this.live];
    else this.live = this.live.map((s, j) => (j === i ? info : s));
  }

  remove(gwId: string): void {
    this.live = this.live.filter((s) => s.gwId !== gwId);
  }

  private async paintCached(): Promise<void> {
    const cached = await idbGet<{ live: SessionInfo[]; saved: SavedSession[] }>(CACHE_KEY);
    if (!cached || this.loaded) return;
    this.live = cached.live;
    this.saved = cached.saved;
    this.loaded = true;
  }

  private arm(): void {
    if (this.timer || document.hidden) return;
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      this.disarm();
    } else {
      void this.refresh();
      this.arm();
    }
  };
}

export const sessionsStore = new SessionsStore();
