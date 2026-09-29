<script lang="ts">
  import { duration } from '../../lib/format';
  import { copyText } from '../../lib/platform/clipboard';
  import type { ToolItem } from '../../lib/transcript/types';
  import { ui } from '../../lib/state';
  import { Icon, toast } from '../../lib/ui';
  import ToolOutput from './ToolOutput.svelte';

  let { tools }: { tools: ToolItem[] } = $props();

  let openIds = $state<Record<string, boolean>>({});
  const uid = $props.id();

  function toggle(id: string) {
    openIds[id] = !openIds[id];
  }

  function took(t: ToolItem): string {
    return t.startedAt != null && t.endedAt != null ? duration(t.endedAt - t.startedAt) : '';
  }

  const STATUS: Record<ToolItem['status'], string> = {
    running: 'Running',
    done: 'Done',
    error: 'Failed',
    interrupted: 'Interrupted',
  };

  async function copyOut(t: ToolItem) {
    if (await copyText(t.output)) toast('Copied');
  }
</script>

<div class="group" role="list" aria-label="Tool calls">
  {#each tools as t (t.id)}
    {@const open = openIds[t.id] === true}
    <div class="tool" role="listitem" class:error={t.status === 'error'}>
      <button
        type="button"
        class="line"
        aria-expanded={open}
        aria-controls="{uid}-{t.id}"
        onclick={() => toggle(t.id)}
      >
        <span class="status {t.status}" title={STATUS[t.status]}>
          {#if t.status === 'running'}
            <span class="spinner" aria-hidden="true"></span>
          {:else if t.status === 'error'}
            <Icon name="alert" size={15} />
          {:else if t.status === 'interrupted'}
            <Icon name="stop" size={13} />
          {:else}
            <Icon name="check" size={15} />
          {/if}
          <span class="sr-only">{STATUS[t.status]}</span>
        </span>
        <span class="name mono">{t.toolName}</span>
        <span class="summary truncate" class:mono={!t.intent}>{t.summary}</span>
        <span class="dur mono">{took(t)}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} class="chev" />
      </button>
      {#if open}
        <div class="detail" id="{uid}-{t.id}">
          <ToolOutput text={t.output} error={t.status === 'error'} />
          <div class="acts">
            <button type="button" class="btn btn-ghost btn-sm" disabled={!t.output} onclick={() => copyOut(t)}>Copy output</button>
            <button type="button" class="btn btn-ghost btn-sm" disabled={t.raw === undefined} onclick={() => ui.inspect(t.raw)}>
              Inspect
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .group {
    border-radius: var(--r-md);
    box-shadow: var(--ring);
    background: var(--canvas);
    overflow: hidden;
  }
  .tool + .tool {
    border-top: 1px solid var(--line);
  }
  .line {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    width: 100%;
    min-height: max(36px, var(--hit));
    padding: 0 var(--s-3);
    text-align: left;
    font-size: var(--fs-sm);
    transition: background var(--dur-fast) var(--ease);
  }
  .line:hover {
    background: var(--hover);
  }
  .line:focus-visible {
    outline-offset: -2px;
  }
  .status {
    flex: none;
    width: 16px;
    display: grid;
    place-items: center;
    color: var(--ink-3);
  }
  .status.error {
    color: var(--err);
  }
  .status .spinner {
    width: 12px;
    height: 12px;
  }
  .name {
    flex: none;
    color: var(--ink);
    font-weight: 500;
  }
  .summary {
    flex: 1;
    color: var(--ink-2);
  }
  .dur {
    flex: none;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .line :global(.chev) {
    color: var(--ink-3);
  }
  .detail {
    padding: 0 var(--s-3) var(--s-3);
  }
  .acts {
    display: flex;
    gap: var(--s-1);
    margin-top: var(--s-2);
  }
</style>
