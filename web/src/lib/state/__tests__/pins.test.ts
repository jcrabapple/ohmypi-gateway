import { beforeEach, describe, expect, it } from 'vitest';
import { storageKey } from '../../platform/storage';
import { PinStore, pins } from '../pins.svelte';

const PIN_KEY = storageKey('device', 'ompgw-pinned-sessions');

beforeEach(() => {
  localStorage.clear();
  pins.clear();
});

describe('PinStore', () => {
  it('pins, unpins, and persists transcript paths', () => {
    pins.toggle('/s/1.jsonl');
    expect(pins.isPinned('/s/1.jsonl')).toBe(true);
    expect(pins.protectedFromCleanup('/s/1.jsonl')).toBe(true);
    const stored = Object.keys(localStorage).length;
    expect(stored).toBeGreaterThan(0);

    pins.toggle('/s/1.jsonl');
    expect(pins.isPinned('/s/1.jsonl')).toBe(false);
  });

  it('isPinned is false for unknown paths', () => {
    expect(pins.isPinned('/s/nope.jsonl')).toBe(false);
    expect(pins.protectedFromCleanup('/s/nope.jsonl')).toBe(false);
  });

  it('a fresh store recovers from corrupt storage data', () => {
    localStorage.setItem(PIN_KEY, '{"invalid":"data"}');
    expect(new PinStore().files.size).toBe(0);

    localStorage.setItem(PIN_KEY, 'not-json');
    expect(new PinStore().files.size).toBe(0);
  });

  it('clear() empties the set and storage', () => {
    pins.toggle('/s/1.jsonl');
    pins.clear();
    expect(pins.files.size).toBe(0);
    expect(pins.isPinned('/s/1.jsonl')).toBe(false);
  });
});
