// Pure grouping of the sessions list into the rail's sections.
import type { SavedSession, SessionInfo } from '../api/types';

export interface HistoryGroup {
  key: 'today' | 'yesterday' | 'week' | 'older';
  label: string;
  items: SavedSession[];
}

export interface SessionGroups {
  needsYou: SessionInfo[];
  running: SessionInfo[];
  idle: SessionInfo[];
  history: HistoryGroup[];
}

const LABELS: Record<HistoryGroup['key'], string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  older: 'Older',
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

/** Live sessions that have exited are dropped; saved sessions that are live right now are dropped. */
export function groupSessions(
  live: readonly SessionInfo[],
  saved: readonly SavedSession[],
  now: number = Date.now(),
): SessionGroups {
  const needsYou: SessionInfo[] = [];
  const running: SessionInfo[] = [];
  const idle: SessionInfo[] = [];
  const liveFiles = new Set<string>();
  for (const s of live) {
    if (s.exited) continue;
    if (s.ompSessionFile) liveFiles.add(s.ompSessionFile);
    if (s.pendingUi.length > 0) needsYou.push(s);
    else if (s.isStreaming) running.push(s);
    else idle.push(s);
  }

  const buckets = new Map<HistoryGroup['key'], SavedSession[]>();
  const sorted = [...saved].sort((a, b) => b.mtime - a.mtime);
  for (const s of sorted) {
    if (s.running || liveFiles.has(s.file)) continue;
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
  return { needsYou, running, idle, history };
}
