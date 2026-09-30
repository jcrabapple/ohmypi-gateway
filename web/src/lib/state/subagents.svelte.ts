// Live subagent roster for the open session, folded from subagent_progress and
// subagent_lifecycle frames. The gateway subscribes at `progress` level right after
// v2 negotiation, so frames only arrive while the session is open here; a reconnect
// catches up from the REST registry snapshot via seed().
import type {
  OmpEvent, SubagentStatus, UnknownEvent,
} from '../api/types';

export interface SubagentRow {
  /** progress.id, or `#index` while omp has not assigned one. Stable merge key. */
  key: string;
  id: string | null;
  index: number | null;
  agent: string;
  status: SubagentStatus;
  task: string;
  assignment: string;
  /** lifecycle description; progress frames do not carry one. */
  description: string;
  currentTool: string;
  tokens: number | null;
  cost: number | null;
  toolCount: number | null;
  durationMs: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  retry: { attempt: number; maxAttempts: number } | null;
  model: string;
  sessionFile: string;
  detached: boolean;
  /** Arrival counter, breaks ties for rows whose index is still unknown. */
  seq: number;
}

const PROGRESS_STATUS: Record<string, SubagentStatus> = {
  pending: 'pending', running: 'running', completed: 'completed', failed: 'failed', aborted: 'aborted',
};

/** Lifecycle statuses map onto SubagentStatus; `started` is display-running because
 *  the running status itself lives in progress frames. */
const LIFECYCLE_STATUS: Record<string, SubagentStatus> = {
  started: 'running', completed: 'completed', failed: 'failed', aborted: 'aborted',
};

type Rec = Record<string, unknown>;

/** Type guard for wire objects; every field read stays unknown until str/num validate it. */
function asRecord(v: unknown): Rec | null {
  return typeof v === 'object' && v !== null ? v as Rec : null;
}

function asStatus(v: unknown): SubagentStatus | undefined {
  return typeof v === 'string' ? PROGRESS_STATUS[v] : undefined;
}

/** First argument that is a finite number; everything omp sends is leniently coerced. */
function num(...vals: unknown[]): number | null {
  const v = vals.find((x) => typeof x === 'number' && Number.isFinite(x));
  return typeof v === 'number' ? v : null;
}

/** First argument that is a string; missing or junk fields collapse to ''. */
function str(...vals: unknown[]): string {
  const v = vals.find((x) => typeof x === 'string');
  return typeof v === 'string' ? v : '';
}

function flag(...vals: unknown[]): boolean | undefined {
  const v = vals.find((x) => typeof x === 'boolean');
  return typeof v === 'boolean' ? v : undefined;
}

function retryOf(rs: unknown, prev: SubagentRow['retry'] | undefined): SubagentRow['retry'] | undefined {
  const r: Rec | null = asRecord(rs);
  if (!r) return prev;
  const attempt = num(r['attempt']);
  const maxAttempts = num(r['maxAttempts']);
  if (attempt === null && maxAttempts === null) return prev;
  return { attempt: attempt ?? prev?.attempt ?? 0, maxAttempts: maxAttempts ?? prev?.maxAttempts ?? 0 };
}

class SubagentsStore {
  rows = $state.raw<SubagentRow[]>([]);
  private byKey = new Map<string, SubagentRow>();
  private order = 0;

  running = $derived(this.rows.filter((r) => r.status === 'running').length);
  failed = $derived(this.rows.filter((r) => r.status === 'failed').length);
  total = $derived(this.rows.length);
  hasAny = $derived(this.rows.length > 0);

  /** Session switch (active.close also runs it when another session opens). */
  clear(): void {
    this.byKey.clear();
    this.rows = [];
  }

  feed(event: OmpEvent | UnknownEvent): void {
    if (event.type === 'subagent_progress') {
      if (event.payload) this.foldProgress(event.payload);
    } else if (event.type === 'subagent_lifecycle') {
      if (event.payload) this.foldLifecycle(event.payload);
    }
  }

  /** Registry snapshot from GET /subagents. Entries mirror the progress payload at
   *  the top level (with an optional nested `progress`); junk entries are skipped. */
  seed(data: unknown): void {
    let list: unknown = data;
    if (!Array.isArray(list)) list = asRecord(list)?.['subagents'];
    if (!Array.isArray(list)) return;
    for (const raw of list) this.foldProgress(raw);
  }

