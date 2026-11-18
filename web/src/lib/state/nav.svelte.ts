// Hash routing (`#/s/<gwId>`) and the actions that move between sessions. Opening a
// session is just a hash change; App syncs the hash to `active.open`.
import { sessions as api, type NewSession } from '../api/endpoints';
import type { SavedSession, SessionInfo } from '../api/types';
import { sessionsStore } from './sessions.svelte';
import { ui } from './ui.svelte';

const ROUTE = /^#\/s\/([\w-]+)(\/changes)?$/;
const USAGE = '#/usage';
const SEARCH = '#/search';
const KANBAN_PREFIX = '#/kanban';

export function parseKanbanHash(hash: string): { active: boolean; cwd: string | null } {
  if (hash === KANBAN_PREFIX) return { active: true, cwd: null };
  if (hash.startsWith(`${KANBAN_PREFIX}?`)) {
    const params = new URLSearchParams(hash.slice(KANBAN_PREFIX.length + 1));
    const cwd = params.get('cwd')?.trim() || null;
    return { active: true, cwd };
  }
  return { active: false, cwd: null };
}

export interface HashRoute {
  gwId: string;
  changes: boolean;
}

export function parseHash(hash: string): HashRoute | null {
  const m = ROUTE.exec(hash);
  return m ? { gwId: m[1]!, changes: m[2] === '/changes' } : null;
}

class Nav {
  gwId = $state<string | null>(parseHash(globalThis.location?.hash ?? '')?.gwId ?? null);
  /** Which surface of the open session is showing. */
  view = $state<'transcript' | 'changes'>(
    parseHash(globalThis.location?.hash ?? '')?.changes ? 'changes' : 'transcript',
  );
  /** Gateway-wide usage page (`#/usage`). */
  usage = $state((globalThis.location?.hash ?? '') === USAGE);
  /** Gateway-wide transcript search page (`#/search`). */
  search = $state((globalThis.location?.hash ?? '') === SEARCH);
  /** Project kanban boards (`#/kanban` or `#/kanban?cwd=...`). */
  kanban = $state(parseKanbanHash(globalThis.location?.hash ?? '').active);
  kanbanCwd = $state<string | null>(parseKanbanHash(globalThis.location?.hash ?? '').cwd);
  /** Saved session file being resumed right now, for the spinner on its row. */
  resuming = $state<string | null>(null);
  /** The last session that died on us, so the new-session sheet can offer its draft. */
  lastGone = $state<{ gwId: string; cwd: string | null } | null>(null);

  /** Start listening to the URL. Returns a stop function. */
  start(): () => void {
    const on = () => {
      const r = parseHash(location.hash);
      const kb = parseKanbanHash(location.hash);
      this.gwId = r?.gwId ?? null;
      this.view = r?.changes ? 'changes' : 'transcript';
      this.usage = location.hash === USAGE;
      this.search = location.hash === SEARCH;
      this.kanban = kb.active;
      this.kanbanCwd = kb.cwd;
    };
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }

  open(gwId: string): void {
    ui.close('drawer');
    this.view = 'transcript';
    this.usage = false;
    this.search = false;
    this.kanban = false;
    this.kanbanCwd = null;
    if (location.hash === `#/s/${gwId}`) this.gwId = gwId;
    else location.hash = `#/s/${gwId}`;
  }

  /** The gateway-wide usage page. */
  openUsage(): void {
    ui.close('drawer');
    this.search = false;
    this.kanban = false;
    this.kanbanCwd = null;
    if (location.hash === USAGE) this.usage = true;
    else location.hash = USAGE;
  }

  /** The gateway-wide transcript search page. */
  openSearch(): void {
    ui.close('drawer');
    this.usage = false;
    this.kanban = false;
    this.kanbanCwd = null;
    if (location.hash === SEARCH) this.search = true;
    else location.hash = SEARCH;
  }

  /** Project kanban boards (`#/kanban` or `#/kanban?cwd=...`). */
  openKanban(cwd: string | null = null): void {
    ui.close('drawer');
    this.usage = false;
    this.search = false;
    const targetCwd = cwd?.trim() || null;
    const targetHash = targetCwd ? `${KANBAN_PREFIX}?cwd=${encodeURIComponent(targetCwd)}` : KANBAN_PREFIX;
    if (location.hash === targetHash) {
      this.kanban = true;
      this.kanbanCwd = targetCwd;
    } else {
      location.hash = targetHash;
    }
  }

  /** The open session's per-session Changes page. */
  openChanges(gwId: string): void {
    ui.close('drawer');
    this.view = 'changes';
    this.usage = false;
    this.search = false;
    this.kanban = false;
    this.kanbanCwd = null;
    if (location.hash === `#/s/${gwId}/changes`) {
      this.gwId = gwId;
    } else {
      location.hash = `#/s/${gwId}/changes`;
    }
  }
  home(): void {
    ui.close('drawer');
    if (location.hash) history.pushState(null, '', location.pathname + location.search);
    this.gwId = null;
    this.view = 'transcript';
    this.usage = false;
    this.search = false;
    this.kanban = false;
    this.kanbanCwd = null;
  }

  /** Resume a saved transcript. If omp is already running it, open the live session instead. */
  async resume(saved: Pick<SavedSession, 'file' | 'running'>): Promise<void> {
    const live = sessionsStore.live.find((s) => s.ompSessionFile === saved.file && !s.exited);
    if (live) return this.open(live.gwId);
    if (this.resuming) return;
    this.resuming = saved.file;
    try {
      const info = await api.resume(saved);
      sessionsStore.patch(info);
      this.open(info.gwId);
      void sessionsStore.refresh();
    } catch (e) {
      ui.error(e instanceof Error ? e.message : 'Could not resume the session');
    } finally {
      this.resuming = null;
    }
  }

  /** `beforeOpen` runs once the session exists and before the view mounts, e.g. to seed its draft. */
  async create(body: NewSession, beforeOpen?: (info: SessionInfo) => void): Promise<SessionInfo> {
    const info = await api.create(body);
    beforeOpen?.(info);
    sessionsStore.patch(info);
    this.open(info.gwId);
    void sessionsStore.refresh();
    return info;
  }

  /** Stop a live session (the transcript stays on disk) and leave it. */
  async stop(gwId: string): Promise<boolean> {
    try {
      await api.stop(gwId);
    } catch (e) {
      ui.error(e instanceof Error ? e.message : 'Could not stop the session');
      return false;
    }
    sessionsStore.remove(gwId);
    if (this.gwId === gwId) this.home();
    void sessionsStore.refresh();
    return true;
  }

  noteGone(gwId: string, cwd: string | null): void {
    this.lastGone = { gwId, cwd };
  }
}

export const nav = new Nav();
