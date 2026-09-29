// Unified-diff detection and line coloring for tool output. Output is escaped;
// only our own class names are added.
import { escapeHtml } from './escape';

/** True for output that looks like a unified diff: hunk headers, or +/- runs with file headers. */
export function looksLikeDiff(text: string): boolean {
  if (!text) return false;
  const lines = text.split('\n', 400);
  let hunks = 0;
  let adds = 0;
  let dels = 0;
  let headers = 0;
  for (const l of lines) {
    if (l.startsWith('@@')) hunks++;
    else if (l.startsWith('diff --git') || l.startsWith('--- ') || l.startsWith('+++ ')) headers++;
    else if (l.startsWith('+')) adds++;
    else if (l.startsWith('-')) dels++;
  }
  if (hunks > 0 && (adds > 0 || dels > 0)) return true;
  return headers >= 2 && (adds > 0 || dels > 0);
}

export function diffToHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let cls = 'diff-ctx';
      if (line.startsWith('@@')) cls = 'diff-hunk';
      else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'diff-meta';
      else if (line.startsWith('+')) cls = 'diff-add';
      else if (line.startsWith('-')) cls = 'diff-del';
      return `<span class="${cls}">${escapeHtml(line) || ' '}</span>`;
    })
    .join('');
}
