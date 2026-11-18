<script lang="ts">
  // Read-only sheet listing archived tickets from <cwd>/.omp/kanban/archive.json.
  import { kanban as api } from '../lib/api/endpoints';
  import type { KanbanTicket } from '../lib/api/types';
  import { relativeTime } from '../lib/format';
  import { formatKanbanPriority } from '../lib/state/kanban.svelte';
  import { Loader } from '../lib/state/loader.svelte';
  import { Sheet, Spinner } from '../lib/ui';

  type Props = {
    open: boolean;
    cwd: string;
    onclose: () => void;
  };

  let { open, cwd, onclose }: Props = $props();

  const loader = new Loader<KanbanTicket[]>();

  function load() {
    void loader.run(async () => {
      const res = await api.archiveList(cwd);
      return [...res.tickets].reverse();
    });
  }

  $effect(() => {
    if (open && cwd) load();
  });

  function stamp(iso: string): string {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? relativeTime(ms) : iso;
  }
</script>

<Sheet {open} {onclose} title="Archived tickets" size="md">
  {#if loader.loading && !loader.data}
    <div class="center"><Spinner size={18} label="Loading archive" /></div>
  {:else if loader.error}
    <div class="err-box">
      <p class="err" role="alert">{loader.error}</p>
      <button type="button" class="btn btn-sm" onclick={load}>Retry</button>
    </div>
  {:else if !loader.data?.length}
    <p class="empty">No archived tickets.</p>
  {:else}
    <ul class="list">
      {#each loader.data as t (t.id)}
        <li>
          <div class="meta">
            <span class="id mono">{t.id}</span>
            <span class="prio mono">{formatKanbanPriority(t.priority)}</span>
            <span class="spacer"></span>
            <span class="when">{stamp(t.updated)}</span>
          </div>
          <p class="title">{t.title}</p>
          {#if t.body}
            <p class="body">{t.body}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Sheet>

<style>
  .center {
    display: grid;
    place-items: center;
    padding: var(--s-5);
  }
  .err-box {
    display: grid;
    gap: var(--s-3);
    justify-items: start;
  }
  .err {
    color: var(--err);
    font-size: var(--fs-sm);
  }
  .empty {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .list {
    list-style: none;
    padding: 0;
    display: grid;
  }
  .list li {
    padding: var(--s-2) 0;
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 3px;
  }
  .list li:last-child {
    border-bottom: none;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .id {
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .title {
    color: var(--ink);
    font-weight: 500;
  }
  .body {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
