import { describe, expect, it } from 'vitest';
import { pageTitle, searchSettings, SETTINGS_ENTRIES, SETTINGS_PAGES } from '../settings-index';

describe('settings index', () => {
  it('has seven pages and every entry points at a real page', () => {
    expect(SETTINGS_PAGES.map((p) => p.id)).toEqual(['appearance', 'agent', 'models', 'skills', 'usage', 'connection', 'shortcuts']);
    for (const e of SETTINGS_ENTRIES) expect(SETTINGS_PAGES.some((p) => p.id === e.page), e.id).toBe(true);
    expect(new Set(SETTINGS_ENTRIES.map((e) => e.id)).size).toBe(SETTINGS_ENTRIES.length);
  });

  it('every page has at least one entry, so search can land on it', () => {
    for (const p of SETTINGS_PAGES) expect(SETTINGS_ENTRIES.some((e) => e.page === p.id), p.id).toBe(true);
  });

  it('pageTitle reads the title', () => {
    expect(pageTitle('agent')).toBe('Agent config');
  });
});

describe('searchSettings', () => {
  const first = (q: string) => searchSettings(q)[0]?.entry.id;

  it('finds a setting by its label', () => {
    expect(first('density')).toBe('density');
    expect(first('transcript width')).toBe('width');
  });

  it('finds by keyword and reports the page to jump to', () => {
    const hit = searchSettings('yaml')[0]!;
    expect(hit.entry.id).toBe('config');
    expect(hit.page.id).toBe('agent');
  });

  it('finds sign out via logout', () => {
    expect(first('logout')).toBe('sign-out');
  });

  it('matches a page name', () => {
    expect(searchSettings('shortcuts').some((h) => h.page.id === 'shortcuts')).toBe(true);
  });

  it('ranks a label match above a keyword match', () => {
    const ids = searchSettings('font').map((h) => h.entry.id);
    expect(ids[0]).toBe('prose');
  });

  it('returns nothing for an empty or unmatched query', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
    expect(searchSettings('zzzzqq')).toEqual([]);
  });
});
