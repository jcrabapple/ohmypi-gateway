import { describe, expect, it } from 'vitest';
import { extLang, extractFiles, parseOmpDiff, rowMarks } from '../diff2';

describe('parseOmpDiff', () => {
  it('parses the verified probe diff into one hunk with typed rows', () => {
    const p = parseOmpDiff(' 1|alpha\n-2|beta\n+2|delta\n 3|gamma');
    expect(p.adds).toBe(1);
    expect(p.dels).toBe(1);
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]!.lines).toEqual([
      { t: 'ctx', o: 1, n: 1, text: 'alpha' },
      { t: 'del', o: 2, text: 'beta' },
      { t: 'add', n: 2, text: 'delta' },
      { t: 'ctx', o: 3, n: 3, text: 'gamma' },
    ]);
  });

  it('keeps pipes in the text', () => {
    const p = parseOmpDiff(' 1|a|b|c');
    expect(p.hunks[0]!.lines[0]).toEqual({ t: 'ctx', o: 1, n: 1, text: 'a|b|c' });
  });

  it('normalizes CRLF line endings', () => {
    const p = parseOmpDiff(' 1|alpha\r\n-2|beta\r\n+2|delta\r\n\r\n 3|gamma\r');
    expect(p.adds).toBe(1);
    expect(p.dels).toBe(1);
    expect(p.hunks).toHaveLength(2);
    expect(p.hunks[0]!.lines[0]).toEqual({ t: 'ctx', o: 1, n: 1, text: 'alpha' });
    expect(p.hunks[1]!.lines[0]!.text).toBe('gamma');
  });

  it('tracks the new line number on context rows across inserts and deletes', () => {
    const inserted = parseOmpDiff(' 1|a\n+2|ins\n 2|b');
    expect(inserted.hunks[0]!.lines[2]).toEqual({ t: 'ctx', o: 2, n: 3, text: 'b' });
    const deleted = parseOmpDiff('-1|x\n 2|after');
    expect(deleted.hunks[0]!.lines[1]).toEqual({ t: 'ctx', o: 2, n: 1, text: 'after' });
  });

  it('treats unrecognized lines as gap notes', () => {
    const p = parseOmpDiff(' 1|ok\nnot a diff line\njunk2|y');
    expect(p.hunks[0]!.lines.map((l) => [l.t, l.text])).toEqual([
      ['ctx', 'ok'],
      ['gap', 'not a diff line'],
      ['gap', 'junk2|y'],
    ]);
    expect(p.adds).toBe(0);
    expect(p.dels).toBe(0);
  });

  it('parses multi-digit line numbers', () => {
    const p = parseOmpDiff(' 12|x\n+345|y');
    expect(p.hunks[0]!.lines).toEqual([
      { t: 'ctx', o: 12, n: 12, text: 'x' },
      { t: 'add', n: 345, text: 'y' },
    ]);
  });

  it('splits hunks on blank lines', () => {
    const p = parseOmpDiff(' 1|a\n-2|b\n\n 5|c\n+6|d');
    expect(p.hunks).toHaveLength(2);
    expect(p.hunks[0]!.lines.map((l) => l.t)).toEqual(['ctx', 'del']);
    expect(p.hunks[1]!.lines.map((l) => l.t)).toEqual(['ctx', 'add']);
    expect(p.adds).toBe(1);
    expect(p.dels).toBe(1);
  });

  it('turns ... lines into gap notes', () => {
    const p = parseOmpDiff(' 1|a\n... skipped 12 unchanged lines\n 14|b');
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]!.lines[1]).toEqual({ t: 'gap', text: 'skipped 12 unchanged lines' });
  });

  it('survives an empty diff', () => {
    expect(parseOmpDiff('')).toEqual({ hunks: [], adds: 0, dels: 0 });
  });
});

