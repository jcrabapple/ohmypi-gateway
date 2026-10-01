import { isAbortError } from '../api/client';
import { sessions as sessionsApi } from '../api/endpoints';
import type { SavedSession, SessionInfo } from '../api/types';
import { device } from '../platform/storage';
import { cacheKey, idbGet, idbSet } from '../platform/idb';
import { active } from './active.svelte';
import { groupSessions } from './grouping';
import { pins } from './pins.svelte';
import { reviewed } from './reviewed.svelte';

const POLL_MS = 5000;
const CACHE_KEY = cacheKey('sessions-list');
/** Fork badges: child gwId -> parent gwId. Device-local, like the review marks;
 *  gwIds are ephemeral per run, so the map is capped like the done ledger. */
const FORKED_KEY = 'ompgw-forked';
const FORKED_CAP = 500;

function loadForked(): Record<string, string> {
  const raw = device.get<unknown>(FORKED_KEY, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return out;
}
/** todoActive entries older than this are dropped on the global poll unless the session is the one
 *  that is open: a background session's todo state is unknown, so a stale entry must not read as
 *  working forever. The open session keeps its entry until its own /state refresh says otherwise. */
const TODO_FRESH_MS = 15_000;

class SessionsStore {
  live = $state<SessionInfo[]>([]);
  saved = $state<SavedSession[]>([]);
  /** False until the first list (cached or fresh) arrives, so the rail can show skeletons. */
  loaded = $state(false);
  error = $state<string | null>(null);
  /** Sessions whose last known /state has an in_progress todo task; the rail reads them as working. */
  todoActive = $state<Set<string>>(new Set());
  /** Child gwId -> parent gwId for sessions created by fork; drives the rail badge. */
  forked = $state<Record<string, string>>(loadForked());
  /** Last time each session's /state confirmed its todo state; entries go stale without refreshes. */
  private lastTodoRefresh = new Map<string, number>();
  groups = $derived(groupSessions(this.live, this.saved, Date.now(), this.todoActive, reviewed.needsReview, pins.files));

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
      this.expireTodoStale();
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

  /** Record whether a session's last known /state had an in_progress todo task.
   *  Reassigns the Set so $derived consumers (the rail groups) recompute. */
  setTodoActive(gwId: string, on: boolean): void {
    if (on) this.lastTodoRefresh.set(gwId, Date.now());
    else this.lastTodoRefresh.delete(gwId);
    if (on === this.todoActive.has(gwId)) return;
    const next = new Set(this.todoActive);
    if (on) next.add(gwId);
    else next.delete(gwId);
    this.todoActive = next;
  }

  /** Replace one live session with a fresher copy (from auth_ok or a state fetch) without waiting for the poll. */
  patch(info: SessionInfo): void {
    const i = this.live.findIndex((s) => s.gwId === info.gwId);
    if (i < 0) this.live = [info, ...this.live];
    else this.live = this.live.map((s, j) => (j === i ? info : s));
  }

  remove(gwId: string): void {
    this.live = this.live.filter((s) => s.gwId !== gwId);
    this.lastTodoRefresh.delete(gwId);
    if (this.todoActive.has(gwId)) {
      const next = new Set(this.todoActive);
      next.delete(gwId);
      this.todoActive = next;
    }
  }

  /** Record that `child` was forked from `parent` (device-local, capped). */
  markForked(child: string, parent: string): void {
    if (this.forked[child] === parent) return;
    const next: Record<string, string> = { ...this.forked, [child]: parent };
    const keys = Object.keys(next);
    while (keys.length > FORKED_CAP) delete next[keys.shift() as string];
    this.forked = next;
    device.set(FORKED_KEY, next);
  }

  /** Drop todoActive entries gone stale on the global poll: only the open session keeps having its
   *  /state refreshed, so for anything else an old entry is a guess, not a fact. */
  private expireTodoStale(): void {
    const cutoff = Date.now() - TODO_FRESH_MS;
    let next: Set<string> | null = null;
    for (const gwId of this.todoActive) {
      if (gwId !== active.gwId && (this.lastTodoRefresh.get(gwId) ?? 0) < cutoff) {
        next ??= new Set(this.todoActive);
        next.delete(gwId);
      }
    }
    if (next) this.todoActive = next;
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
