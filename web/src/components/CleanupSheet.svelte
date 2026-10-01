<script lang="ts">
  // Session cleanup: select saved transcripts to delete, sweep storage litter.
  // Running sessions are never offered; the gateway refuses them anyway (409).
  import { onMount } from 'svelte';
  import { sessions as api } from '../lib/api/endpoints';
  import { pins, sessionsStore } from '../lib/state';
  import { confirm, Sheet, toast } from '../lib/ui';
  import Segmented from '../lib/ui/Segmented.svelte';
  import type { OverlayProps } from '../lib/overlays';
  import type { SavedSession } from '../lib/api/types';

  let { onclose }: OverlayProps = $props();

  let selected = $state(new Set<string>());
  let filter = $state('');
  let olderThan = $state<'any' | 7 | 30 | 90>('any');
  let sweeping = $state(false);
  let sweepNote = $state<string | null>(null);
  let busy = $state(false);

  const AGES: readonly (['any', 'Any'] | [7, '7d'] | [30, '30d'] | [90, '90d'])[] = [
    ['any', 'Any'], [7, '7d'], [30, '30d'], [90, '90d'],
  ];

  const ageOptions = AGES.map(([v, lbl]) => ({ id: String(v), label: lbl }));

  onMount(() => {
    void sessionsStore.refresh();
  });

  const saved = $derived(sessionsStore.saved);

  const visible = $derived.by(() => {
    const f = filter.trim().toLowerCase();
    const cutoff = olderThan === 'any' ? 0 : Date.now() - olderThan * 86400_000;
    return saved.filter((s) => {
      if (s.running) return false;
      // Pinned sessions are never offered for cleanup.
      if (pins.protectedFromCleanup(s.file)) return false;
      if (cutoff && s.mtime * 1000 > cutoff) return false;
      if (f && !(s.title.toLowerCase().includes(f) || s.cwd?.toLowerCase().includes(f) || s.cwdFolder.toLowerCase().includes(f))) return false;
      return true;
    });
  });

  function toggle(file: string): void {
    const next = new Set(selected);
    if (next.has(file)) next.delete(file);
    else next.add(file);
    selected = next;
  }

  function selectVisible(): void {
    const next = new Set(selected);
    for (const s of visible) next.add(s.file);
    selected = next;
  }

  function clearSelection(): void {
    selected = new Set();
  }

  function label(s: SavedSession): string {
    return s.title || s.cwdFolder || s.cwd || s.file;
  }

  function when(s: SavedSession): string {
    return new Date(s.mtime * 1000).toLocaleDateString();
  }

  function size(s: SavedSession): string {
    const kb = s.sizeBytes / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  }

  const eligible = $derived(saved.filter((s) => !s.running));

  async function deleteSelected(): Promise<void> {
    if (busy || selected.size === 0) return;
    const hidden = [...selected].filter((f) => !visible.some((s) => s.file === f)).length;
    const extra = hidden > 0 ? ` (${hidden} currently hidden by filters)` : '';
    const ok = await confirm({
      title: 'Delete saved sessions',
      body: `Permanently delete ${selected.size} session transcript${selected.size === 1 ? '' : 's'}${extra}? This cannot be undone.`,
      confirmLabel: `Delete ${selected.size}`,
    });
    if (!ok) return;
    busy = true;
    let deleted = 0;
    let failed = 0;
    const remaining = new Set(selected);
    for (const file of selected) {
      try {
        await api.deleteSaved(file);
        deleted += 1;
        // A failed delete stays selected so the user can see and retry it.
        remaining.delete(file);
        selected = new Set(remaining);
      } catch {
        failed += 1;
      }
    }
    await sessionsStore.refresh();
    busy = false;
    if (failed) toast(`Deleted ${deleted}, ${failed} failed`, { kind: 'error' });
    else toast(`Deleted ${deleted} session${deleted === 1 ? '' : 's'}`);
  }

  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    sweepNote = null;
    try {
      const out = await api.vacuum();
      sweepNote = `Swept ${out.removedDirs} empty folder${out.removedDirs === 1 ? '' : 's'} and ${out.removedPointers} stale pointer${out.removedPointers === 1 ? '' : 's'}.`;
    } catch (e) {
      sweepNote = e instanceof Error ? e.message : 'Sweep failed';
    } finally {
      sweeping = false;
    }
  }
