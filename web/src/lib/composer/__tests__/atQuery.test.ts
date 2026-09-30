import { describe, expect, it } from 'vitest';
import type { FileIndexEntry } from '../../api/types';
import { atDirPrefix, extractAtQuery, insertMention, rankEntries } from '../atQuery';

function entry(path: string, isDir = false): FileIndexEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { name, path, isDir, size: isDir ? null : 1 };
}

describe('extractAtQuery', () => {
  it('triggers at line start, with an empty query', () => {
    expect(extractAtQuery('@')).toEqual({ start: 0, query: '', quoted: false });
  });

  it('triggers after whitespace and captures the trailing run', () => {
    expect(extractAtQuery('see @src/ma')).toEqual({ start: 4, query: 'src/ma', quoted: false });
    expect(extractAtQuery('see @a@b')).toEqual({ start: 4, query: 'a@b', quoted: false });
  });

  it('treats a line break as a trigger position', () => {
    expect(extractAtQuery('one\ntwo\n@')).toEqual({ start: 8, query: '', quoted: false });
  });

  it('never fires mid-word or mid-email', () => {
    expect(extractAtQuery('mail bob@example.com')).toBeNull();
    expect(extractAtQuery('we@are@one')).toBeNull();
    expect(extractAtQuery('x@"a')).toBeNull();
    expect(extractAtQuery('plain text')).toBeNull();
    expect(extractAtQuery('')).toBeNull();
  });

  it('ignores a trigger that already ended before the caret', () => {
    expect(extractAtQuery('see @src done')).toBeNull();
  });

  it('opens the quoted form and allows spaces until the closing quote', () => {
    expect(extractAtQuery('look @"my fol')).toEqual({ start: 5, query: 'my fol', quoted: true });
    expect(extractAtQuery('@"')).toEqual({ start: 0, query: '', quoted: true });
  });

  it('closes the quoted form at the closing quote', () => {
    expect(extractAtQuery('look @"my fol"')).toBeNull();
    expect(extractAtQuery('@"old" then @ne')).toEqual({ start: 12, query: 'ne', quoted: false });
  });

  it('a quoted query never spans newlines (ported from Omai K3)', () => {
    // An unclosed @" with a later line of text must not become a query that
    // swallows the rest of the message.
    expect(extractAtQuery('@"notes\nsecond line')).toBeNull();
  });

  it('after a newline the plain token rule applies (ported from Omai K3)', () => {
    expect(extractAtQuery('@"x\nlook @re')).toEqual({ start: 9, query: 're', quoted: false });
  });
});

describe('atDirPrefix', () => {
  it('splits the query into its directory part', () => {
    expect(atDirPrefix('src/ma')).toBe('src');
    expect(atDirPrefix('a/b/c')).toBe('a/b');
    expect(atDirPrefix('ma')).toBe('');
    expect(atDirPrefix('')).toBe('');
  });
});

describe('rankEntries', () => {
  const files = [
    entry('beta'),
    entry('src', true),
    entry('readme.md'),
    entry('x-re.txt'),
    entry('alpha.txt'),
    entry('abc', true),
  ];

  it('keeps every entry with dirs first, then shorter names, on an empty query', () => {
    const names = rankEntries(files, '').map((e) => e.path);
    expect(names).toEqual(['abc', 'src', 'beta', 'x-re.txt', 'alpha.txt', 'readme.md']);
  });

  it('puts exact prefixes first, then word-boundary substrings, then subsequences', () => {
    const names = rankEntries(files, 're').map((e) => e.path);
    expect(names).toEqual(['readme.md', 'x-re.txt']);
    const sub = rankEntries([entry('alpha.txt'), entry('nope.bin')], 'lt').map((e) => e.path);
    expect(sub).toEqual(['alpha.txt']);
  });

  it('is case-insensitive', () => {
    expect(rankEntries(files, 'RE').map((e) => e.path)).toEqual(['readme.md', 'x-re.txt']);
  });

  it('breaks tier ties dirs-first then by shorter path', () => {
    expect(rankEntries([entry('ab'), entry('abc', true), entry('abcd')], 'a').map((e) => e.path))
      .toEqual(['abc', 'ab', 'abcd']);
  });

  it('drops non-matches', () => {
    expect(rankEntries(files, 'zzz')).toEqual([]);
  });
});

describe('insertMention', () => {
  it('a quote on a LATER line is not used as the close (ported from Omai K1/K3)', () => {
    // Picking a file after an unclosed @" used to delete everything up to a
    // later quote in the message; the token now ends where typing stopped.
    const res = insertMention(
      'look @"src/com\nhe said "hi"',
      { start: 5, query: 'src/com', quoted: true },
      'src/composer',
    );
    expect(res.text).toBe('look @src/composer\nhe said "hi"');
    expect(res.caret).toBe('look @src/composer'.length);
  });


  it('replaces the @query token at end of text and adds no trailing space there', () => {
    const res = insertMention('look @s', { start: 5, query: 's', quoted: false }, 'src/main.py');
    expect(res).toEqual({ text: 'look @src/main.py', caret: 'look @src/main.py'.length });
  });

  it('replaces the whole token when the caret sits mid-word', () => {
    const res = insertMention('@src/main.ts', { start: 0, query: 'src/m', quoted: false }, 'src/main.py');
    expect(res).toEqual({ text: '@src/main.py', caret: '@src/main.py'.length });
  });

  it('keeps an existing separator after the token instead of double-spacing', () => {
    const res = insertMention('look @s and then', { start: 5, query: 's', quoted: false }, 'src');
    expect(res).toEqual({ text: 'look @src and then', caret: 'look @src'.length });
  });

  it('separates the token from text that follows a closed quoted token', () => {
    const res = insertMention('@"my no"x', { start: 0, query: 'my no', quoted: true }, 'my notes');
    expect(res).toEqual({ text: '@"my notes" x', caret: '@"my notes" '.length });
  });

  it('quotes paths that contain whitespace', () => {
    const res = insertMention('x @', { start: 2, query: '', quoted: false }, 'my notes/a b.md');
    expect(res.text).toBe('x @"my notes/a b.md"');
    expect(res.caret).toBe(res.text.length);
  });

  it('keeps whatever preceded the trigger', () => {
    const res = insertMention('a b @re', { start: 4, query: 're', quoted: false }, 'readme.md');
    expect(res.text.startsWith('a b @readme.md')).toBe(true);
  });
});
