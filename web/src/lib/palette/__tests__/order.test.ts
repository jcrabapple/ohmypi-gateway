import { describe, expect, it } from 'vitest';
import { session } from './factories';
import { adjacentId, nextAttentionId, railOrder } from '../order';

const need = { pendingUi: [{ id: 'u', method: 'confirm' as const }] };

describe('railOrder', () => {
  it('lists needs-you, then running, then idle', () => {
    const a = session('a');
    const b = session('b');
    const c = session('c');
    expect(railOrder({ needsYou: [c], running: [b], review: [], idle: [a] }).map((s) => s.gwId)).toEqual(['c', 'b', 'a']);
  });
});

describe('nextAttentionId', () => {
  const order = [session('a', need), session('b'), session('c', need), session('d')];

  it('finds the next waiting session after the current one and wraps', () => {
    expect(nextAttentionId(order, 'a')).toBe('c');
    expect(nextAttentionId(order, 'c')).toBe('a');
  });

  it('starts at the first waiting session from a non-waiting or missing one', () => {
    expect(nextAttentionId(order, 'b')).toBe('c');
    expect(nextAttentionId(order, null)).toBe('a');
    expect(nextAttentionId(order, 'gone')).toBe('a');
  });

  it('is null when nothing waits', () => {
    expect(nextAttentionId([session('x')], 'x')).toBeNull();
    expect(nextAttentionId([], null)).toBeNull();
  });

  it('returns the only waiting session even if it is current', () => {
    expect(nextAttentionId([session('a', need), session('b')], 'a')).toBe('a');
  });
});

describe('adjacentId', () => {
  const order = [session('a'), session('b'), session('c')];

  it('moves down and up with wrapping', () => {
    expect(adjacentId(order, 'a', 1)).toBe('b');
    expect(adjacentId(order, 'c', 1)).toBe('a');
    expect(adjacentId(order, 'a', -1)).toBe('c');
  });

  it('picks the first going down and the last going up when none is open', () => {
    expect(adjacentId(order, null, 1)).toBe('a');
    expect(adjacentId(order, null, -1)).toBe('c');
  });

  it('is null for an empty list', () => {
    expect(adjacentId([], null, 1)).toBeNull();
  });
});
