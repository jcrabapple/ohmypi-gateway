<script lang="ts">
  import { splitInlineCode } from '../format';

  let { text }: { text: string } = $props();
  const parts = $derived(splitInlineCode(text));
</script>

{#each parts as p, i (i)}{#if p.code}<code>{p.text}</code>{:else}{p.text}{/if}{/each}

<style>
  code {
    font: inherit;
    font-family: var(--mono);
    background: none;
    padding: 0;
  }
</style>
