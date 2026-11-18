<script lang="ts">
  // Sheet to open or initialize a kanban board in any host folder (recent session cwds or directory browser).
  import { browseDirs } from '../lib/api/endpoints';
  import type { FsDirs } from '../lib/api/types';
  import { basename, uniqueCwds } from '../lib/format';
  import { kanbanStore } from '../lib/state/kanban.svelte';
  import { sessionsStore } from '../lib/state';
  import { Icon, Sheet, Spinner } from '../lib/ui';

  type Props = {
    open: boolean;
    onclose: () => void;
    onopen: (cwd: string) => void;
  };

  let { open, onclose, onopen }: Props = $props();

  let cwd = $state('');
  let browsing = $state(false);
  let browse = $state<FsDirs | null>(null);
  let browseLoading = $state(false);
  let browseError = $state<string | null>(null);
  let browseSeq = 0;
  const uid = $props.id();

  const recent = $derived.by(() => {
    const existing = new Set(kanbanStore.boards.map((b) => b.cwd));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of uniqueCwds(sessionsStore.live)) {
      if (!existing.has(c) && !seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
    for (const s of sessionsStore.saved) {
      const c = s.cwd;
      if (c && !existing.has(c) && !seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
    return out.slice(0, 8);
  });

  $effect(() => {
    if (!open) return;
    cwd = '';
    browsing = false;
    browse = null;
    browseError = null;
  });

  async function loadDir(path: string) {
    const seq = ++browseSeq;
    browseLoading = true;
    browseError = null;
    try {
      const res = await browseDirs(path);
      if (seq === browseSeq) browse = res;
    } catch (err) {
      if (seq === browseSeq) browseError = err instanceof Error ? err.message : 'Could not open that folder';
    } finally {
      if (seq === browseSeq) browseLoading = false;
    }
  }

  function pick(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    onclose();
    onopen(trimmed);
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    pick(cwd);
  }
</script>

<Sheet {open} {onclose} title="Open project board" size="md">
  <form id="{uid}-form" class="form" onsubmit={submit}>
    <div class="group">
      <label class="lbl" for="{uid}-cwd">Project folder</label>
      <div class="row">
        <input
          id="{uid}-cwd"
          class="field mono"
          type="text"
          placeholder="~/projects/my-project"
          bind:value={cwd}
        />
        <button
          type="button"
          class="btn"
          onclick={() => {
            if (browsing) browsing = false;
            else {
              browsing = true;
              void loadDir(cwd.trim());
            }
          }}
        >
          {browsing ? 'Hide' : 'Browse'}
        </button>
      </div>
    </div>

    {#if browsing}
      <div class="browser" role="region" aria-label="Folder picker">
        <div class="bbar">
          <button
            type="button"
            class="icon-btn"
            aria-label="Parent folder"
            disabled={!browse?.parent || browseLoading}
            onclick={() => browse?.parent && loadDir(browse.parent)}
          >
            <Icon name="arrow-up" size={16} />
          </button>
          <span class="bpath mono truncate">{browse?.path ?? 'Loading'}</span>
          <button
            type="button"
            class="btn btn-sm"
            disabled={!browse || browseLoading}
            onclick={() => browse && ((cwd = browse.path), (browsing = false))}
          >
            Use folder
          </button>
        </div>
        {#if browseError}
          <p class="berr" role="alert">{browseError}</p>
        {:else if browseLoading && !browse}
          <div class="bspin"><Spinner size={16} label="Loading folders" /></div>
        {:else if browse}
          <div class="blist">
            {#each browse.dirs as d (d.path)}
              <button type="button" class="dir" onclick={() => loadDir(d.path)}>
                <Icon name="chevron-right" size={14} />
                <span class="truncate">{d.name}</span>
              </button>
            {:else}
              <p class="bempty">No subfolders.</p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if recent.length}
      <div class="group">
        <span class="lbl">Recent folders</span>
        <div class="recent">
          {#each recent as c (c)}
            <button type="button" class="recent-row" onclick={() => pick(c)}>
              <span class="rname">{basename(c) || c}</span>
              <span class="rcwd mono truncate">{c}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </form>

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={onclose}>Cancel</button>
    <button type="submit" form="{uid}-form" class="btn btn-primary" disabled={!cwd.trim()}>Open</button>
  {/snippet}
</Sheet>

<style>
  .form {
    display: grid;
    gap: var(--s-4);
  }
  .group {
    display: grid;
    gap: var(--s-1);
    min-width: 0;
  }
  .lbl {
    font-size: var(--fs-sm);
    color: var(--ink-2);
    font-weight: 500;
  }
  .row {
    display: flex;
    gap: var(--s-2);
  }
  .row .field {
    flex: 1;
    min-width: 0;
  }
  .browser {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-2);
    border-radius: var(--r-md);
    background: var(--inset);
    box-shadow: var(--ring);
  }
  .bbar {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
  }
  .bpath {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-xs);
    color: var(--ink-2);
  }
  .berr {
    color: var(--err);
    font-size: var(--fs-sm);
    padding: var(--s-1) var(--s-2);
  }
  .bspin {
    display: grid;
    place-items: center;
    padding: var(--s-3);
  }
  .blist {
    display: grid;
    max-height: 200px;
    overflow-y: auto;
  }
  .dir {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-height: var(--hit);
    padding: 0 var(--s-2);
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--ink);
  }
  .dir:hover {
    background: var(--hover);
  }
  .bempty {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    padding: var(--s-2);
  }
  .recent {
    display: grid;
    gap: var(--s-1);
  }
  .recent-row {
    display: grid;
    gap: 2px;
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    background: var(--inset);
    box-shadow: var(--ring);
    text-align: left;
    min-height: var(--hit);
  }
  .recent-row:hover {
    background: var(--hover);
  }
  .rname {
    color: var(--ink);
    font-weight: 500;
  }
  .rcwd {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
</style>
