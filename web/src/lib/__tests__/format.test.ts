import { describe, expect, it } from 'vitest';
import { basename, contextLevel, money, savedFolderLabel, uniqueCwds } from '../format';

describe('contextLevel', () => {
  it('is ok below 70, warn from 70, err from 85', () => {
    expect(contextLevel(0)).toBe('ok');
    expect(contextLevel(69.9)).toBe('ok');
    expect(contextLevel(70)).toBe('warn');
    expect(contextLevel(84.9)).toBe('warn');
    expect(contextLevel(85)).toBe('err');
    expect(contextLevel(100)).toBe('err');
  });
  it('treats unknown as ok', () => {
    expect(contextLevel(null)).toBe('ok');
    expect(contextLevel(undefined)).toBe('ok');
    expect(contextLevel(Number.NaN)).toBe('ok');
  });
});

describe('format helpers', () => {
  it('basename handles trailing slashes and empties', () => {
    expect(basename('/a/b/proj/')).toBe('proj');
    expect(basename('')).toBe('');
    expect(basename(null)).toBe('');
  });
  it('money shows small amounts with precision', () => {
    expect(money(0.0123)).toMatch(/^\$0\.01/);
    expect(money(12.5)).toBe('$12.50');
  });
  it('savedFolderLabel prefers a live cwd that mangles to the same folder', () => {
    expect(savedFolderLabel({ cwdFolder: '-work-app' }, ['/home/me/work/app'])).toBe('app');
    expect(savedFolderLabel({ cwdFolder: '-work-app' }, [])).toBe('work-app');
  });
  it('uniqueCwds keeps first-seen order', () => {
    expect(uniqueCwds([{ cwd: '/a' }, { cwd: '/b' }, { cwd: '/a' }])).toEqual(['/a', '/b']);
  });
});
