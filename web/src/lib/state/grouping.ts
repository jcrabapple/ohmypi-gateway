// Pure grouping of the sessions list into the rail's sections.
import type { SavedSession, SessionInfo } from '../api/types';

export interface HistoryGroup {
  key: 'today' | 'yesterday' | 'week' | 'older';
  label: string;
  items: SavedSession[];
}

export interface SessionGroups {
  needsYou: SessionInfo[];
  review: SessionInfo[];
  running: SessionInfo[];
  idle: SessionInfo[];
  /** Saved sessions the user pinned; always rendered above the history. */
  pinned: SavedSession[];
  history: HistoryGroup[];
}

const LABELS: Record<HistoryGroup['key'], string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  older: 'Earlier',
};

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function historyBucket(mtimeSec: number, now: number): HistoryGroup['key'] {
  const today = startOfDay(now);
  const t = mtimeSec * 1000;
  if (t >= today) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (t >= yesterday.getTime()) return 'yesterday';
  const week = new Date(today);
  week.setDate(week.getDate() - 7);
  return t >= week.getTime() ? 'week' : 'older';
}

/** Live sessions that have exited are dropped; saved sessions that are live right now are dropped.
 *  `todoActive` holds sessions whose last known state has an in_progress todo task; they read as
 *  working even between agent turns. `needsReview` holds sessions the user pinned for review;
 *  they read as ready for review while idle, but anything working or asking for input outranks
 *  the pin. */
export function groupSessions(
  live: readonly SessionInfo[],
  saved: readonly SavedSession[],
  now: number = Date.now(),
  todoActive: ReadonlySet<string> = new Set(),
  needsReview: ReadonlySet<string> = new Set(),
  pinned: ReadonlySet<string> = new Set(),
): SessionGroups {
  const needsYou: SessionInfo[] = [];
  const review: SessionInfo[] = [];
  const running: SessionInfo[] = [];
  const idle: SessionInfo[] = [];
  const liveFiles = new Set<string>();
  for (const s of live) {
    if (s.exited) continue;
    if (s.ompSessionFile) liveFiles.add(s.ompSessionFile);
    if (s.pendingUi.length > 0) needsYou.push(s);
    else if (s.isStreaming || todoActive.has(s.gwId)) running.push(s);
    else if (needsReview.has(s.gwId)) review.push(s);
    else idle.push(s);
  }

  const pinnedItems: SavedSession[] = [];
  const buckets = new Map<HistoryGroup['key'], SavedSession[]>();
  const sorted = [...saved].sort((a, b) => b.mtime - a.mtime);
  for (const s of sorted) {
    if (s.running || liveFiles.has(s.file)) continue;
    // Pinned sessions leave the normal history buckets entirely.
    if (pinned.has(s.file)) {
      pinnedItems.push(s);
      continue;
    }
    const key = historyBucket(s.mtime, now);
    const list = buckets.get(key) ?? [];
    list.push(s);
    buckets.set(key, list);
  }
  const history: HistoryGroup[] = [];
  for (const key of ['today', 'yesterday', 'week', 'older'] as const) {
    const items = buckets.get(key);
    if (items?.length) history.push({ key, label: LABELS[key], items });
  }
  return { needsYou, review, running, idle, pinned: pinnedItems, history };
}
