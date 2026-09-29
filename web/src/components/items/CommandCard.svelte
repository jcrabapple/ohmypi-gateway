<script lang="ts">
  import { ansiToHtml } from '../../lib/render/ansi';
  import type { CommandItem } from '../../lib/transcript/types';

  let { item }: { item: CommandItem } = $props();

  const title = $derived(item.command?.trim() || 'Command output');
  const html = $derived(ansiToHtml(item.text));
</script>

<section class="card" aria-label={title}>
  <h3 class="mono">{title}</h3>
<!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable region must be keyboard focusable) -->
  <pre tabindex="0">{@html html}</pre>
</section>

<style>
  .card {
    border-radius: var(--r-md);
    box-shadow: var(--ring);
    background: var(--canvas);
    overflow: hidden;
  }
  h3 {
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--line);
    color: var(--ink-2);
    font-size: var(--fs-sm);
    font-weight: 500;
  }
  pre {
    max-height: 360px;
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--s-3);
    font-size: var(--fs-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ink);
  }
</style>
