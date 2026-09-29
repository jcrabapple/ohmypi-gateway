// Render blocks: the reducer's items with consecutive tool calls folded into one group.
import type { Item, ToolItem } from './types';

export type Block =
  | { key: string; kind: 'item'; item: Exclude<Item, ToolItem> }
  | { key: string; kind: 'tools'; tools: ToolItem[] };

export function toBlocks(items: readonly Item[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    if (item.kind === 'tool') {
      const last = out.at(-1);
      if (last?.kind === 'tools') last.tools.push(item);
      else out.push({ key: `tools:${item.id}`, kind: 'tools', tools: [item] });
    } else {
      out.push({ key: item.id, kind: 'item', item });
    }
  }
  return out;
}

/** True while the newest item is already showing progress, so no extra "Working" line is needed. */
export function showsProgress(items: readonly Item[]): boolean {
  const last = items.at(-1);
  if (!last) return false;
  if (last.kind === 'assistant' || last.kind === 'thinking') return last.streaming;
  if (last.kind === 'tool') return last.status === 'running';
  if (last.kind === 'notice') return last.active === true;
  return false;
}
