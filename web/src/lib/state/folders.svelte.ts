// Per-device rail folder filter. Hidden folders drop their saved transcripts
// out of the rail's history buckets (scheduler runs in ~, throwaway probes in
// /tmp) without deleting anything. Live sessions and pinned transcripts are
// never hidden: both are explicit "I care about this" signals. Keyed on the
// transcript's recorded cwd (falling back to omp's mangled folder name), the
// same value the rail shows under each row.
import type { SavedSession } from '../api/types';
import { device } from '../platform/storage';
import { folderKey } from './grouping';

export { folderKey };

const HIDDEN_KEY = 'ompgw-rail-hidden-folders';

function load(): Set<string> {
  const raw = device.get<unknown>(HIDDEN_KEY, []);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0));
}

export class FolderFilter {
  hidden = $state<Set<string>>(load());

  isHidden(key: string): boolean {
    return this.hidden.has(key);
  }

  toggle(key: string): void {
    const next = new Set(this.hidden);
    if (!next.delete(key)) next.add(key);
    this.save(next);
  }

  showAll(): void {
    this.save(new Set());
  }

  private save(next: Set<string>): void {
    this.hidden = next;
    device.set(HIDDEN_KEY, [...next]);
  }
}

export const folderFilter = new FolderFilter();

export interface FolderCount {
  key: string;
  count: number;
}

/** Folders present in the saved list, busiest first (ties by name). */
export function folderCounts(saved: readonly Pick<SavedSession, 'cwd' | 'cwdFolder'>[]): FolderCount[] {
  const counts = new Map<string, number>();
  for (const s of saved) {
    const key = folderKey(s);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
