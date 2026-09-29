// The command palette's data: which items exist right now, and how a query ranks them.
// Pure, so the UI is a thin list over it and the ranking is tested without a browser.
import type { SavedSession, SessionInfo, SlashCommand } from '../api/types';
import { firstDescriptionLine } from '../composer/slash';
import { basename, relativeTime, savedFolderLabel, savedTitle, sessionTitle, uniqueCwds } from '../format';
import type { ShortcutId } from '../keymap';
import type { IconName } from '../ui/icons';
import { fuzzyScoreAll } from './fuzzy';
import { SETTINGS_ENTRIES, SETTINGS_PAGES, type SettingsPageId } from './settings-index';

export type PaletteKind = 'action' | 'session' | 'slash' | 'setting' | 'history';

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  title: string;
  sub?: string;
  keywords?: string[];
  icon: IconName;
  shortcut?: ShortcutId;
  /** Live sessions only: how it should be marked. */
  status?: 'needs' | 'running' | 'idle';
  /** The session currently on screen. */
  current?: boolean;
  run: () => void;
}

export const KIND_LABEL: Record<PaletteKind, string> = {
  action: 'Actions',
  session: 'Sessions',
  slash: 'Slash commands',
  setting: 'Settings',
  history: 'History',
};

/** Tie-break order, and the order of the sections when nothing is typed. */
const KIND_ORDER: PaletteKind[] = ['action', 'session', 'slash', 'setting', 'history'];

export interface PaletteActions {
  newSession(): void;
  nextAttention(): void;
  openSession(gwId: string): void;
  resume(saved: SavedSession): void;
  openSettings(page: SettingsPageId): void;
  toggleTheme(): void;
  compact(): void;
  stop(): void;
  rename(): void;
  sessionInfo(): void;
  slash(command: SlashCommand): void;
}

export interface PaletteContext {
  live: readonly SessionInfo[];
  saved: readonly SavedSession[];
  activeGwId: string | null;
  commands: readonly SlashCommand[];
  now: number;
  actions: PaletteActions;
}

function liveStatus(s: SessionInfo): PaletteItem['status'] {
  if (s.pendingUi.length > 0) return 'needs';
  return s.isStreaming ? 'running' : 'idle';
}

export function buildPaletteItems(ctx: PaletteContext): PaletteItem[] {
  const { actions: a } = ctx;
  const live = ctx.live.filter((s) => !s.exited);
  const open = ctx.activeGwId !== null && live.some((s) => s.gwId === ctx.activeGwId);
  const needing = live.filter((s) => s.pendingUi.length > 0);
  const items: PaletteItem[] = [];

  items.push({
    id: 'a:new', kind: 'action', title: 'New session', icon: 'plus', shortcut: 'new-session',
    keywords: ['start', 'create', 'open'], run: a.newSession,
  });
  if (needing.length) {
    items.push({
      id: 'a:next', kind: 'action', title: 'Next session that needs you', icon: 'alert', shortcut: 'next-attention',
      sub: `${needing.length} waiting`, keywords: ['attention', 'approval', 'waiting', 'blocked'], run: a.nextAttention,
    });
  }
  items.push({
    id: 'a:theme', kind: 'action', title: 'Toggle light and dark theme', icon: 'sparkle',
    keywords: ['appearance', 'paper', 'terminal', 'color'], run: a.toggleTheme,
  });
  if (open) {
    items.push(
      { id: 'a:info', kind: 'action', title: 'Session info', icon: 'info', keywords: ['details', 'cost', 'tokens', 'cwd'], run: a.sessionInfo },
      { id: 'a:rename', kind: 'action', title: 'Rename session', icon: 'pencil', keywords: ['title', 'name'], run: a.rename },
      { id: 'a:compact', kind: 'action', title: 'Compact context', icon: 'compress', keywords: ['summarize', 'shrink', 'tokens'], run: a.compact },
      { id: 'a:stop', kind: 'action', title: 'Stop session', icon: 'power', keywords: ['end', 'kill', 'close', 'quit'], run: a.stop },
    );
  }

  for (const s of live) {
    const model = s.model?.name ?? s.model?.id;
    items.push({
      id: `s:${s.gwId}`,
      kind: 'session',
      title: sessionTitle(s, ctx.saved),
      sub: [basename(s.cwd), model].filter(Boolean).join(' · '),
      keywords: [s.cwd],
      icon: 'terminal',
      status: liveStatus(s),
      current: s.gwId === ctx.activeGwId,
      run: () => a.openSession(s.gwId),
    });
  }

  if (open) {
    for (const c of ctx.commands) {
      items.push({
        id: `c:${c.name}`,
        kind: 'slash',
        title: `/${c.name}`,
        sub: firstDescriptionLine(c),
        keywords: c.aliases?.map((x) => `/${x}`),
        icon: 'terminal',
        run: () => a.slash(c),
      });
    }
  }

  for (const p of SETTINGS_PAGES) {
    const words = SETTINGS_ENTRIES.filter((e) => e.page === p.id).flatMap((e) => [e.label, e.keywords]);
    items.push({
      id: `p:${p.id}`, kind: 'setting', title: p.title, sub: `Settings · ${p.blurb}`, icon: 'sliders',
      keywords: words, run: () => a.openSettings(p.id),
    });
  }

  const cwds = uniqueCwds(live);
  const liveFiles = new Set(live.map((s) => s.ompSessionFile).filter(Boolean));
  for (const s of ctx.saved) {
    if (liveFiles.has(s.file)) continue;
    items.push({
      id: `h:${s.file}`,
      kind: 'history',
      title: savedTitle(s, cwds),
      sub: `${savedFolderLabel(s, cwds)} · ${relativeTime(s.mtime * 1000, ctx.now)}`,
      icon: 'clock',
      run: () => a.resume(s),
    });
  }
  return items;
}

