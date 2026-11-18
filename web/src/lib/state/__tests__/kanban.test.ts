import { describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanTicket } from '../../api/types';
import {
  allBoardTags, countInColumn, doneTicketIds, formatKanbanPriority, isTicketClaimed,
  KANBAN_CLAIM_TTL_MS, kanbanIdNumber, openTicketCount, splitCsvList, ticketsInColumn,
  unmetBlockers,
} from '../kanban.svelte';

function ticket(id: string, over: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id,
    title: `Ticket ${id}`,
    body: '',
    column: 'todo',
    priority: 100,
    tags: [],
    blocked_by: [],
    created: '2026-11-16T00:00:00.000Z',
    updated: '2026-11-16T00:00:00.000Z',
    notes: [],
    ...over,
  };
}

describe('kanban pure helpers', () => {
  it('parses K-<n> ids and formats integer vs fractional priorities', () => {
    expect(kanbanIdNumber('K-1')).toBe(1);
    expect(kanbanIdNumber('k-42')).toBe(42);
    expect(kanbanIdNumber('bad')).toBe(Number.MAX_SAFE_INTEGER);
    expect(formatKanbanPriority(10)).toBe('p10');
    expect(formatKanbanPriority(1.5)).toBe('p1.5');
  });

  it('respects the 45-minute claim TTL', () => {
    const now = Date.parse('2026-11-16T12:00:00.000Z');
    const fresh = ticket('K-1', { claimed_at: new Date(now - 5 * 60_000).toISOString() });
    const expired = ticket('K-2', { claimed_at: new Date(now - KANBAN_CLAIM_TTL_MS - 1000).toISOString() });
    expect(isTicketClaimed(fresh, now)).toBe(true);
    expect(isTicketClaimed(expired, now)).toBe(false);
    expect(isTicketClaimed(ticket('K-3'), now)).toBe(false);
  });

  it('computes unmet blockers against done ticket ids case-insensitively', () => {
    const board: Pick<KanbanBoard, 'tickets'> = {
      tickets: [
        ticket('K-1', { column: 'done' }),
        ticket('K-2', { column: 'doing' }),
        ticket('K-3', { column: 'todo', blocked_by: ['k-1', 'K-2', 'K-99'] }),
      ],
    };
    const done = doneTicketIds(board);
    expect(unmetBlockers(board.tickets[2]!, done)).toEqual(['K-2', 'K-99']);
  });

  it('filters by column, tag, and query, and sorts by priority then numeric id', () => {
    const board: Pick<KanbanBoard, 'tickets'> = {
      tickets: [
        ticket('K-10', { column: 'todo', priority: 20, tags: ['ui'], title: 'Second' }),
        ticket('K-2', { column: 'todo', priority: 20, tags: ['ui', 'bug'], title: 'First' }),
        ticket('K-1', { column: 'todo', priority: 5, tags: ['api'], title: 'Urgent' }),
        ticket('K-3', { column: 'done', priority: 1, tags: ['ui'], title: 'Done one' }),
      ],
    };

    expect(ticketsInColumn(board, 'todo').map((t) => t.id)).toEqual(['K-1', 'K-2', 'K-10']);
    expect(ticketsInColumn(board, 'todo', { tag: 'ui' }).map((t) => t.id)).toEqual(['K-2', 'K-10']);
    expect(ticketsInColumn(board, 'todo', { query: 'first' }).map((t) => t.id)).toEqual(['K-2']);
    expect(countInColumn(board, 'todo')).toBe(3);
    expect(allBoardTags(board)).toEqual(['api', 'bug', 'ui']);
    expect(openTicketCount({ counts: { todo: 3, doing: 1, review: 2, done: 4 } })).toBe(6);
  });

  it('splits CSV tags and blockers cleanly', () => {
    expect(splitCsvList(' #ui, bug , ui, ', { stripHash: true })).toEqual(['ui', 'bug']);
    expect(splitCsvList('k-1, K-2, k-1', { upper: true })).toEqual(['K-1', 'K-2']);
  });
});