</script>

<Sheet open={true} {onclose} title="Clean up sessions" size="md">
  <div class="cleanup">
    <p class="hint">
      Delete saved transcripts you no longer want. Running and pinned sessions
      are never offered, and deleting a transcript cannot be undone.
    </p>

    <div class="bar">
      <input
        type="search"
        placeholder="Filter by title or folder…"
        aria-label="Filter saved sessions"
        bind:value={filter}
      />
      <div class="ages">
        <Segmented label="Age filter" value={String(olderThan)} options={ageOptions}
          onchange={(v) => (olderThan = v === 'any' ? 'any' : (Number(v) as 7 | 30 | 90))} />
      </div>
    </div>

    <div class="sel-row">
      <span class="count">{visible.length} of {eligible.length} shown{pins.files.size ? `, ${pins.files.size} pinned` : ''}, {selected.size} selected</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm" onclick={selectVisible}>Select shown</button>
      <button type="button" class="btn btn-sm btn-ghost" onclick={clearSelection}>None</button>
    </div>

    {#if visible.length === 0}
      <p class="empty">Nothing matches.</p>
    {:else}
      <div class="list" role="list" aria-label="Saved sessions">
        {#each visible as s (s.file)}
          <div role="listitem">
            <label class="row">
              <input
                type="checkbox"
                checked={selected.has(s.file)}
                onchange={() => toggle(s.file)}
              />
              <span class="text">
                <span class="title">{label(s)}</span>
                <span class="meta">{s.cwdFolder} · {size(s)} · {when(s)}</span>
              </span>
            </label>
          </div>
        {/each}
      </div>
    {/if}

    <div class="actions">
      <button
        type="button"
        class="btn btn-danger"
        disabled={selected.size === 0 || busy}
        onclick={() => void deleteSelected()}
      >
        {#if busy}Deleting…{:else}Delete {selected.size || ''} selected{/if}
      </button>
      {#if selected.size > 0}
        <span class="danger-note">This permanently removes the transcripts.</span>
      {/if}
    </div>

    <div class="litter">
      <div class="litter-text">
        <span class="litter-title">Storage litter</span>
        <span class="litter-sub">Empty folders and stale pointers omp leaves behind. Never touches transcripts.</span>
        {#if sweepNote}<span class="sweep-note" role="status">{sweepNote}</span>{/if}
      </div>
      <button type="button" class="btn" disabled={sweeping} onclick={() => void sweep()}>
        {#if sweeping}Sweeping…{:else}Sweep{/if}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .cleanup {
    display: grid;
    gap: var(--s-3);
  }
  .hint {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    margin: 0;
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
  .ages {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-md);
    background: var(--inset);
    flex: none;
  }
  .ages :global(.seg button) {
    min-height: 26px;
    font-size: var(--fs-xs);
    padding: 0 var(--s-2);
  }
  .sel-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
  .count {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .spacer {
    flex: 1;
  }
  .empty {
    color: var(--ink-3);
  }
  .list {
    display: grid;
    gap: 2px;
    max-height: 40vh;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: var(--s-1);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-1) var(--s-2);
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .row:hover {
    background: var(--hover);
  }
  .text {
    display: grid;
    min-width: 0;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--s-3);
  }
  .danger-note {
    color: var(--err);
    font-size: var(--fs-xs);
  }
  .litter {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    border-top: 1px solid var(--line);
    padding-top: var(--s-3);
  }
  .litter-text {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .litter-title {
    font-weight: 600;
    font-size: var(--fs-sm);
  }
  .litter-sub {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .sweep-note {
    color: var(--ink-2);
    font-size: var(--fs-xs);
  }
</style>
