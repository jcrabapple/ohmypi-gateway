import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../lib/api/endpoints';
import type { SearchResponse } from '../../lib/api/types';
import SearchView from '../SearchView.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

afterEach(cleanup);

function resp(over: Partial<SearchResponse> = {}): SearchResponse {
  return {
    total: 2,
    indexed: { files: 2, messages: 9 },
    results: [
      {
        path: '/s/a.jsonl', line: 3, role: 'user', ts: '2026-10-01T10:00:00Z',
        snippet: 'fix the <mark>solver</mark> loop', sessionId: 'sid-1', cwd: '/w/proj',
        title: 'solver session', gwId: 'gwlive',
      },
      {
        path: '/s/a.jsonl', line: 4, role: 'assistant', ts: '2026-10-01T10:01:00Z',
        snippet: 'the <mark>solver</mark> is fixed & done <script>x</script>',
        sessionId: 'sid-1', cwd: '/w/proj', title: 'solver session', gwId: null,
      },
    ],
    ...over,
  };
}

function type(target: ParentNode, text: string): void {
  const box = target.querySelector('input[type="search"]') as HTMLInputElement;
  box.value = text;
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function flushDebounce(): Promise<void> {
  await new Promise((r) => setTimeout(r, 350));
  await settle();
}

describe('SearchView', () => {
  it('searches debounced, groups by session, escapes snippet text, keeps marks', async () => {
    const spy = vi.spyOn(endpoints.host, 'search').mockResolvedValue(resp());
    const { target } = render(SearchView, {});
    type(target, 'solver');
    await flushDebounce();

    expect(spy).toHaveBeenCalledWith('solver', expect.objectContaining({ role: null }));
    expect(target.querySelectorAll('.snippet mark').length).toBeGreaterThanOrEqual(2);
    // the injected <script> arrives as TEXT, never as markup
    expect(target.querySelector('.hit .snippet script')).toBeNull();
    expect(target.textContent).toContain('<script>x</script>');
    // grouped: one session header, two hits, live badge from the annotated gwId
    expect(target.querySelectorAll('.head')).toHaveLength(1);
    expect(target.querySelectorAll('.hit')).toHaveLength(2);
    expect(target.querySelector('.live')).toBeTruthy();
  });

  it('role filter triggers a new search with the role', async () => {
    const spy = vi.spyOn(endpoints.host, 'search').mockResolvedValue(resp());
    const { target } = render(SearchView, {});
    type(target, 'solver');
    await flushDebounce();

    const you = buttonNamed(target, 'You');
    expect(you).toBeTruthy();
    you!.click();
    await flushDebounce();
    expect(spy).toHaveBeenLastCalledWith('solver', expect.objectContaining({ role: 'user' }));
  });

  it('shows the empty-query hint and stops searching when the query empties', async () => {
    const spy = vi.spyOn(endpoints.host, 'search').mockResolvedValue(resp());
    const { target } = render(SearchView, {});
    type(target, 'solver');
    await flushDebounce();
    expect(target.querySelectorAll('.hit')).toHaveLength(2);

    type(target, '');
    await settle();
    expect(target.querySelectorAll('.hit')).toHaveLength(0);
    expect(target.textContent).toContain('Type to search');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
