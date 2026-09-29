import { describe, expect, it } from 'vitest';
import type { MessagesResponse } from '../../api/types';
import { emptyTranscript, reduce } from '../reducer';
import { collectChanges } from '../changes';
import type { Item } from '../types';
import editsFixture from '../__fixtures__/edits.json';

const edits = editsFixture as unknown as { messages: MessagesResponse['messages'] };
const items = reduce(emptyTranscript(), { kind: 'history', messages: edits.messages }).items;

describe('collectChanges', () => {
  it('rolls up every file change with counts', () => {
    const r = collectChanges(items);
    expect(r.groups.map((g) => g.path)).toEqual(['src/greeter.py', '/work/CHANGELOG.md', 'src/config.py', 'src/config.schema.json']);
    expect(r.files).toBe(4);
    expect(r.edits).toBe(4);
    expect(r.adds).toBe(9);
    expect(r.dels).toBe(2);
  });

  it('keeps the latest diff per path and totals from it', () => {
    const twice: Item[] = [
      ...items,
      {
        kind: 'tool',
        id: 'tool:again',
        toolCallId: 'again',
        toolName: 'edit',
        args: { path: 'src/greeter.py' },
        summary: 'src/greeter.py',
        output: '',
        status: 'done',
        files: [{ path: 'src/greeter.py', op: 'update', diff: '-1|x\n+1|y', adds: 1, dels: 1, created: false }],
      },
    ];
    const r = collectChanges(twice);
    expect(r.files).toBe(4);
    expect(r.edits).toBe(5);
    expect(r.groups[0]!.file.diff).toBe('-1|x\n+1|y');
    expect(r.adds).toBe(9);
  });

  it('ignores items without files', () => {
    expect(collectChanges([])).toEqual({ groups: [], files: 0, edits: 0, adds: 0, dels: 0 });
    const r = collectChanges(items.filter((it) => it.kind !== 'tool'));
    expect(r.files).toBe(0);
  });

  it('skips errored tools entirely', () => {
    const failed: Item = {
      kind: 'tool',
      id: 'tool:bad',
      toolCallId: 'bad',
      toolName: 'edit',
      args: { path: 'nope.py' },
      summary: 'nope.py',
      output: 'no such file',
      status: 'error',
      files: [{ path: 'nope.py', op: 'update', diff: '+1|never happened', adds: 1, dels: 0, created: false }],
    };
    const r = collectChanges([failed, ...items]);
    expect(r.files).toBe(4);
    expect(r.edits).toBe(4);
    expect(r.groups.map((g) => g.path)).not.toContain('nope.py');
  });

  it('normalizes separators and trailing slashes when grouping paths', () => {
    const entry = (path: string): Item => ({
      kind: 'tool',
      id: `tool:${path}`,
      toolCallId: path,
      toolName: 'edit',
      args: { path },
      summary: path,
      output: '',
      status: 'done',
      files: [{ path, op: 'update', diff: '+1|x', adds: 1, dels: 0, created: false }],
    });
    const r = collectChanges([entry('src\\lib\\a.ts'), entry('src/lib/a.ts'), entry('docs/'), entry('docs')]);
    expect(r.groups.map((g) => g.path)).toEqual(['src/lib/a.ts', 'docs']);
    expect(r.files).toBe(2);
  });
});
