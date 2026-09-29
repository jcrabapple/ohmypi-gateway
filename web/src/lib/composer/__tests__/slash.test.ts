import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '../../api/types';
import { filterCommands, flattenGroups, slashQuery, slashText, wantsInput } from '../slash';

const cmds: SlashCommand[] = [
  { name: 'compact', description: 'Compact the context', source: 'builtin' },
  { name: 'model', description: 'Pick a model', source: 'builtin' },
  { name: 'skill:humanizer', description: 'Rewrite text', source: 'skill' },
  { name: 'deploy', description: 'Deploy it', source: 'extension', input: { hint: '<env>' } },
  { name: 'review', description: 'Review changes', source: 'custom' },
];

describe('slash menu', () => {
  it('opens only while the draft is a single slash token', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/comp')).toBe('comp');
    expect(slashQuery('/compact now')).toBeNull();
    expect(slashQuery('hello /x')).toBeNull();
  });

  it('groups by source in a fixed order when the query is empty', () => {
    const g = filterCommands(cmds, '');
    expect(g.map((x) => x.key)).toEqual(['commands', 'skills', 'extensions', 'custom']);
    expect(g[0]!.items.map((m) => m.command.name)).toEqual(['compact', 'model']);
  });

  it('filters by name and drops empty groups', () => {
    const g = filterCommands(cmds, 'mod');
    expect(g.map((x) => x.key)).toEqual(['commands']);
    expect(flattenGroups(g).map((m) => m.command.name)).toEqual(['model']);
  });

  it('matches a skill by its bare name', () => {
    expect(flattenGroups(filterCommands(cmds, 'hum')).map((m) => m.command.name)).toEqual(['skill:humanizer']);
  });

  it('fuzzy matches a subsequence and ranks prefix hits first', () => {
    const names = flattenGroups(filterCommands(cmds, 'cmp')).map((m) => m.command.name);
    expect(names).toContain('compact');
    const same: SlashCommand[] = [
      { name: 'undo-remove', description: '', source: 'builtin' },
      { name: 'remove', description: '', source: 'builtin' },
    ];
    expect(flattenGroups(filterCommands(same, 'rem'))[0]!.command.name).toBe('remove');
  });

  it('returns nothing when nothing matches', () => {
    expect(filterCommands(cmds, 'zzz')).toEqual([]);
  });

  it('commands that take input are inserted, not sent', () => {
    expect(wantsInput(cmds[3]!)).toBe(true);
    expect(wantsInput(cmds[0]!)).toBe(false);
    expect(slashText(cmds[3]!)).toBe('/deploy ');
  });
});
