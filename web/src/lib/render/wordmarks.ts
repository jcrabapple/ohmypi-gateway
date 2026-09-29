// Word-level change marks for diff rows. Pure string work: given the old and
// new text of a paired -/+ row, find the shared word prefix/suffix and return
// the character range in between that actually changed. Used by DiffBlock to
// place <mark> inside highlighted lines.

export interface Range {
  start: number;
  end: number;
}

interface Tok {
  text: string;
  start: number;
  end: number;
}

/** Identifier runs stay whole; whitespace runs and single punctuation chars are tokens too. */
const TOKEN = /[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]/g;

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  for (const m of s.matchAll(TOKEN)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** Changed share of a string; an empty string counts as fully changed. */
function changedRatio(s: string, r: Range): number {
  if (s.length === 0) return 1;
  return (r.end - r.start) / s.length;
}

/**
 * Character range of the changed middle of `s`, from `from` to `to` token indexes.
 * An empty middle collapses to the insertion point.
 */
function rangeOf(t: readonly Tok[], from: number, to: number): Range {
  if (from < to) return { start: t[from]!.start, end: t[to - 1]!.end };
  const at = Math.min(from, t.length);
  const edge = at === 0 ? 0 : (t[at - 1] ?? { end: 0 }).end;
  return { start: edge, end: edge };
}

/**
 * Word-level marks for a pair of changed lines: common token prefix and suffix,
 * whatever is in between changed. Null when nothing changed or so much changed
 * (more than ~70% of both strings) that marks would just be noise.
 */
export function wordMarks(a: string, b: string): [Range, Range] | null {
  if (a === b) return null;
  const ta = tokenize(a);
  const tb = tokenize(b);
  const min = Math.min(ta.length, tb.length);
  let pre = 0;
  while (pre < min && ta[pre]!.text === tb[pre]!.text) pre++;
  let suf = 0;
  const maxSuf = min - pre;
  while (suf < maxSuf && ta[ta.length - 1 - suf]!.text === tb[tb.length - 1 - suf]!.text) suf++;
  if (ta.length - pre - suf <= 0 && tb.length - pre - suf <= 0) return null;

  const ra = rangeOf(ta, pre, ta.length - suf);
  const rb = rangeOf(tb, pre, tb.length - suf);
  if (changedRatio(a, ra) > 0.7 && changedRatio(b, rb) > 0.7) return null;
  return [ra, rb];
}

/**
 * Insert <mark> around the character range `start..end` (offsets into the
 * original text) of highlight.js output. The input is already safe HTML from
 * our own highlight pipeline; this only ever adds <mark> tags and never
 * touches the escaped content. A range that crosses a tag is split into one
 * mark per side instead of nesting across the tag. Entities count as one
 * character.
 */
export function markHtml(html: string, start: number, end: number): string {
  if (!(start < end)) return html;
  const ENTITY = /^&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;
  let out = '';
  let opened = false;
  let pos = 0;
  let i = 0;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === '<') {
      const close = html.indexOf('>', i);
      const stop = close === -1 ? html.length : close + 1;
      if (opened) {
        out += '</mark>';
        opened = false;
      }
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    if (opened && pos >= end) return out + '</mark>' + html.slice(i);
    if (!opened && pos >= start && pos < end) {
      out += '<mark>';
      opened = true;
    }
    const entity = ch === '&' ? ENTITY.exec(html.slice(i, i + 64)) : null;
    const unit = entity ? entity[0] : ch;
    out += unit;
    i += unit.length;
    pos += 1;
  }
  return opened ? out + '</mark>' : out;
}
