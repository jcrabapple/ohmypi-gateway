<script lang="ts">
  // One setting or panel on a page. The `setting-<id>` anchor is what settings search jumps to.
  import type { Snippet } from 'svelte';

  type Props = { id: string; title: string; hint?: string; actions?: Snippet; children: Snippet };

  let { id, title, hint, actions, children }: Props = $props();
</script>

<section id="setting-{id}" class="sec" aria-labelledby="setting-{id}-t">
  <header>
    <div class="text">
      <h3 id="setting-{id}-t">{title}</h3>
      {#if hint}<p class="hint">{hint}</p>{/if}
    </div>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </header>
  {@render children()}
</section>

<style>
  .sec {
    display: grid;
    gap: var(--s-3);
    padding: var(--s-4) 0;
    border-radius: var(--r-md);
  }
  .sec:not(:first-child) {
    border-top: 1px solid var(--line);
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-3);
  }
  h3 {
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .hint {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    margin-top: 2px;
  }
  .actions {
    display: flex;
    gap: var(--s-2);
    flex: none;
  }
  :global(.setting-flash) {
    animation: setting-flash 1.6s var(--ease);
  }
  @keyframes setting-flash {
    0%, 60% {
      background: var(--accent-soft);
      box-shadow: 0 0 0 var(--s-2) var(--accent-soft);
    }
  }
</style>
