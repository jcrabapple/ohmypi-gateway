<script lang="ts">
  // Per-session Changes page: every file the session touched, latest diff per
  // path, with one global Unified|Split toggle. Created files stay unified.
  import { collectChanges } from '../lib/transcript/changes';
  import type { Item } from '../lib/transcript/types';
  import { nav } from '../lib/state';
  import { Icon, Segmented } from '../lib/ui';
  import DiffBlock from './items/DiffBlock.svelte';

  type Mode = 'unified' | 'split';

  let { gwId, items }: { gwId: string; items: readonly Item[] } = $props();

  const MODES: readonly { id: Mode; label: string }[] = [
    { id: 'unified', label: 'Unified' },
    { id: 'split', label: 'Split' },
  ];

  let mode = $state<Mode>('unified');
  const rollup = $derived(collectChanges(items));
</script>

<div class="changes">
  <div class="bar">
    <button type="button" class="btn btn-ghost btn-sm back" onclick={() => nav.open(gwId)}>
      <Icon name="arrow-left" size={15} />
      Back to session
    </button>
    <h2 class="title">Changes</h2>
    <span class="counts" role="status">
      {rollup.files}
      {rollup.files === 1 ? 'file' : 'files'} ·
      {rollup.edits}
      {rollup.edits === 1 ? 'edit' : 'edits'}
      <span class="adds mono">+{rollup.adds}</span>
      <span class="dels mono">-{rollup.dels}</span>
    </span>
    {#if rollup.groups.length > 0}
      <Segmented label="Diff mode" value={mode} options={MODES} onchange={(v) => (mode = v)} />
    {/if}
  </div>

  <div class="list">
    {#if rollup.groups.length === 0}
      <p class="none">No file changes in this session yet.</p>
    {:else}
      {#each rollup.groups as g (g.path)}
        <DiffBlock file={g.file} {mode} />
      {/each}
    {/if}
  </div>
</div>

<style>
  .changes {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-width: 0;
    background: var(--canvas);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    width: min(100%, var(--reading-w));
    margin: 0 auto;
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--line);
  }
  .back {
    flex: none;
    min-width: 0;
  }
  .title {
    font-size: var(--fs-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0;
  }
  .counts {
    flex: 1;
    min-width: 0;
    color: var(--ink-3);
    font-size: var(--fs-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .counts .adds {
    color: var(--ansi-2);
  }
  .counts .dels {
    color: var(--ansi-1);
  }
  .list {
    overflow-y: auto;
    overscroll-behavior: contain;
    width: min(100%, var(--reading-w));
    margin: 0 auto;
    padding: var(--s-3);
    display: grid;
    gap: var(--s-3);
    align-content: start;
  }
  .none {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  @media (max-width: 600px) {
    .title {
      display: none;
    }
  }
</style>
