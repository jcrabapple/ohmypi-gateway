// Fork (branch) support: pure matching and prefix logic, no stores.
//
// omp's `branch` copies the transcript strictly BEFORE the target user entry
// (a root entry starts an empty session linked to the old file), so the fork
// point's own message is expected to be absent from the forked session; the
// gateway returns its text for a composer prefill instead.

import type { SessionEntry } from './api/types';
import type { Item, UserItem } from './transcript/types';

/** User items a fork can target: settled and echoed by omp, so an entry exists. */
export function forkable(item: Item): item is UserItem {
  return item.kind === 'user' && !item.pending && !item.failed && item.text.trim().length > 0;
}

/** User texts, in order, for everything strictly before `item` (the prefix the
 *  forked session should carry). Items are matched by id; a missing target
 *  yields null, so the caller skips the prefix check instead of verifying
 *  against an empty expectation. */
export function userTextsBefore(items: readonly Item[], item: UserItem): string[] | null {
  const out: string[] = [];
  let found = false;
  for (const it of items) {
    if (it.kind === 'user' && it.id === item.id) {
      found = true;
      break;
    }
    if (forkable(it)) out.push(it.text.trim());
  }
  return found ? out : null;
}

/** The live entry for a transcript item: same timestamp. A miss means the live
 *  history diverged (compacted, another device) and the caller must confirm
 *  before forking instead of navigating blind. */
export function entryForItem(item: UserItem, entries: readonly SessionEntry[]): SessionEntry | null {
  const ts = item.timestamp;
  if (typeof ts !== 'number') return null;
  return entries.find((e) => e.role === 'user' && e.timestamp === ts) ?? null;
}

function textBlock(b: unknown): string {
  if (!b || typeof b !== 'object' || !('type' in b) || b.type !== 'text') return '';
  return 'text' in b && typeof b.text === 'string' ? b.text : '';
}

/** User texts from gateway messages (the forked session's transcript). Mirrors
 *  the reducer exactly: skill prompts are skill items, not user bubbles, and a
 *  message's text blocks concatenate into ONE entry per message. */
export function userTexts(
  messages: readonly { role?: string; customType?: unknown; content?: unknown }[],
): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || m.customType === 'skill-prompt') continue;
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map(textBlock).join('') : '';
    const t = text.trim();
    if (t) out.push(t);
  }
  return out;
}

/** True when the forked session's transcript does not start with the expected
 *  ancestor prefix. Only the prefix is compared; extra history after it is fine. */
export function prefixMissing(expected: readonly string[], actual: readonly string[]): boolean {
  if (actual.length < expected.length) return true;
  return expected.some((t, i) => actual[i] !== t);
}
