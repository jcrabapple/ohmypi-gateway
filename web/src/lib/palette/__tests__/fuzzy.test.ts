import { describe, expect, it } from 'vitest';
import { fuzzyScore, fuzzyScoreAll } from '../fuzzy';

describe('fuzzyScore', () => {
  it('ranks exact, prefix, word start, substring in that order', () => {
    const exact = fuzzyScore('theme', 'theme');
    const prefix = fuzzyScore('theme', 'themes and more');
    const word = fuzzyScore('theme', 'toggle theme');
    const inner = fuzzyScore('theme', 'xthemex');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(0);
  });

  it('needs every word to match', () => {
    expect(fuzzyScore('new sess', 'New session')).toBeGreaterThan(0);
    expect(fuzzyScore('new zebra', 'New session')).toBe(-1);
  });

  it('is case-insensitive and treats an empty query as a match', () => {
    expect(fuzzyScore('NEW', 'new session')).toBeGreaterThan(0);
    expect(fuzzyScore('  ', 'anything')).toBe(0);
  });

  it('allows a scattered match only for longer words', () => {
    expect(fuzzyScore('nsn', 'new session')).toBeGreaterThan(0);
    expect(fuzzyScore('ns', 'new session')).toBe(-1);
  });
});

describe('fuzzyScoreAll', () => {
  it('counts secondary text at half weight', () => {
    const primary = fuzzyScoreAll('compact', 'Compact context', ['summarize']);
    const secondary = fuzzyScoreAll('summarize', 'Compact context', ['summarize']);
    expect(secondary).toBeGreaterThan(0);
    expect(primary).toBeGreaterThan(secondary);
  });

  it('lets different words match different fields', () => {
    expect(fuzzyScoreAll('work status', 'Work', ['show status'])).toBeGreaterThan(0);
    expect(fuzzyScoreAll('work nothing', 'Work', ['show status'])).toBe(-1);
  });
});
