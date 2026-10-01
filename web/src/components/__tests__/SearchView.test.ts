import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../lib/api/endpoints';
import type { SearchResponse } from '../../lib/api/types';
import SearchView from '../SearchView.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

afterEach(cleanup);

function resp(over: Partial<SearchResponse> = {}): SearchResponse {
  const MARK_OPEN = String.fromCodePoint(0xe000);
  const MARK_CLOSE = String.fromCodePoint(0xe001);
  return {
    total: 2,
    indexed: { files: 2, messages: 9 },
    results: [
      {
        path: '/s/a.jsonl', line: 3, role: 'user', ts: '2026-10-01T10:00:00Z',
        snippet: `fix the ${MARK_OPEN}solver${MARK_CLOSE} loop`, sessionId: 'sid-1', cwd: '/w/proj',
        title: 'solver session', gwId: 'gwlive',
      },
      {
        path: '/s/a.jsonl', line: 4, role: 'assistant', ts: '2026-10-01T10:01:00Z',
        snippet: `the ${MARK_OPEN}solver${MARK_CLOSE} is fixed & done <script>x</script> and lone ${MARK_CLOSE} stray`,
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

  it('rapid typing supersedes in-flight requests without flashing errors', async () => {
    let release: ((v: SearchResponse) => void)[] = [];
    const spy = vi.spyOn(endpoints.host, 'search').mockImplementation((_q, opts) => new Promise<SearchResponse>((resolve, reject) => {
      release.push(resolve);
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const { target } = render(SearchView, {});
    type(target, 'sol');
    await flushDebounce();
    expect(spy).toHaveBeenCalledTimes(1);
    type(target, 'solve');
    await flushDebounce();
    expect(spy).toHaveBeenCalledTimes(2);
    // the first request resolves late: it must NOT clobber state or raise an error
    release[0]!(resp());
    await settle();
    expect(target.textContent).not.toContain('Search failed');
    // the second request finishes and wins
    release[1]!(resp({ total: 7 }));
    await flushDebounce();
    await settle();
    expect(target.textContent).toContain('Top 2 of 7 matches');
  });

  it('renders an error banner when the gateway fails', async () => {
    vi.spyOn(endpoints.host, 'search').mockRejectedValue(new Error('gateway exploded'));
    const { target } = render(SearchView, {});
    type(target, 'solver');
    await flushDebounce();
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('gateway exploded');
  });
});
