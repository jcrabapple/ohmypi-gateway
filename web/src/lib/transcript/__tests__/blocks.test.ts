import { describe, expect, it } from 'vitest';
import { showsProgress, toBlocks } from '../blocks';
import type { Item, ToolItem } from '../types';

const tool = (id: string, status: ToolItem['status'] = 'done'): ToolItem =>
  ({ kind: 'tool', id, name: 'bash', status } as unknown as ToolItem);
const user = (id: string): Item => ({ kind: 'user', id, text: 'hi' } as unknown as Item);
const assistant = (id: string, streaming: boolean): Item =>
  ({ kind: 'assistant', id, text: 'x', streaming } as unknown as Item);

describe('toBlocks', () => {
  it('folds consecutive tools and keeps other items in order', () => {
    const b = toBlocks([user('u'), tool('t1'), tool('t2'), assistant('a', false), tool('t3')]);
    expect(b.map((x) => x.kind)).toEqual(['item', 'tools', 'item', 'tools']);
    expect(b[1]).toMatchObject({ key: 'tools:t1' });
    expect(b[1]!.kind === 'tools' && b[1]!.tools.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('showsProgress', () => {
  it('is true for a streaming assistant or a running tool', () => {
    expect(showsProgress([assistant('a', true)])).toBe(true);
    expect(showsProgress([tool('t', 'running')])).toBe(true);
  });
  it('is false when idle, empty, or the last item is finished', () => {
    expect(showsProgress([])).toBe(false);
    expect(showsProgress([assistant('a', false)])).toBe(false);
    expect(showsProgress([user('u')])).toBe(false);
  });
});
