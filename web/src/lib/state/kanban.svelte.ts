// Pure kanban helpers + reactive store for per-project kanban boards.
import { isAbortError } from '../api/client';
import { kanban as api } from '../api/endpoints';
import type { KanbanBoard, KanbanBoardSummary, KanbanColumnId, KanbanTicket } from '../api/types';

export const KANBAN_COLUMNS: readonly { id: KanbanColumnId; title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
];

export const KANBAN_CLAIM_TTL_MS = 45 * 60 * 1000;

export function kanbanIdNumber(id: string): number {
  const m = /^K-(\d+)$/i.exec(id.trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

export function formatKanbanPriority(priority: number): string {
  return Number.isInteger(priority) ? `p${priority}` : `p${priority}`;
}

export function isTicketClaimed(ticket: Pick<KanbanTicket, 'claimed_at'>, nowMs = Date.now()): boolean {
  if (!ticket.claimed_at) return false;
  const parsed = Date.parse(ticket.claimed_at);
  if (!Number.isFinite(parsed)) return false;
  return nowMs - parsed < KANBAN_CLAIM_TTL_MS;
}

export function doneTicketIds(board: Pick<KanbanBoard, 'tickets'>): Set<string> {
  const out = new Set<string>();
  for (const t of board.tickets) {
    if (t.column === 'done') out.add(t.id.toUpperCase());
  }
  return out;
}

export function unmetBlockers(ticket: Pick<KanbanTicket, 'blocked_by'>, doneIds: ReadonlySet<string>): string[] {
  if (!ticket.blocked_by.length) return [];
  return ticket.blocked_by.filter((b) => !doneIds.has(b.toUpperCase()));
}

export function allBoardTags(board: Pick<KanbanBoard, 'tickets'>): string[] {
  const set = new Set<string>();
  for (const t of board.tickets) {
    for (const tag of t.tags) set.add(tag);
  }
  return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export function ticketsInColumn(
  board: Pick<KanbanBoard, 'tickets'>,
  column: KanbanColumnId,
  opts: { tag?: string | null; query?: string } = {},
): KanbanTicket[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const tag = (opts.tag ?? '').trim();
  const out = board.tickets.filter((t) => {
    if (t.column !== column) return false;
    if (tag && !t.tags.includes(tag)) return false;
    if (!q) return true;
    return (
      t.id.toLowerCase().includes(q) ||
      t.title.toLowerCase().includes(q) ||
      t.body.toLowerCase().includes(q) ||
      t.tags.some((tg) => tg.toLowerCase().includes(q))
    );
  });
  out.sort((a, b) => a.priority - b.priority || kanbanIdNumber(a.id) - kanbanIdNumber(b.id));
  return out;
}

export function countInColumn(board: Pick<KanbanBoard, 'tickets'>, column: KanbanColumnId): number {
  let n = 0;
  for (const t of board.tickets) if (t.column === column) n++;
  return n;
}

export function openTicketCount(summary: Pick<KanbanBoardSummary, 'counts'>): number {
  return (summary.counts.todo ?? 0) + (summary.counts.doing ?? 0) + (summary.counts.review ?? 0);
}

export function splitCsvList(raw: string, opts: { upper?: boolean; stripHash?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    let s = part.trim();
    if (opts.stripHash) s = s.replace(/^#+/, '').trim();
    if (!s) continue;
    if (opts.upper) s = s.toUpperCase();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

class KanbanStore {
  boards = $state.raw<KanbanBoardSummary[]>([]);
  boardsLoaded = $state(false);
  boardsLoading = $state(false);
  boardsError = $state<string | null>(null);

  board = $state.raw<KanbanBoard | null>(null);
  boardLoading = $state(false);
  boardError = $state<string | null>(null);
  mutating = $state(false);

  private activeCwd: string | null = null;
  private boardsGen = 0;
  private boardsCtrl: AbortController | null = null;
  private boardGen = 0;
  private boardCtrl: AbortController | null = null;

  async loadBoards(): Promise<void> {
    this.boardsCtrl?.abort();
    const ctrl = new AbortController();
    this.boardsCtrl = ctrl;
    const gen = ++this.boardsGen;
    this.boardsLoading = true;
    this.boardsError = null;
    try {
      const res = await api.boards(ctrl.signal);
      if (gen !== this.boardsGen || ctrl.signal.aborted) return;
      this.boards = res.boards;
      this.boardsLoaded = true;
    } catch (e) {
      if (isAbortError(e) || gen !== this.boardsGen) return;
      this.boardsError = e instanceof Error ? e.message : 'Could not load boards';
    } finally {
      if (gen === this.boardsGen) this.boardsLoading = false;
    }
  }

  async loadBoard(cwd: string): Promise<void> {
    this.boardCtrl?.abort();
    const ctrl = new AbortController();
    this.boardCtrl = ctrl;
    const gen = ++this.boardGen;
    if (this.activeCwd !== cwd) {
      this.board = null;
      this.activeCwd = cwd;
    }
    this.boardLoading = true;
    this.boardError = null;
    try {
      const res = await api.board(cwd, ctrl.signal);
      if (gen !== this.boardGen || ctrl.signal.aborted) return;
      this.board = res;
      this.activeCwd = res.cwd || cwd;
    } catch (e) {
      if (isAbortError(e) || gen !== this.boardGen) return;
      this.boardError = e instanceof Error ? e.message : 'Could not load board';
    } finally {
      if (gen === this.boardGen) this.boardLoading = false;
    }
  }

  clearBoard(): void {
    this.boardCtrl?.abort();
    this.boardGen++;
    this.activeCwd = null;
    this.board = null;
    this.boardLoading = false;
    this.boardError = null;
  }

  private applyBoard(next: KanbanBoard): void {
    this.boardGen++;
    this.board = next;
    this.activeCwd = next.cwd;
  }

  private async mutate<T>(fn: () => Promise<T>, pickBoard: (res: T) => KanbanBoard): Promise<T> {
    this.mutating = true;
    try {
      const res = await fn();
      this.applyBoard(pickBoard(res));
      return res;
    } finally {
      this.mutating = false;
    }
  }

  async initBoard(cwd: string): Promise<KanbanBoard> {
    return this.mutate(() => api.init(cwd), (b) => b);
  }

  async addTicket(body: Parameters<typeof api.add>[0]): Promise<KanbanBoard> {
    const res = await this.mutate(() => api.add(body), (r) => r.board);
    return res.board;
  }

  async updateTicket(body: Parameters<typeof api.update>[0]): Promise<KanbanBoard> {
    const res = await this.mutate(() => api.update(body), (r) => r.board);
    return res.board;
  }

  async moveTicket(
    cwd: string,
    id: string,
    column: KanbanColumnId,
    position?: number,
  ): Promise<KanbanBoard> {
    const res = await this.mutate(
      () => api.move({ cwd, id, column, ...(position !== undefined ? { position } : {}) }),
      (r) => r.board,
    );
    return res.board;
  }

  async addNote(cwd: string, id: string, text: string): Promise<KanbanBoard> {
    const res = await this.mutate(() => api.note({ cwd, id, text }), (r) => r.board);
    return res.board;
  }

  async claimTicket(cwd: string, id: string, by = 'omp-web'): Promise<KanbanBoard> {
    const res = await this.mutate(() => api.claim({ cwd, id, by }), (r) => r.board);
    return res.board;
  }

  async releaseTicket(cwd: string, id: string, note?: string): Promise<KanbanBoard> {
    const res = await this.mutate(
      () => api.release({ cwd, id, ...(note ? { note } : {}) }),
      (r) => r.board,
    );
    return res.board;
  }

  async deleteTicket(cwd: string, id: string): Promise<KanbanBoard> {
    const res = await this.mutate(() => api.delete({ cwd, id }), (r) => r.board);
    return res.board;
  }

  async archiveOldDone(cwd: string, olderThanDays = 7): Promise<number> {
    const res = await this.mutate(
      () => api.archive({ cwd, older_than_days: olderThanDays }),
      (r) => r.board,
    );
    return res.moved;
  }
}

export const kanbanStore = new KanbanStore();
