<script lang="ts">
  // Gateway-wide transcript search: type, get hits grouped by session, jump in.
  import { host } from '../lib/api/endpoints';
  import type { SearchHit } from '../lib/api/types';
  import { active, nav, sessionsStore } from '../lib/state';
  import { Spinner, Icon } from '../lib/ui';

  type Role = 'user' | 'assistant' | null;

  let q = $state('');
  let role: Role = $state(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let hits = $state<SearchHit[] | null>(null);
  let total = $state(0);
  let indexed = $state<{ files: number; messages: number } | null>(null);
  let lastQuery = $state('');

  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const query = q.trim();
    if (!query) {
      if (ctrl) ctrl.abort();
      hits = null;
      total = 0;
      error = null;
      loading = false;
      return;
    }
    if (query === lastQuery && hits !== null) return;
    loading = true;
    error = null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(query), 250);
    return () => {
      if (timer) clearTimeout(timer);
    };
  });

  async function run(query: string): Promise<void> {
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    try {
      const out = await host.search(query, { role, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      hits = out.results;
      total = out.total;
      indexed = out.indexed;
      lastQuery = query;
      error = null;
    } catch (e) {
      if (!ctrl.signal.aborted) error = e instanceof Error ? e.message : 'Search failed';
    } finally {
      if (!ctrl.signal.aborted) loading = false;
    }
  }

  function setRole(next: Role): void {
    if (role === next) return;
    role = next;
    lastQuery = ''; // force a re-run with the new filter
  }

  /** Live sessions open directly; saved ones resume from their file. */
  function openHit(hit: SearchHit): void {
    if (hit.gwId) nav.open(hit.gwId);
    else void nav.resume({ file: hit.path, running: false });
  }

  function label(hit: SearchHit): string {
    return hit.title || hit.cwd?.split('/').filter(Boolean).pop() || hit.sessionId || hit.path;
  }

  function when(hit: SearchHit): string {
    const t = Date.parse(hit.ts);
    return Number.isNaN(t) ? '' : new Date(t).toLocaleString();
  }

  /** Snippet arrives with <mark> tags from the gateway: escape the text,
      then turn the markers back into real highlight elements. */
  function snippetHtml(snippet: string): string {
    const escaped = snippet
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('&lt;mark&gt;', '<mark>').replaceAll('&lt;/mark&gt;', '</mark>');
    return escaped;
  }

  const groups = $derived.by(() => {
    if (!hits) return [];
    const byPath = new Map<string, SearchHit[]>();
    for (const hit of hits) {
      const list = byPath.get(hit.path) ?? [];
      list.push(hit);
      byPath.set(hit.path, list);
    }
    return [...byPath.entries()].map(([path, list]) => ({ path, list }));
  });

  const isLive = (hit: SearchHit): boolean =>
    !!hit.gwId || sessionsStore.live.some((s) => s.ompSessionFile === hit.path && !s.exited);
</script>

<div class="search">
  <header>
    <h2>Search transcripts</h2>
    <p class="sub">
      Full text across {indexed ? `${indexed.messages} messages in ${indexed.files} saved sessions` : 'saved sessions'}.
      Matches are ranked; thinking and tool output are not searched.
    </p>
  </header>

  <div class="bar">
    <input
      type="search"
      placeholder="Search all sessions…"
      aria-label="Search transcripts"
      bind:value={q}
    />
    <div class="roles" role="radiogroup" aria-label="Filter by role">
      <button type="button" class:on={role === null} onclick={() => setRole(null)}>All</button>
      <button type="button" class:on={role === 'user'} onclick={() => setRole('user')}>You</button>
      <button type="button" class:on={role === 'assistant'} onclick={() => setRole('assistant')}>omp</button>
    </div>
  </div>

  {#if error}
    <p class="state error" role="alert">{error}</p>
  {:else if !q.trim()}
    <p class="state">Type to search. Quote nothing; every word is a prefix match.</p>
  {:else if loading && hits === null}
    <div class="state"><Spinner size={18} label="Searching" /></div>
  {:else if hits !== null && hits.length === 0}
    <p class="state">No matches for “{lastQuery}”.</p>
  {:else if hits !== null}
    {#if total > hits.length}
      <p class="state">Top {hits.length} of {total} matches.</p>
    {/if}
    {#each groups as group (group.path)}
      <section class="session" aria-label={label(group.list[0])}>
        <button
          type="button"
          class="head"
          onclick={() => openHit(group.list[0])}
          title={isLive(group.list[0]) ? 'Open this live session' : 'Resume this session'}
        >
          <span class="name">{label(group.list[0])}</span>
          {#if isLive(group.list[0])}<span class="live">live</span>{/if}
          <span class="meta">{group.list[0].cwd}</span>
          <Icon name="chevron-right" size={14} />
        </button>
        {#each group.list as hit (hit.path + ':' + hit.line)}
          <button type="button" class="hit" onclick={() => openHit(hit)}>
            <span class="chip" data-role={hit.role}>{hit.role === 'user' ? 'you' : 'omp'}</span>
            <span class="snippet">{@html snippetHtml(hit.snippet)}</span>
            <span class="when">{when(hit)}</span>
          </button>
        {/each}
      </section>
    {/each}
  {/if}
</div>

<style>
  .search {
    max-width: var(--w-wide, 60rem);
    margin: 0 auto;
    padding: var(--s-5);
    display: grid;
    gap: var(--s-4);
    align-content: start;
    height: 100%;
    overflow-y: auto;
  }
  header h2 {
    font-size: var(--fs-lg);
    font-weight: 600;
  }
  .sub {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    margin-top: 2px;
  }
  .bar {
    display: flex;
    gap: var(--s-2);
    align-items: center;
  }
  input[type='search'] {
    flex: 1;
    min-width: 0;
  }
  .roles {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-md);
    background: var(--inset);
    box-shadow: var(--ring);
    flex: none;
  }
  .roles button {
    padding: 0 var(--s-3);
    min-height: 28px;
    border-radius: calc(var(--r-md) - 2px);
    color: var(--ink-2);
    font-weight: 500;
  }
  .roles button.on {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .state {
    color: var(--ink-3);
  }
  .state.error {
    color: var(--ansi-1, #f87171);
  }
  .session {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: 100%;
    padding: var(--s-2) var(--s-3);
    background: var(--inset);
    text-align: left;
  }
  .head:hover {
    background: var(--hover);
  }
  .head .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .head .live {
    flex: none;
    font-size: var(--fs-xs);
    padding: 1px var(--s-2);
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .head .meta {
    color: var(--ink-3);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .head :global(svg) {
    flex: none;
    color: var(--ink-3);
  }
  .hit {
    display: flex;
    align-items: baseline;
    gap: var(--s-3);
    width: 100%;
    padding: var(--s-2) var(--s-3);
    border-top: 1px solid var(--line);
    text-align: left;
  }
  .hit:hover {
    background: var(--hover);
  }
  .chip {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--ink-3);
    width: 3.5em;
  }
  .chip[data-role='user'] {
    color: var(--accent);
  }
  .snippet {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .snippet :global(mark) {
    background: var(--accent-soft);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
  .when {
    margin-left: auto;
    flex: none;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  @media (max-width: 640px) {
    .when {
      display: none;
    }
  }
</style>
