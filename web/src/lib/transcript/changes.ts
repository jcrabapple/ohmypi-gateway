// Roll-up of every file a session touched: latest diff per path wins, edits
// count every file-change entry before the per-path dedupe, and the +/-
// totals come from the diffs that are shown.
import type { FileChange } from '../render/diff2';
import type { Item } from './types';

export interface ChangeGroup {
  path: string;
  file: FileChange;
}

export interface ChangesRollup {
  groups: ChangeGroup[];
  files: number;
  edits: number;
  adds: number;
  dels: number;
}

export function collectChanges(items: readonly Item[]): ChangesRollup {
  const byPath = new Map<string, FileChange>();
  let edits = 0;
  for (const it of items) {
    // A failed tool changed nothing on disk.
    if (it.kind !== 'tool' || it.status === 'error' || !it.files) continue;
    for (const f of it.files) {
      edits += 1;
      byPath.set(normPath(f.path), f);
    }
  }
  let adds = 0;
  let dels = 0;
  const groups: ChangeGroup[] = [];
  for (const [path, file] of byPath) {
    groups.push({ path, file });
    adds += file.adds;
    dels += file.dels;
  }
  return { groups, files: groups.length, edits, adds, dels };
}

/** Group key for a path: separators unified, trailing separators dropped. */
function normPath(path: string): string {
  const s = path.replace(/\\/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}
