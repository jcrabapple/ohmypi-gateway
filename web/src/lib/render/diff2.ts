// Structured parsing of omp's line-numbered diff format, plus the extraction of
// per-file changes from edit/write tool results.
//
// Format (verified against the live gateway, see docs/research/omp-companion-review.md):
//   " 1|alpha"  context, old line 1      "-2|beta"  removed, was line 2
//   "+2|delta"  added, now line 2        ""         blank line splits hunks
//   "... skipped 12 unchanged lines"     gap note
// The existing diff.ts `looksLikeDiff` fallback for arbitrary tool output stays
// untouched; this module is for results that carry the structured format.
import { wordMarks, type Range } from './wordmarks';

export type DiffRowType = 'ctx' | 'add' | 'del' | 'gap';

export interface DiffRow {
  t: DiffRowType;
  /** Old line number (ctx, del). */
  o?: number;
  /** New line number (add). */
  n?: number;
  text: string;
}

export interface DiffHunk {
  lines: DiffRow[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  adds: number;
  dels: number;
}

export interface FileChange {
  path: string;
  /** omp's op: update, create, write, delete, ... */
  op: string;
  /** The omp-format diff text (synthesized for writes that have no result diff). */
  diff: string;
  adds: number;
  dels: number;
  created: boolean;
}

/** Cap for the synthesized all-additions diff of a `write` tool call. */
export const WRITE_DIFF_CAP = 60 * 1024;

/** Virtual URIs (xd://, https://, ...) are not file changes. */
const VIRTUAL = /^[a-z][\w+.-]+:\/\//i;

const ROW = /^([ +-])(\d+)\|(.*)$/;
const GAP = /^\.{3}\s*(.*)$/;

export function parseOmpDiff(diff: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let cur: DiffRow[] = [];
  let adds = 0;
  let dels = 0;
  // New-line offset carried across the whole diff: adds shift later context
  // rows down, deletes shift them up. Skipped context (gaps) moves both sides
  // equally and leaves the delta alone.
  let delta = 0;
  const flush = () => {
    if (cur.length) hunks.push({ lines: cur });
    cur = [];
  };
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') {
      flush();
      continue;
    }
    const m = ROW.exec(line);
    if (m) {
      const text = m[3] ?? '';
      const n = Number(m[2]);
      if (m[1] === '+') {
        adds += 1;
        delta += 1;
        cur.push({ t: 'add', n, text });
      } else if (m[1] === '-') {
        dels += 1;
        delta -= 1;
        cur.push({ t: 'del', o: n, text });
      } else {
        cur.push({ t: 'ctx', o: n, n: n + delta, text });
      }
      continue;
    }
    const g = GAP.exec(line);
    cur.push({ t: 'gap', text: g ? (g[1] ?? '') : line });
  }
  flush();
  return { hunks, adds, dels };
}

interface Rec {
  [k: string]: unknown;
}

function rec(v: unknown): Rec | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
}

function toFile(path: string, op: string, diff: string): FileChange {
  const p = parseOmpDiff(diff);
  const rows = p.hunks.flatMap((h) => h.lines);
  const firstAdd = rows.find((l) => l.t === 'add')?.n;
  // A new file has nothing but additions starting at line 1; an insert at the
  // top of an existing file still shows context rows around it.
  const created =
    op === 'create' || (p.dels === 0 && p.adds > 0 && firstAdd === 1 && !rows.some((l) => l.t === 'ctx'));
  return { path, op, diff, adds: p.adds, dels: p.dels, created };
}

/** omp-format all-additions diff from write tool call arguments, capped at WRITE_DIFF_CAP. */
function synthesizeAdditions(content: string): string {
  if (content === '') return '';
  const lines = content.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.endsWith('\r') ? lines[i]!.slice(0, -1) : lines[i]!;
    const row = `+${i + 1}|${text}`;
    const cost = row.length + (parts.length ? 1 : 0);
    if (len + cost > WRITE_DIFF_CAP) {
      parts.push(`... truncated at 60 KB, ${lines.length - parts.length} more lines`);
      return parts.join('\n');
    }
    parts.push(row);
    len += cost;
  }
  return parts.join('\n');
}

