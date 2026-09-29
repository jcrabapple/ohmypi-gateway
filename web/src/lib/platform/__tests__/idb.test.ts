import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { cacheKey, idbDelete, idbDeletePrefix, idbGet, idbSet } from '../idb';

beforeEach(async () => {
  await idbDeletePrefix('');
});

describe('idb keyval', () => {
  it('round-trips structured values and returns undefined for a miss', async () => {
    expect(await idbGet('nope')).toBeUndefined();
    await idbSet('k', { a: [1, 2, { b: 'c' }] });
    expect(await idbGet('k')).toEqual({ a: [1, 2, { b: 'c' }] });
  });

  it('overwrites and deletes', async () => {
    await idbSet('k', 1);
    await idbSet('k', 2);
    expect(await idbGet('k')).toBe(2);
    await idbDelete('k');
    expect(await idbGet('k')).toBeUndefined();
  });

  it('deletes by prefix only', async () => {
    await idbSet('a:1', 1);
    await idbSet('a:2', 2);
    await idbSet('b:1', 3);
    await idbDeletePrefix('a:');
    expect(await idbGet('a:1')).toBeUndefined();
    expect(await idbGet('a:2')).toBeUndefined();
    expect(await idbGet('b:1')).toBe(3);
  });

  it('scopes keys to the origin', () => {
    expect(cacheKey('messages', 'g1')).toBe(`${location.origin}:messages:g1`);
  });
});
