<script lang="ts">
  import { active, plan, settings } from '../lib/state';
  import { viewport } from '../lib/ui/media.svelte';
  import Icon from '../lib/ui/Icon.svelte';

  const clip = $derived.by(() => {
    const c = plan.activeTask?.content ?? '';
    return c.length > 60 ? `${c.slice(0, 60)}…` : c;
  });

  function open(): void {
    if (viewport.narrow) plan.sheet = true;
    else settings.planPanelOpen = true;
  }
</script>

{#if plan.hasPlan && active.phase === 'ready'}
  <button type="button" class="ribbon" class:blocked={plan.activeTask?.status === 'blocked'} onclick={open}>
    {#if plan.done === plan.total}
      <Icon name="check" size={13} />
      <span class="mono label">All tasks complete</span>
    {:else}
      <Icon name="target" size={13} />
      <span class="mono label">Plan {plan.done}/{plan.total}</span>
      {#if plan.activeTask}
        <span class="task truncate">{clip}</span>
      {/if}
    {/if}
  </button>
{/if}

<style>
  .ribbon {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: 100%;
    min-height: var(--hit);
    margin-bottom: var(--s-3);
    padding: var(--s-1) var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--inset);
    color: var(--ink-3);
    font-size: var(--fs-sm);
    text-align: left;
  }
  .ribbon:hover {
    background: var(--hover);
    color: var(--ink-2);
  }
  .ribbon :global(svg) {
    color: var(--accent);
  }
  .ribbon.blocked :global(svg) {
    color: var(--warn);
  }
  .label {
    flex: none;
    color: var(--ink-2);
    font-weight: 600;
  }
  .task {
    color: var(--ink-3);
  }
  .ribbon.blocked .task {
    color: var(--warn);
  }
</style>