/** Per-kind cap for the empty query, where the palette is a short menu rather than a search. */
const EMPTY_CAPS: Record<PaletteKind, number> = { action: 8, session: 8, slash: 0, setting: 0, history: 5 };

export interface RankOptions {
  limit?: number;
}

/**
 * Filter and order items for a query. `>` narrows to actions and settings, `/` to the open
 * session's slash commands. With no query the palette shows actions, live sessions and a few
 * recent transcripts, in that order.
 */
export function rankItems(items: readonly PaletteItem[], rawQuery: string, opts: RankOptions = {}): PaletteItem[] {
  const limit = opts.limit ?? 40;
  let query = rawQuery.trim();
  let kinds: readonly PaletteKind[] | null = null;
  if (query.startsWith('>')) {
    kinds = ['action', 'setting'];
    query = query.slice(1).trim();
  } else if (query.startsWith('/')) {
    kinds = ['slash'];
    query = query.slice(1).trim();
  }
  const pool = kinds ? items.filter((i) => kinds.includes(i.kind)) : items;

  if (!query) {
    const shown = new Map<PaletteKind, number>();
    const out: PaletteItem[] = [];
    const cap = (k: PaletteKind) => (kinds ? limit : EMPTY_CAPS[k]);
    for (const kind of KIND_ORDER) {
      const group = pool.filter((i) => i.kind === kind);
      if (kind === 'session') {
        // Sessions that need you first, and the one already on screen last.
        group.sort((x, y) => Number(y.status === 'needs') - Number(x.status === 'needs') || Number(!!x.current) - Number(!!y.current));
      }
      for (const item of group) {
        const n = shown.get(kind) ?? 0;
        if (n >= cap(kind)) break;
        shown.set(kind, n + 1);
        out.push(item);
      }
    }
    return out.slice(0, limit);
  }

  const scored: { item: PaletteItem; score: number; at: number }[] = [];
  pool.forEach((item, at) => {
    const score = fuzzyScoreAll(query, item.title, [item.sub, ...(item.keywords ?? [])]);
    if (score >= 0) scored.push({ item, score, at });
  });
  scored.sort(
    (x, y) =>
      y.score - x.score ||
      KIND_ORDER.indexOf(x.item.kind) - KIND_ORDER.indexOf(y.item.kind) ||
      x.at - y.at,
  );
  return scored.slice(0, limit).map((s) => s.item);
}
