<script lang="ts">
  // The assistant's knowledge store: search the note graph, read a note with its
  // tags and both edge directions, write or correct one, archive it. The fuzzy
  // episodic layer below is read-only on purpose (mnemopi owns its embeddings).
  import { onMount } from 'svelte';
  import { memory } from '../../lib/api/endpoints';
  import type { EpisodicRow, MemoryNote, MemoryNoteRef } from '../../lib/api/types';
  import { Loader } from '../../lib/state/loader.svelte';
  import { ApiError } from '../../lib/api/client';
  import { Icon, Spinner, confirm, toast } from '../../lib/ui';
  import LoadState from './LoadState.svelte';
  import Section from './Section.svelte';

  const stats = new Loader<Awaited<ReturnType<typeof memory.stats>>>();
  const loadStats = () => void stats.run(() => memory.stats());

  let query = $state('');
  let hits = $state<MemoryNoteRef[]>([]);
  let searching = $state(false);
  let searchError = $state<string | null>(null);

  let open = $state<MemoryNote | null>(null);
  let form = $state({ title: '', tags: '', links: '', body: '' });
  let creating = $state(false);
  let saving = $state(false);
  let noteLoading = $state(false);
  let saveNote = $state<string | null>(null);

  const episodic = new Loader<Awaited<ReturnType<typeof memory.recall>>>();
  let recallQ = $state('');
  const loadRecall = () => void episodic.run(() => memory.recall(recallQ, 25));

  let queryDebounce: ReturnType<typeof setTimeout> | undefined;
  let recallDebounce: ReturnType<typeof setTimeout> | undefined;
  // Typing faster than the index answers means responses can land out of order;
  // only the newest request may touch the list.
  let searchGen = 0;

  onMount(() => {
    loadStats();
    loadRecall();
    void runSearch('');
    return () => {
      clearTimeout(queryDebounce);
      clearTimeout(recallDebounce);
    };
  });

  async function runSearch(q: string) {
    const gen = ++searchGen;
    searching = true;
    searchError = null;
    try {
      const res = await memory.notes(q, 40);
      if (gen !== searchGen) return;
      hits = res.notes;
      if (res.error) searchError = res.error;
    } catch (e) {
      if (gen !== searchGen) return;
      searchError = e instanceof ApiError ? e.message : 'Search failed';
    } finally {
      if (gen === searchGen) searching = false;
    }
  }

  function onQuery() {
    clearTimeout(queryDebounce);
    queryDebounce = setTimeout(() => void runSearch(query.trim()), 220);
  }

  function fill(note: MemoryNote) {
    form = { title: note.title, tags: note.tags.join(', '), links: note.links.join(', '), body: note.body };
  }

  async function openNote(id: string) {
    if (id.includes(':')) return; // skill:/tag: rows are context, not notes
    noteLoading = true;
    saveNote = null;
    try {
      const note = await memory.note(id);
      open = note;
      creating = false;
      fill(note);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not open that note', { kind: 'error' });
    } finally {
      noteLoading = false;
    }
  }

  function startNew() {
    open = null;
    creating = true;
    saveNote = null;
    form = { title: '', tags: '', links: '', body: '' };
  }

  function closeEditor() {
    open = null;
    creating = false;
    saveNote = null;
  }

  const split = (v: string) =>
    v.split(',').map((s) => s.trim()).filter(Boolean);

  async function save() {
    if (!form.title.trim() || saving) return;
    saving = true;
    saveNote = null;
    try {
      const res = await memory.save({
        id: open?.id,
        title: form.title.trim(),
        tags: split(form.tags),
        links: split(form.links),
        body: form.body,
      });
      if (res.index.indexed) {
        saveNote = res.created ? 'Saved and indexed' : 'Updated and indexed';
      } else {
        saveNote = `Saved. Index not rebuilt: ${res.index.reason ?? 'unknown reason'}`;
      }
      if (res.note) {
        open = res.note;
        creating = false;
        fill(res.note);
      }
      loadStats();
      void runSearch(query.trim());
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save that note', { kind: 'error' });
    } finally {
      saving = false;
    }
  }

  async function archive() {
    if (!open) return;
    const ok = await confirm({
      title: 'Archive this note?',
      body: 'It moves to archive/ and drops to the archived tier. The markdown file is kept.',
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    try {
      await memory.archive(open.id);
      toast('Archived');
      closeEditor();
      loadStats();
      void runSearch(query.trim());
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not archive that note', { kind: 'error' });
    }
  }

  function onRecall() {
    clearTimeout(recallDebounce);
    recallDebounce = setTimeout(() => loadRecall(), 300);
  }

  const tierLabel = (t: string) => (t === 'hot' ? 'hot' : t === 'archived' ? 'archived' : 'warm');
</script>

<Section
  id="memory-search"
  title="Notes"
  hint="The memory graph on the gateway host. Notes are markdown files; this reads and writes them."
>
  {#if stats.data}
    <p class="counts" role="status">
      <span>{stats.data.counts.note} notes</span>
      <span>{stats.data.counts.skill} skills</span>
      <span>{stats.data.counts.tag} tags</span>
      <span>{stats.data.counts.edges} links</span>
    </p>
    {#if stats.data.hot.length}
      <ul class="hot">
        {#each stats.data.hot as h (h.id)}
          <li>
            <button type="button" class="chip" onclick={() => openNote(h.id)}>{h.title}</button>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <LoadState ready={stats.data !== null} error={stats.error} onretry={loadStats}>
      <span></span>
    </LoadState>
  {/if}

  <div class="find">
    <Icon name="search" size={16} />
    <input
      type="search"
      class="field"
      aria-label="Search notes"
      placeholder="Search notes"
      autocomplete="off"
      spellcheck="false"
      bind:value={query}
      oninput={onQuery}
    />
    {#if searching}<Spinner size={12} label="Searching" />{/if}
  </div>

  {#if searchError}
    <p class="warn" role="alert">{searchError}</p>
  {/if}

  {#if hits.length}
    <ul class="list">
      {#each hits as hit (hit.id)}
        <li>
          <button
            type="button"
            class="row"
            disabled={hit.kind !== 'note'}
            onclick={() => openNote(hit.id)}
          >
            <span class="top">
              <span class="name">{hit.title}</span>
              <span class="tier" class:hot={hit.tier === 'hot'}>{tierLabel(hit.tier)}</span>
            </span>
            {#if hit.snippet}<span class="snip">{hit.snippet}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else if !searching}
    <p class="empty">
      {query.trim() ? `No notes match "${query.trim()}"` : 'No notes yet.'}
    </p>
  {/if}
</Section>

<Section id="memory-new" title={creating ? 'New note' : 'Note'} hint="Title, tags and links, then the body. Saving rebuilds the index.">
  {#if !open && !creating}
    <button type="button" class="btn btn-sm" onclick={startNew}>
      <Icon name="plus" size={14} />
      New note
    </button>
  {:else if noteLoading}
    <p class="empty"><Spinner size={12} label="Opening" /> Opening</p>
  {:else}
    <form class="editor" onsubmit={(e) => { e.preventDefault(); void save(); }}>
      <label class="lab">
        <span>Title</span>
        <input class="field" bind:value={form.title} required maxlength={200} />
      </label>
      <label class="lab">
        <span>Tags</span>
        <input class="field" bind:value={form.tags} placeholder="comma, separated" />
      </label>
      <label class="lab">
        <span>Links</span>
        <input class="field" bind:value={form.links} placeholder="skill:name, note-id" />
      </label>
      <label class="lab">
        <span>Body</span>
        <textarea class="field area" rows="10" bind:value={form.body} spellcheck="false"></textarea>
      </label>
      <div class="actions">
        <button type="submit" class="btn btn-sm primary" disabled={saving || !form.title.trim()}>
          {#if saving}<Spinner size={12} label="Saving" />{:else}Save{/if}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" onclick={closeEditor}>Close</button>
        {#if open}
          <button type="button" class="btn btn-ghost btn-sm danger" onclick={archive}>Archive</button>
        {/if}
        {#if open}<span class="path mono">{open.id}</span>{/if}
      </div>
      {#if saveNote}<p class="ok" role="status">{saveNote}</p>{/if}
    </form>

    {#if open && (open.outgoing.length || open.incoming.length)}
      <div class="edges">
        {#if open.outgoing.length}
          <div>
            <h4>Links out</h4>
            <ul>
              {#each open.outgoing as e (e.id + e.kind)}
                <li><span class="mono ref">{e.id}</span> <span class="kind">{e.kind}</span></li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if open.incoming.length}
          <div>
            <h4>Backlinks</h4>
            <ul>
              {#each open.incoming as e (e.id + e.kind)}
                <li><span class="mono ref">{e.id}</span> <span class="kind">{e.kind}</span></li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</Section>

<Section
  id="memory-episodic"
  title="Episodic recall"
  hint="Read-only view of mnemopi working memory across project banks. Newest first; substring match, not semantic."
>
  <div class="find">
    <Icon name="search" size={16} />
    <input
      type="search"
      class="field"
      aria-label="Search episodic memory"
      placeholder="Search what sessions retained"
      autocomplete="off"
      bind:value={recallQ}
      oninput={onRecall}
    />
  </div>
  <LoadState ready={episodic.data !== null} error={episodic.error} onretry={loadRecall} rows={3}>
    {#if episodic.data}
      {#if episodic.data.rows.length}
        <ul class="list">
          {#each episodic.data.rows as row (row.bank + row.id)}
            <li class="ep">
              <span class="top">
                <span class="bank mono">{row.bank}</span>
                {#if row.timestamp}<span class="when">{row.timestamp.slice(0, 16).replace('T', ' ')}</span>{/if}
              </span>
              <pre class="content">{row.content}</pre>
            </li>
          {/each}
        </ul>
        <p class="empty">
          {episodic.data.rows.length} of {episodic.data.scanned} scanned across {episodic.data.banks}
          {episodic.data.banks === 1 ? 'bank' : 'banks'}
        </p>
      {:else}
        <p class="empty">Nothing retained matches that.</p>
      {/if}
    {/if}
  </LoadState>
</Section>

<style>
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .counts span:not(:last-child)::after {
    content: '·';
    margin-left: var(--s-2);
  }
  .hot {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .chip {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px var(--s-3);
    background: var(--inset);
    color: var(--ink-2);
    font-size: var(--fs-xs);
    min-height: 32px;
  }
  @media (pointer: coarse) {
    .chip {
      min-height: var(--hit, 44px);
    }
  }
  .row:disabled {
    opacity: 0.7;
  }
  .find {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--ink-3);
  }
  .list {
    display: grid;
    gap: var(--s-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    border-radius: var(--r-md);
    background: var(--inset);
  }
  .row {
    display: grid;
    gap: 2px;
    width: 100%;
    text-align: left;
    padding: var(--s-2) var(--s-3);
    min-height: 44px;
  }
  .top {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .tier {
    margin-left: auto;
    color: var(--ink-3);
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tier.hot {
    color: var(--accent);
  }
  .snip {
    color: var(--ink-2);
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }
  .empty,
  .warn {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .warn {
    color: var(--err);
  }
  .editor {
    display: grid;
    gap: var(--s-3);
  }
  .lab {
    display: grid;
    gap: 4px;
    font-size: var(--fs-sm);
    color: var(--ink-2);
  }
  .area {
    resize: vertical;
    min-height: 140px;
    font-family: var(--font-mono);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .path {
    color: var(--ink-3);
    font-size: var(--fs-xs);
    overflow-wrap: anywhere;
  }
  .ok {
    color: var(--ok, var(--accent));
    font-size: var(--fs-sm);
  }
  .danger {
    color: var(--err);
  }
  .edges {
    display: grid;
    gap: var(--s-3);
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  }
  .edges h4 {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-3);
    margin-bottom: 4px;
  }
  .edges ul {
    display: grid;
    gap: 2px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ref {
    font-size: var(--fs-xs);
    overflow-wrap: anywhere;
  }
  .kind {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .ep {
    padding: var(--s-2) var(--s-3);
  }
  .bank {
    font-size: var(--fs-xs);
    color: var(--accent);
  }
  .when {
    margin-left: auto;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .content {
    margin: 4px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--ink-2);
    max-height: 160px;
    overflow: auto;
  }
</style>
