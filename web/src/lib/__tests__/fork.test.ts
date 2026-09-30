import { describe, expect, it } from 'vitest';
import { entryForItem, forkable, prefixMissing, userTexts, userTextsBefore } from '../fork';
import type { Item, UserItem } from '../transcript/types';

function user(text: string, ts?: number, over: Partial<UserItem> = {}): UserItem {
  return { kind: 'user', id: `u:${text}`, text, images: 0, pending: false, timestamp: ts, ...over };
}

function assistant(text: string): Item {
  return { kind: 'assistant', id: `a:${text}`, text, streaming: false };
}

describe('forkable', () => {
  it('targets settled, echoed user messages only', () => {
    expect(forkable(user('hi', 5))).toBe(true);
    expect(forkable(user('hi', 5, { pending: true }))).toBe(false);
    expect(forkable(user('hi', 5, { failed: true }))).toBe(false);
    expect(forkable(user('   '))).toBe(false);
    expect(forkable(assistant('no'))).toBe(false);
  });
});

describe('userTextsBefore', () => {
  const items: Item[] = [
    user('first', 1),
    assistant('reply'),
    user('second', 2),
    assistant('reply2'),
    user('third', 3),
  ];

  it('collects settled user texts up to but excluding the branch point', () => {
    expect(userTextsBefore(items, items[4] as UserItem)).toEqual(['first', 'second']);
  });

  it('is empty when forking at the first message', () => {
    expect(userTextsBefore(items, items[0] as UserItem)).toEqual([]);
  });

  it('returns null when the branch point is not in the list', () => {
    expect(userTextsBefore(items, user('ghost', 999))).toBeNull();
  });
});

describe('entryForItem', () => {
  const entries = [
    { entryId: 'e1', role: 'user', timestamp: 1000 },
    { entryId: 'e2', role: 'assistant', timestamp: 1500 },
    { entryId: 'e3', role: 'user', timestamp: 2000 },
  ];

  it('matches on the message timestamp', () => {
    expect(entryForItem(user('x', 1000), entries)?.entryId).toBe('e1');
  });

  it('never matches a non-user entry', () => {
    expect(entryForItem(user('x', 1500), entries)).toBeNull();
  });

  it('misses when the live history diverged', () => {
    expect(entryForItem(user('x', 9999), entries)).toBeNull();
    expect(entryForItem(user('x'), entries)).toBeNull();
  });
});

describe('userTexts', () => {
  it('reads string and block content, skipping empty parts', () => {
    expect(userTexts([
      { role: 'user', content: 'plain' },
      { role: 'assistant', content: 'no' },
      { role: 'user', content: [{ type: 'text', text: ' from block ' }, { type: 'image' }] },
      { role: 'user', content: '   ' },
    ])).toEqual(['plain', 'from block']);
  });

  it('skips skill prompts, which the reducer renders as skill items', () => {
    expect(userTexts([
      { role: 'user', content: 'real question' },
      { role: 'user', customType: 'skill-prompt', content: '[IMPORTANT: User invoked the "humanizer" skill' },
      { role: 'custom', customType: 'skill-prompt', content: 'invoked the "humanizer" skill' },
    ])).toEqual(['real question']);
  });

  it('joins several text blocks of one message into one entry, like the reducer', () => {
    expect(userTexts([
      { role: 'user', content: [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two' }] },
    ])).toEqual(['one two']);
  });
});

describe('prefixMissing', () => {
  it('accepts the exact prefix and anything after it', () => {
    expect(prefixMissing(['a', 'b'], ['a', 'b'])).toBe(false);
    expect(prefixMissing(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
  });

  it('flags truncation and divergence', () => {
    expect(prefixMissing(['a', 'b'], ['a'])).toBe(true);
    expect(prefixMissing(['a', 'b'], ['a', 'x'])).toBe(true);
    expect(prefixMissing(['a'], [])).toBe(true);
  });
});
