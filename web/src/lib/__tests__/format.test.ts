import { describe, expect, it } from 'vitest';
import { basename, contextLevel, money, savedFolderLabel, savedTitle, sessionTitle, splitInlineCode, uniqueCwds, uptime } from '../format';

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
  it('savedFolderLabel uses the recorded cwd when there is one', () => {
    expect(savedFolderLabel({ cwdFolder: '-var-home-me-work-app', cwd: '/var/home/me/work/app' }, [])).toBe('app');
    expect(savedFolderLabel({ cwdFolder: '-work-app', cwd: null }, [])).toBe('work-app');
    expect(savedTitle({ title: '', cwdFolder: '-x', cwd: '/a/b' }, [])).toBe('b');
  });
  it('uniqueCwds keeps first-seen order', () => {
    expect(uniqueCwds([{ cwd: '/a' }, { cwd: '/b' }, { cwd: '/a' }])).toEqual(['/a', '/b']);
  });
});

describe('sessionTitle', () => {
  const info = { ompSessionName: null, ompSessionFile: '/s/a.jsonl', cwd: '/work/proj' };
  const saved = [{ file: '/s/a.jsonl', title: ' Fix the login bug ' }, { file: '/s/b.jsonl', title: 'Other' }];

  it('prefers the session name', () => {
    expect(sessionTitle({ ...info, ompSessionName: ' Named ' }, saved)).toBe('Named');
  });

  it('falls back to the first prompt of the same transcript file', () => {
    expect(sessionTitle(info, saved)).toBe('Fix the login bug');
  });

  it('falls back to the folder, then to a generic label', () => {
    expect(sessionTitle(info, [])).toBe('proj');
    expect(sessionTitle({ ...info, ompSessionFile: null }, saved)).toBe('proj');
    expect(sessionTitle({ ...info, cwd: '' }, [])).toBe('Session');
  });
});

describe('uptime', () => {
  it('reads as the two largest units', () => {
    expect(uptime(5)).toBe('5s');
    expect(uptime(12 * 60)).toBe('12m');
    expect(uptime(3 * 3600 + 5 * 60)).toBe('3h 5m');
    expect(uptime(2 * 86400 + 4 * 3600)).toBe('2d 4h');
  });
});

describe('splitInlineCode', () => {
  it('splits paired backticks into code parts', () => {
    expect(splitInlineCode('Run `ls gateway` with bash')).toEqual([
      { text: 'Run ', code: false },
      { text: 'ls gateway', code: true },
      { text: ' with bash', code: false },
    ]);
  });
  it('handles several spans and edges', () => {
    expect(splitInlineCode('`a` and `b`')).toEqual([
      { text: 'a', code: true },
      { text: ' and ', code: false },
      { text: 'b', code: true },
    ]);
  });
  it('leaves an unpaired or empty backtick alone', () => {
    expect(splitInlineCode('cut `off here')).toEqual([{ text: 'cut `off here', code: false }]);
    expect(splitInlineCode('a `` b')).toEqual([{ text: 'a `` b', code: false }]);
    expect(splitInlineCode('')).toEqual([]);
  });
});
