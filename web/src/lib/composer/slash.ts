// Slash menu: which text opens it, fuzzy filtering, grouping by source.
import type { SlashCommand, SlashSource } from '../api/types';

export type SlashGroupKey = 'commands' | 'skills' | 'extensions' | 'custom';

export interface SlashMatch {
  command: SlashCommand;
  score: number;
}

export interface SlashGroup {
  key: SlashGroupKey;
  label: string;
  items: SlashMatch[];
}

const GROUPS: { key: SlashGroupKey; label: string }[] = [
  { key: 'commands', label: 'Commands' },
  { key: 'skills', label: 'Skills' },
  { key: 'extensions', label: 'Extensions' },
  { key: 'custom', label: 'Custom' },
];

const GROUP_OF: Record<SlashSource, SlashGroupKey> = {
  builtin: 'commands',
  skill: 'skills',
  extension: 'extensions',
  custom: 'custom',
  file: 'custom',
};

/** The query after the slash when the whole draft is still one slash token, else null. */
export function slashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const rest = text.slice(1);
  return /\s/.test(rest) ? null : rest;
}

export function firstDescriptionLine(cmd: SlashCommand): string {
  return (cmd.description ?? '').split('\n', 1)[0]!.trim();
}

function subsequenceScore(needle: string, hay: string): number {
  let at = -1;
  let gaps = 0;
  for (const ch of needle) {
    const next = hay.indexOf(ch, at + 1);
    if (next < 0) return -1;
    if (at >= 0) gaps += next - at - 1;
    at = next;
  }
  return Math.max(1, 200 - gaps);
}

export function scoreCommand(cmd: SlashCommand, rawQuery: string): number {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return 0;
  const name = cmd.name.toLowerCase();
  // `skill:humanizer` should match "hum" as well as "skill:hum".
  const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  if (name === q || bare === q) return 1000;
  if (name.startsWith(q)) return 800 - (name.length - q.length);
  if (bare.startsWith(q)) return 760 - (bare.length - q.length);
  for (const a of cmd.aliases ?? []) if (a.toLowerCase().startsWith(q)) return 700;
  if (new RegExp(`[-:_/.]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) return 500;
  if (name.includes(q)) return 400;
  const sub = subsequenceScore(q, name);
  if (sub > 0) return sub;
  if (firstDescriptionLine(cmd).toLowerCase().includes(q)) return 100;
  return -1;
}

export function filterCommands(commands: readonly SlashCommand[], query: string): SlashGroup[] {
  const buckets = new Map<SlashGroupKey, SlashMatch[]>();
  for (const command of commands) {
    const score = scoreCommand(command, query);
    if (score < 0) continue;
    const key = GROUP_OF[command.source] ?? 'custom';
    const list = buckets.get(key) ?? [];
    list.push({ command, score });
    buckets.set(key, list);
  }
  const out: SlashGroup[] = [];
  for (const g of GROUPS) {
    const items = buckets.get(g.key);
    if (!items?.length) continue;
    items.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
    out.push({ ...g, items });
  }
  return out;
}

/** Keyboard order: the groups top to bottom. */
export function flattenGroups(groups: readonly SlashGroup[]): SlashMatch[] {
  return groups.flatMap((g) => g.items);
}

/** True when the command wants arguments, so selecting it should insert rather than send. */
export function wantsInput(cmd: SlashCommand): boolean {
  return Boolean(cmd.input?.hint) || (cmd.subcommands?.length ?? 0) > 0;
}

export function slashText(cmd: SlashCommand): string {
  return `/${cmd.name} `;
}
