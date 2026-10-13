import { beforeEach, describe, expect, it } from 'vitest';
import { storageKey } from '../../platform/storage';
import { FolderFilter, folderCounts, folderFilter, folderKey } from '../folders.svelte';

const KEY = storageKey('device', 'ompgw-rail-hidden-folders');

beforeEach(() => {
  localStorage.clear();
  folderFilter.showAll();
});

describe('FolderFilter', () => {
  it('toggles, persists, and restores hidden folders', () => {
    folderFilter.toggle('/home/j');
    expect(folderFilter.isHidden('/home/j')).toBe(true);
    expect(new FolderFilter().isHidden('/home/j')).toBe(true);
    folderFilter.toggle('/home/j');
    expect(folderFilter.isHidden('/home/j')).toBe(false);
    expect(new FolderFilter().hidden.size).toBe(0);
  });

  it('showAll clears everything', () => {
    folderFilter.toggle('/a');
    folderFilter.toggle('/b');
    folderFilter.showAll();
    expect(folderFilter.hidden.size).toBe(0);
    expect(new FolderFilter().hidden.size).toBe(0);
  });

  it('recovers from corrupt storage', () => {
    localStorage.setItem(KEY, '{"x":1}');
    expect(new FolderFilter().hidden.size).toBe(0);
    localStorage.setItem(KEY, 'not-json');
    expect(new FolderFilter().hidden.size).toBe(0);
    localStorage.setItem(KEY, JSON.stringify(['/ok', 3, '', null]));
    expect([...new FolderFilter().hidden]).toEqual(['/ok']);
  });
});

describe('folderCounts / folderKey', () => {
  it('keys on cwd, falls back to cwdFolder, sorts busiest first then by name', () => {
    expect(folderKey({ cwd: '/w/p', cwdFolder: '-w-p' })).toBe('/w/p');
    expect(folderKey({ cwd: null, cwdFolder: '--tmp--' })).toBe('--tmp--');
    const counts = folderCounts([
      { cwd: '/b', cwdFolder: '-b' },
      { cwd: '/a', cwdFolder: '-a' },
      { cwd: '/c', cwdFolder: '-c' },
      { cwd: '/c', cwdFolder: '-c' },
      { cwd: null, cwdFolder: '--tmp--' },
    ]);
    expect(counts).toEqual([
      { key: '/c', count: 2 },
      { key: '--tmp--', count: 1 },
      { key: '/a', count: 1 },
      { key: '/b', count: 1 },
    ]);
  });
});