describe('extractFiles', () => {
  it('reads a single-file edit result', () => {
    const files = extractFiles('edit', { path: 'a.py' }, {
      diff: ' 1|alpha\n-2|beta\n+2|delta\n 3|gamma',
      firstChangedLine: 2,
      op: 'update',
      path: 'a.py',
      oldText: 'beta',
      newText: 'delta',
    });
    expect(files).toEqual([
      { path: 'a.py', op: 'update', diff: ' 1|alpha\n-2|beta\n+2|delta\n 3|gamma', adds: 1, dels: 1, created: false },
    ]);
  });

  it('reads per-file results and filters virtual URIs', () => {
    const files = extractFiles('edit', undefined, {
      perFileResults: [
        { path: 'src/one.ts', op: 'update', diff: ' 1|a\n-2|b\n+2|c' },
        { path: 'xd://memory/foo', op: 'update', diff: '+1|nope' },
        { path: 'https://example.com/x', op: 'create', diff: '+1|nope' },
        { path: 'src/two.ts', op: 'create', diff: '+1|hello\n+2|world' },
      ],
    });
    expect(files.map((f) => f.path)).toEqual(['src/one.ts', 'src/two.ts']);
    expect(files[1]).toMatchObject({ op: 'create', adds: 2, dels: 0, created: true });
    expect(files[0]).toMatchObject({ op: 'update', adds: 1, dels: 1, created: false });
  });

  it('detects created files from all-additions starting at line 1', () => {
    const files = extractFiles('edit', undefined, { diff: '+1|new\n+2|file', op: 'update', path: 'n.md' });
    expect(files[0]!.created).toBe(true);
    const edited = extractFiles('edit', undefined, { diff: ' 1|old\n+2|new', op: 'update', path: 'n.md' });
    expect(edited[0]!.created).toBe(false);
  });

  it('synthesizes an all-additions diff for a write with no result diff', () => {
    const files = extractFiles('write', { path: 'notes.md', content: 'hello\nworld' }, {
      resolvedPath: '/work/notes.md',
    });
    expect(files).toEqual([
      { path: '/work/notes.md', op: 'write', diff: '+1|hello\n+2|world', adds: 2, dels: 0, created: true },
    ]);
  });

  it('caps the synthesized write diff at 60 KB', () => {
    const line = 'x'.repeat(99) + '\n';
    const files = extractFiles('write', { path: 'big.txt', content: line.repeat(1000) }, {});
    const f = files[0]!;
    expect(f.diff.length).toBeLessThanOrEqual(60 * 1024 + 200);
    expect(f.adds).toBeLessThan(1000);
    expect(f.diff).toContain('truncated');
  });

  it('caps a single line longer than 60 KB to no rows plus the note', () => {
    const files = extractFiles('write', { path: 'huge.txt', content: 'y'.repeat(100_000) }, {});
    expect(files[0]!.adds).toBe(0);
    expect(files[0]!.diff).toMatch(/^\.\.\. truncated/);
  });

  it('strips carriage returns from written content', () => {
    const files = extractFiles('write', { path: 'w.md', content: 'a\r\nb\r\n' }, {});
    expect(files[0]!.diff).toBe('+1|a\n+2|b');
    expect(files[0]!.adds).toBe(2);
  });

  it('replaces duplicate per-file paths, keeping the last diff', () => {
    const files = extractFiles('edit', undefined, {
      perFileResults: [
        { path: 'a.ts', op: 'update', diff: '+1|one' },
        { path: 'a.ts', op: 'update', diff: ' 1|ctx\n+2|two' },
        { path: 'b.ts', op: 'update', diff: '+1|bee' },
      ],
    });
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(files[0]!.diff).toBe(' 1|ctx\n+2|two');
    expect(files[0]!.created).toBe(false);
  });

  it('does not flag a prepended insert on an existing file as created', () => {
    const files = extractFiles('edit', undefined, {
      diff: ' 1|head\n+1|inserted\n 2|tail',
      op: 'update',
      path: 'n.md',
    });
    expect(files[0]!.created).toBe(false);
    expect(files[0]!.adds).toBe(1);
    expect(files[0]!.dels).toBe(0);
  });

  it('prefers a real result diff over synthesis', () => {
    const files = extractFiles('write', { path: 'a.md', content: 'draft' }, {
      resolvedPath: '/a.md',
      diff: ' 1|old\n-2|gone\n+2|new',
      op: 'update',
      path: '/a.md',
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.adds).toBe(1);
    expect(files[0]!.dels).toBe(1);
    expect(files[0]!.created).toBe(false);
  });

  it('skips writes to virtual URIs and tools without diffs', () => {
    expect(extractFiles('write', { path: 'xd://scratch/x', content: 'hi' }, {})).toEqual([]);
    expect(extractFiles('bash', { command: 'ls' }, { wallTimeMs: 5 })).toEqual([]);
    expect(extractFiles('read', { path: 'a.md' }, { fileSize: 3 })).toEqual([]);
    expect(extractFiles('write', { path: 'a.md' }, { resolvedPath: '/a.md' })).toEqual([]);
  });
});

describe('rowMarks', () => {
  it('marks the changed word in paired del/add rows', () => {
    const p = parseOmpDiff(' 1|let rate = 1;\n-2|let rate = 2;\n+2|let ratio = 2;\n 3|done');
    const lines = p.hunks[0]!.lines;
    const marks = rowMarks(lines);
    // rows 1 and 2 are the del/add pair; "rate" vs "ratio" changed
    expect(marks.get(1)).toEqual({ start: 4, end: 8 });
    expect(marks.get(2)).toEqual({ start: 4, end: 9 });
    expect(marks.has(0)).toBe(false);
    expect(marks.has(3)).toBe(false);
  });

  it('does not pair rows across a context line', () => {
    const p = parseOmpDiff('-1|alpha one\n+1|alpha two\n 2|ctx\n-3|beta one\n+3|beta two');
    const lines = p.hunks[0]!.lines;
    const marks = rowMarks(lines);
    expect(marks.has(0)).toBe(true);
    expect(marks.has(3)).toBe(true);
  });

  it('gives no marks when a pair is fully rewritten', () => {
    const marks = rowMarks([
      { t: 'del', o: 1, text: 'completely different words here' },
      { t: 'add', n: 1, text: 'totally other stuff appears' },
    ]);
    expect(marks.size).toBe(0);
  });
});

describe('extLang', () => {
  it('maps file extensions to registered languages', () => {
    expect(extLang('src/lib/render/diff2.ts')).toBe('typescript');
    expect(extLang('main.py')).toBe('python');
    expect(extLang('/x/y/run.sh')).toBe('bash');
    expect(extLang('package.json')).toBe('json');
    expect(extLang('compose.yml')).toBe('yaml');
    expect(extLang('Dockerfile')).toBe('dockerfile');
    expect(extLang('styles.css')).toBe('css');
    expect(extLang('index.html')).toBe('xml');
    expect(extLang('notes.md')).toBe('markdown');
    expect(extLang('schema.sql')).toBe('sql');
  });

  it('returns null for unknown extensions and extensionless paths', () => {
    expect(extLang('x.weird')).toBeNull();
    expect(extLang('Makefile')).toBeNull();
    expect(extLang('')).toBeNull();
  });
});
