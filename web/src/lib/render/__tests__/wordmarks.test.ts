import { describe, expect, it } from 'vitest';
import { markHtml, wordMarks } from '../wordmarks';

describe('wordMarks', () => {
  it('returns null when nothing changed', () => {
    expect(wordMarks('same text', 'same text')).toBeNull();
  });

  it('returns null when more than ~70% of both strings changed', () => {
    expect(wordMarks('one totally different line', 'another quite altered row')).toBeNull();
    expect(wordMarks('', 'brand new')).toBeNull();
  });

  it('finds a changed word between a shared prefix and suffix', () => {
    const m = wordMarks('const x = 1;', 'const y = 1;');
    expect(m).toEqual([
      { start: 6, end: 7 },
      { start: 6, end: 7 },
    ]);
  });

  it('marks inside identifiers, not whole tokens', () => {
    const m = wordMarks('foo.bar = 1', 'foo.baz = 1');
    expect(m).toEqual([
      { start: 4, end: 7 },
      { start: 4, end: 7 },
    ]);
  });

  it('handles several changed words as one span', () => {
    const m = wordMarks('the quick brown fox', 'the slow brown fox');
    expect(m).toEqual([
      { start: 4, end: 9 },
      { start: 4, end: 8 },
    ]);
    expect('the quick brown fox'.slice(m![0].start, m![0].end)).toBe('quick');
    expect('the slow brown fox'.slice(m![1].start, m![1].end)).toBe('slow');
  });

  it('marks additions and deletions of words', () => {
    const added = wordMarks('keep this', 'keep this too');
    expect(added).not.toBeNull();
    expect('keep this too'.slice(added![1].start, added![1].end)).toBe(' too');
    const removed = wordMarks('keep this too', 'keep this');
    expect(removed).not.toBeNull();
  });
});

describe('markHtml', () => {
  it('wraps the marked range of plain escaped text', () => {
    expect(markHtml('alpha beta', 6, 10)).toBe('alpha <mark>beta</mark>');
  });

  it('splits inside highlight.js spans', () => {
    const html = '<span class="hljs-keyword">const</span> x = 1;';
    expect(markHtml(html, 6, 7)).toBe('<span class="hljs-keyword">const</span> <mark>x</mark> = 1;');
  });

  it('splits a mark instead of nesting it across a closing span', () => {
    const html = '<span class="hljs-keyword">const</span> x';
    expect(markHtml(html, 0, 7)).toBe(
      '<span class="hljs-keyword"><mark>const</mark></span><mark> x</mark>',
    );
  });

  it('never opens a mark that would be empty around a tag', () => {
    const html = '<span class="hljs-keyword">const</span> x';
    // range covers only ' x' after the span: one clean mark
    expect(markHtml(html, 5, 7)).toBe('<span class="hljs-keyword">const</span><mark> x</mark>');
  });

  it('counts long named entities as one character', () => {
    const html = 'x&DoubleLongLeftRightArrow;y';
    expect(markHtml(html, 1, 2)).toBe('x<mark>&DoubleLongLeftRightArrow;</mark>y');
  });

  it('counts entities as one character', () => {
    expect(markHtml('a &amp; b', 2, 3)).toBe('a <mark>&amp;</mark> b');
  });

  it('keeps the html untouched for empty or out-of-range marks', () => {
    expect(markHtml('abc', 2, 2)).toBe('abc');
    expect(markHtml('abc', 9, 12)).toBe('abc');
  });
});
