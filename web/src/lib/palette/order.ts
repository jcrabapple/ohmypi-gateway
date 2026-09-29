// Which live session comes "next": pure helpers over the rail's own order.
import type { SessionInfo } from '../api/types';
import type { SessionGroups } from '../state/grouping';

/** Live sessions top to bottom as the rail lists them. */
export function railOrder(groups: Pick<SessionGroups, 'needsYou' | 'running' | 'review' | 'idle'>): SessionInfo[] {
  return [...groups.needsYou, ...groups.running, ...groups.review, ...groups.idle];
}

/** The next session with a request waiting, scanning down the rail from `currentId` and wrapping. Null when none is waiting. */
export function nextAttentionId(order: readonly SessionInfo[], currentId: string | null): string | null {
  if (!order.some((s) => s.pendingUi.length > 0)) return null;
  const at = order.findIndex((s) => s.gwId === currentId);
  for (let step = 1; step <= order.length; step++) {
    const s = order[(at + step + order.length) % order.length]!;
    if (s.pendingUi.length > 0) return s.gwId;
  }
  return null;
}

/** The session above (-1) or below (+1) `currentId`, wrapping. With none open, the first or last. */
export function adjacentId(order: readonly SessionInfo[], currentId: string | null, dir: 1 | -1): string | null {
  if (!order.length) return null;
  const at = order.findIndex((s) => s.gwId === currentId);
  if (at < 0) return order[dir === 1 ? 0 : order.length - 1]!.gwId;
  return order[(at + dir + order.length) % order.length]!.gwId;
}
