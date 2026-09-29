// Pure todo-plan helpers, shared by the plan store and the state poll in
// active.svelte.ts. Live captures (2026-09-29) show phases shaped
// {name, tasks: [{content, status, blocker?}]} where both ids may be absent
// and `blocked` carries a human-readable `blocker`.
import type { TodoPhase, TodoStatus, TodoTask } from '../api/types';

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'blocked'];

/** Optional trimmed string; ids, names and blockers are absent or empty in parts of the live capture. */
function optText(v: unknown): string | undefined {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || undefined;
}

function isTodoStatus(v: unknown): v is TodoStatus {
  return STATUSES.includes(v as TodoStatus);
}

function task(raw: unknown): TodoTask | null {
  if (!raw || typeof raw !== 'object' || !('content' in raw)) return null;
  const content = optText(raw.content);
  if (!content) return null;
  return {
    id: 'id' in raw ? optText(raw.id) : undefined,
    content,
    status: 'status' in raw && isTodoStatus(raw.status) ? raw.status : 'pending',
    blocker: 'blocker' in raw ? optText(raw.blocker) : undefined,
  };
}

function phase(raw: unknown): TodoPhase | null {
  if (!raw || typeof raw !== 'object' || !('tasks' in raw) || !Array.isArray(raw.tasks)) return null;
  const list = raw.tasks.map(task).filter((t) => t !== null);
  if (!list.length) return null;
  return {
    id: 'id' in raw ? optText(raw.id) : undefined,
    name: 'name' in raw ? optText(raw.name) : undefined,
    tasks: list,
  };
}

/** Coerce omp's todoPhases into typed phases; drops junk entries and phases without tasks. */
export function normalizePhases(raw: unknown): TodoPhase[] {
  return Array.isArray(raw) ? raw.map(phase).filter((p) => p !== null) : [];
}

/** First in_progress task, else first pending, else first blocked; null when nothing is open. */
export function pickActiveTask(phases: readonly TodoPhase[]): TodoTask | null {
  for (const want of ['in_progress', 'pending', 'blocked'] as const) {
    for (const p of phases) {
      const hit = p.tasks.find((t) => t.status === want);
      if (hit) return hit;
    }
  }
  return null;
}

export function countDone(phases: readonly TodoPhase[]): number {
  return phases.reduce((n, p) => n + p.tasks.filter((t) => t.status === 'completed').length, 0);
}

export function countTotal(phases: readonly TodoPhase[]): number {
  return phases.reduce((n, p) => n + p.tasks.length, 0);
}

/** True when some task is in_progress: the session is working even between agent turns. */
export function hasActiveTodo(state: { todoPhases?: TodoPhase[] | null } | null | undefined): boolean {
  return normalizePhases(state?.todoPhases).some((p) => p.tasks.some((t) => t.status === 'in_progress'));
}
