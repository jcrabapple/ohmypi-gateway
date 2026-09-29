<script lang="ts">
  import { duration } from '../../lib/format';
  import type { ThinkingItem } from '../../lib/transcript/types';
  import { Icon } from '../../lib/ui';

  let { item }: { item: ThinkingItem } = $props();

  let open = $state(false);
  const uid = $props.id();

  const label = $derived.by(() => {
    if (item.streaming) return 'Thinking';
    if (item.startedAt != null && item.endedAt != null && item.endedAt > item.startedAt) {
      return `Thought for ${duration(item.endedAt - item.startedAt)}`;
    }
    return 'Thought';
  });
</script>

<div class="think">
  <button type="button" class="toggle" aria-expanded={open} aria-controls="{uid}-t" onclick={() => (open = !open)}>
    <Icon name="chevron-right" size={14} class={open ? 'open' : ''} />
    <span class:pulse={item.streaming}>{label}</span>
  </button>
  {#if open}
    <p id="{uid}-t" class="text">{item.text.trim() || 'No thinking text was kept.'}</p>
  {/if}
</div>

<style>
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    min-height: max(28px, var(--hit));
    padding: 0 var(--s-2) 0 0;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .toggle:hover {
    color: var(--ink-2);
  }
  .toggle :global(svg) {
    transition: transform var(--dur) var(--ease);
  }
  .toggle :global(svg.open) {
    transform: rotate(90deg);
  }
  .pulse {
    animation: pulse 1.6s var(--ease) infinite;
  }
  .text {
    margin: 0 0 var(--s-2) 6px;
    padding-left: var(--s-4);
    border-left: 1px solid var(--line-strong);
    color: var(--ink-3);
    font-size: var(--fs-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 320px;
    overflow: auto;
    overscroll-behavior: contain;
  }
  @keyframes pulse {
    50% { opacity: 0.4; }
  }
</style>
