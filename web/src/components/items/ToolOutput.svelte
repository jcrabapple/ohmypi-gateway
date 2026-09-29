<script lang="ts">
  import { ansiToHtml } from '../../lib/render/ansi';
  import { diffToHtml, looksLikeDiff } from '../../lib/render/diff';
  import { escapeHtml } from '../../lib/render/escape';

  const MAX_LINES = 200;

  let { text, error = false }: { text: string; error?: boolean } = $props();

  let all = $state(false);

  const lines = $derived(text.split('\n'));
  const cut = $derived(!all && lines.length > MAX_LINES);
  const shown = $derived(cut ? lines.slice(0, MAX_LINES).join('\n') : text);
  const html = $derived(
    looksLikeDiff(shown)
      ? diffToHtml(shown)
      : shown.includes('\u001b[')
        ? ansiToHtml(shown)
        : escapeHtml(shown),
  );
</script>

{#if text.trim() === ''}
  <p class="none">No output</p>
{:else}
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped or ansi/diff-rendered by lib/render -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable region must be keyboard focusable) -->
  <pre class="out" class:error tabindex="0" aria-label="Tool output">{@html html}</pre>
  {#if cut}
    <button type="button" class="btn btn-ghost btn-sm more" onclick={() => (all = true)}>
      Show all {lines.length} lines
    </button>
  {/if}
{/if}

<style>
  .out {
    max-height: 360px;
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--s-2) var(--s-3);
    background: var(--inset);
    border-radius: var(--r-md);
    color: var(--ink-2);
    font-size: var(--fs-sm);
    line-height: 1.5;
    white-space: pre;
    scrollbar-width: thin;
    scrollbar-color: var(--line-strong) transparent;
  }
  .out.error {
    color: var(--err);
    box-shadow: 0 0 0 1px var(--err-soft);
  }
  .none {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    padding: var(--s-1) 0;
  }
  .more {
    margin-top: var(--s-2);
  }
</style>
