// @-file mentions: which text opens the suggestion query, ranking, insertion.
// Pure and DOM-free so the whole lifecycle is testable without a component.
import type { FileIndexEntry } from '../api/types';

export interface AtQuery {
  /** Offset of the '@' (or '@"') that opened the query, in the text before the caret. */
  start: number;
  query: string;
  /** Opened with `@"`; the query may then contain spaces until a closing quote. */
  quoted: boolean;
}

/**
 * The @-query in the text before the caret, or null.
 * `@` triggers only at line start or after whitespace, so email addresses
 * never fire. The plain query is the trailing run of non-whitespace; the
 * quoted form `@"...` stays open (spaces allowed) until a closing quote.
 */
export function extractAtQuery(beforeCaret: string): AtQuery | null {
  const q = beforeCaret.lastIndexOf('@"');
  if (q !== -1) {
    const prev = beforeCaret.charAt(q - 1); // '' when the @" sits at index 0
    // Path characters count as a boundary too: `@src/@"` right after an
    // inserted mention must open, not just start-of-line/whitespace. Only `/`,
    // though: `.` and `-` would fire mid-token (user.name@", kebab-case@").
    const opened = prev === '' || /[\s/]/.test(prev);
    const rest = beforeCaret.slice(q + 2);
    // A quote on a later line is somebody else's text, so a quoted query
    // never spans a newline: an unclosed @" on its own line is just text.
    if (opened && !rest.includes('"') && !rest.includes('\n')) {
      return { start: q, query: rest, quoted: true };
    }
  }
  const m = /(?:^|\s)@(\S*)$/.exec(beforeCaret);
  if (!m) return null;
  return { start: m.index + m[0]!.indexOf('@'), query: m[1]!, quoted: false };
}

/** What to list for a query: its directory part. "src/ma" -> "src", "ma" -> "". */
export function atDirPrefix(query: string): string {
  const cut = query.lastIndexOf('/');
  return cut === -1 ? '' : query.slice(0, cut);
}

/**
 * TUI-style tiers: 0 exact prefix of path or name, 1 substring after a word
 * boundary, 2 fuzzy subsequence, 3 no match (dropped). Case-insensitive.
 */
function matchTier(entry: FileIndexEntry, q: string): number {
  const path = entry.path.toLowerCase();
  const name = entry.name.toLowerCase();
  if (path.startsWith(q) || name.startsWith(q)) return 0;
  for (const hay of [path, name]) {
    let i = hay.indexOf(q, 1); // index 0 would have been the prefix tier
    while (i !== -1) {
      if ('/_.- '.includes(hay.charAt(i - 1))) return 1;
      i = hay.indexOf(q, i + 1);
    }
  }
  return isSubsequence(q, path) || isSubsequence(q, name) ? 2 : 3;
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let h = 0; h < hay.length && i < needle.length; h++) {
    if (hay[h] === needle[i]) i++;
  }
  return i === needle.length;
}

/** Empty query order: dirs first, then files, then shorter names. */
function byEmptyOrder(a: FileIndexEntry, b: FileIndexEntry): number {
  return (
    Number(b.isDir) - Number(a.isDir) ||
    a.name.length - b.name.length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

/** Matched order ties: dirs first, then shorter paths. */
function byRankOrder(a: FileIndexEntry, b: FileIndexEntry): number {
  return (
    Number(b.isDir) - Number(a.isDir) ||
    a.path.length - b.path.length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

/**
 * Best matches first. An empty query keeps every entry in empty-order; a
 * non-empty query drops non-matches. Callers slice the top N.
 */
export function rankEntries(entries: readonly FileIndexEntry[], query: string): FileIndexEntry[] {
  const q = query.toLowerCase();
  if (q === '') return [...entries].sort(byEmptyOrder);
  const scored: { e: FileIndexEntry; tier: number }[] = [];
  for (const e of entries) {
    const tier = matchTier(e, q);
    if (tier < 3) scored.push({ e, tier });
  }
  return scored.sort((a, b) => a.tier - b.tier || byRankOrder(a.e, b.e)).map((s) => s.e);
}

/**
 * Where the @-token being replaced ends, given the full text. For a quoted
 * token that is the closing quote plus one - but only when that quote sits
 * on the same line as the trigger; a quote on a later line is somebody
 * else's text, and an unclosed token ends where the typing stopped, at
 * `at.start + 2 + at.query.length`. Never extends past a newline.
 */
function tokenEnd(text: string, at: AtQuery): number {
  if (!at.quoted) {
    let end = at.start + 1;
    while (end < text.length && !/\s/.test(text.charAt(end))) end++;
    return end;
  }
  const close = text.indexOf('"', at.start + 2);
  const newline = text.indexOf('\n', at.start + 2);
  if (close !== -1 && (newline === -1 || close < newline)) return close + 1;
  return at.start + 2 + at.query.length;
}

/**
 * Replace the whole @-token at `at` with the picked path (quoted when the
 * path needs it). The token runs from the trigger through everything being
 * typed, so a mid-word caret (`@src/m|ain.ts`) replaces the trailing junk
 * too. Takes the full text, not just the part before the caret. One space is
 * added after the token only when the next character is neither whitespace
 * nor the end of the text; an existing separator is kept as is. Returns the
 * new full text and the caret offset inside it.
 */
export function insertMention(text: string, at: AtQuery, path: string): { text: string; caret: number } {
  const end = tokenEnd(text, at);
  const token = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  const gap = end < text.length && !/\s/.test(text.charAt(end)) ? ' ' : '';
  return {
    text: text.slice(0, at.start) + token + gap + text.slice(end),
    caret: at.start + token.length + gap.length,
  };
}
