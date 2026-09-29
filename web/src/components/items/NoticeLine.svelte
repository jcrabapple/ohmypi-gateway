<script lang="ts">
  import type { NoticeItem } from '../../lib/transcript/types';
  import Spinner from '../../lib/ui/Spinner.svelte';

  let { item }: { item: NoticeItem } = $props();
</script>

<p class="notice" class:error={item.level === 'error'} role={item.level === 'error' ? 'status' : undefined}>
  {#if item.active}<Spinner size={11} />{/if}
  <span>{item.text}</span>
</p>

<style>
  .notice {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-2);
    text-align: center;
    color: var(--ink-3);
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }
  .error {
    color: var(--err);
  }
</style>