  /** Merge one progress payload (or registry entry) into the roster by key. */
  private foldProgress(raw: unknown): void {
    const p = asRecord(raw);
    if (!p) return;
    const src = asRecord(p['progress']) ?? p;
    const id = str(src['id'], p['id']) || null;
    const index = num(src['index'], p['index']);
    const key = id || (index !== null ? `#${index}` : `#${this.order}`);
    let existing = this.byKey.get(key);
    if (id && !existing && index !== null && this.byKey.has(`#${index}`)) {
      existing = this.byKey.get(`#${index}`);
      this.byKey.delete(`#${index}`);
    }
    const seq = existing?.seq ?? ++this.order;
    const incomingStatus = asStatus(src['status']);
    const isTerminal = existing && existing.status !== 'pending' && existing.status !== 'running';
    let status: SubagentStatus = existing?.status ?? 'pending';
    if (incomingStatus) {
      if (isTerminal && (incomingStatus === 'running' || incomingStatus === 'pending')) {
        // preserve terminal status
      } else if (existing?.status === 'running' && incomingStatus === 'pending') {
        // running subagent should not regress to pending
      } else {
        status = incomingStatus;
      }
    }
    const terminal = status !== 'pending' && status !== 'running';
    this.byKey.set(key, {
      key,
      id: id || existing?.id || null,
      index: num(src['index'], p['index'], existing?.index),
      agent: str(src['agent'], p['agent'], existing?.agent),
      status,
      task: str(src['task'], p['task'], existing?.task),
      assignment: str(src['assignment'], p['assignment'], existing?.assignment),
      description: existing?.description ?? '',
      // Nothing is running once the row is terminal, whatever the last frame said.
      currentTool: terminal ? '' : str(src['currentTool'], existing?.currentTool),
      tokens: num(src['tokens'], existing?.tokens),
      cost: num(src['cost'], existing?.cost),
      toolCount: num(src['toolCount'], existing?.toolCount),
      durationMs: num(src['durationMs'], existing?.durationMs),
      contextTokens: num(src['contextTokens'], existing?.contextTokens),
      contextWindow: num(src['contextWindow'], existing?.contextWindow),
      retry: retryOf(src['retryState'], existing?.retry) ?? null,
      model: str(src['resolvedModel'], existing?.model),
      sessionFile: str(p['sessionFile'], existing?.sessionFile),
      detached: flag(p['detached']) ?? existing?.detached ?? false,
      seq,
    });
    this.publish();
  }

  private foldLifecycle(raw: unknown): void {
    const l = asRecord(raw);
    if (!l) return;
    const mapped = typeof l['status'] === 'string' ? LIFECYCLE_STATUS[l['status']] : undefined;
    if (!mapped) return;
    const id = str(l['id']) || null;
    const index = num(l['index']);
    const key = id || (index !== null ? `#${index}` : `#${this.order}`);
    let existing = this.byKey.get(key);
    if (id && !existing && index !== null && this.byKey.has(`#${index}`)) {
      existing = this.byKey.get(`#${index}`);
      this.byKey.delete(`#${index}`);
    }
    const seq = existing?.seq ?? ++this.order;
    // Terminal lifecycle statuses are authoritative; `started` only promotes rows
    // that never got a progress status and never regresses a terminal one.
    const status: SubagentStatus =
      mapped === 'running' && existing && existing.status !== 'pending' && existing.status !== 'running'
        ? existing.status
        : mapped;
    this.byKey.set(key, {
      ...(existing ?? emptyRow(key, seq)),
      key,
      id: id || existing?.id || null,
      index: num(l['index'], existing?.index),
      agent: str(l['agent'], existing?.agent),
      status,
      description: str(l['description'], existing?.description),
      currentTool: mapped === 'running' ? existing?.currentTool ?? '' : '',
      sessionFile: str(l['sessionFile'], existing?.sessionFile),
      detached: flag(l['detached']) ?? existing?.detached ?? false,
      seq,
    });
    this.publish();
  }

  private publish(): void {
    this.rows = [...this.byKey.values()].sort(
      (a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq,
    );
  }
}

/** Row shape before any progress frame has arrived. */
function emptyRow(key: string, seq: number): SubagentRow {
  return {
    key, id: null, index: null, agent: '', status: 'pending', task: '', assignment: '',
    description: '', currentTool: '', tokens: null, cost: null, toolCount: null,
    durationMs: null, contextTokens: null, contextWindow: null, retry: null,
    model: '', sessionFile: '', detached: false, seq,
  };
}

export const subagents = new SubagentsStore();