/**
 * Per-file changes carried by one tool result.
 * `args` are the tool call arguments (without omp's `i` intent key); `details`
 * is the result's details object. History toolResult messages and live
 * tool_execution_end events feed this the same shapes, so both produce the
 * same files for the same turn.
 */
export function extractFiles(toolName: string, args: Rec | undefined, details: unknown): FileChange[] {
  const d = rec(details);
  // Keyed by path so a repeated entry for the same file keeps only the latest diff.
  const byPath = new Map<string, FileChange>();
  if (d) {
    const per = Array.isArray(d.perFileResults) ? d.perFileResults : [];
    for (const item of per) {
      const o = rec(item);
      if (!o || typeof o.path !== 'string' || typeof o.diff !== 'string') continue;
      if (VIRTUAL.test(o.path)) continue;
      byPath.set(o.path, toFile(o.path, typeof o.op === 'string' ? o.op : 'update', o.diff));
    }
    if (byPath.size) return [...byPath.values()];
    if (typeof d.diff === 'string' && d.diff) {
      const path =
        typeof d.path === 'string' && d.path ? d.path : typeof args?.path === 'string' ? args.path : '';
      if (path && !VIRTUAL.test(path)) {
        byPath.set(path, toFile(path, typeof d.op === 'string' ? d.op : 'update', d.diff));
      }
      return [...byPath.values()];
    }
  }
  if (toolName === 'write' && args) {
    const path =
      (typeof d?.resolvedPath === 'string' && d.resolvedPath) ||
      (typeof args.path === 'string' ? args.path : '');
    const content = typeof args.content === 'string' ? args.content : undefined;
    if (path && content !== undefined && !VIRTUAL.test(path)) {
      // A write replaces the whole file: mark it created so it renders unified with an A badge.
      return [{ ...toFile(path, 'write', synthesizeAdditions(content)), created: true }];
    }
  }
  return [];
}

/**
 * Pair each -/+ run and compute word-level marks per row index. Rows outside
 * pairs (context, gap notes, fully rewritten lines) have no entry.
 */
export function rowMarks(lines: readonly DiffRow[]): Map<number, Range> {
  const marks = new Map<number, Range>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.t !== 'del') {
      i += 1;
      continue;
    }
    let d1 = i;
    while (d1 + 1 < lines.length && lines[d1 + 1]!.t === 'del') d1 += 1;
    const a0 = d1 + 1;
    if (a0 < lines.length && lines[a0]!.t === 'add') {
      let a1 = a0;
      while (a1 + 1 < lines.length && lines[a1 + 1]!.t === 'add') a1 += 1;
      const pairs = Math.min(d1 - i + 1, a1 - a0 + 1);
      for (let k = 0; k < pairs; k++) {
        const wm = wordMarks(lines[i + k]!.text, lines[a0 + k]!.text);
        if (wm) {
          marks.set(i + k, wm[0]);
          marks.set(a0 + k, wm[1]);
        }
      }
      i = a1 + 1;
    } else {
      i = d1 + 1;
    }
  }
  return marks;
}

/** Map a file path to a registered highlight.js language, or null for plain text. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  py: 'python', pyi: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  css: 'css',
  html: 'xml', htm: 'xml', svg: 'xml', xml: 'xml',
  go: 'go', rs: 'rust', sql: 'sql',
  md: 'markdown', markdown: 'markdown',
  ini: 'ini', cfg: 'ini', toml: 'ini', conf: 'ini',
  diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile',
};

export function extLang(path: string): string | null {
  const base = path.split('/').at(-1) ?? '';
  if (!base) return null;
  const byName = EXT_LANG[base.toLowerCase()];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? null;
}
