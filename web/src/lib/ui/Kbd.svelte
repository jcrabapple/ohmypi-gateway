<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<kbd>{@render children()}</kbd>

<style>
  kbd {
    display: inline-flex;
    align-items: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    justify-content: center;
    border-radius: var(--r-sm);
    background: var(--inset);
    box-shadow: var(--ring);
    color: var(--ink-2);
    font: 500 var(--fs-xs) var(--mono);
  }
</style>
