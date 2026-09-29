<script lang="ts">
  // The states of a remote panel: skeleton while nothing is cached, an error with Retry, or the content.
  import type { Snippet } from 'svelte';
  import { Spinner } from '../../lib/ui';

  type Props = {
    /** True once there is something to show. */
    ready: boolean;
    error: string | null;
    /** A refresh is running behind content that is already on screen. */
    refreshing?: boolean;
    rows?: number;
    onretry: () => void;
    children: Snippet;
  };

  let { ready, error, refreshing = false, rows = 4, onretry, children }: Props = $props();
</script>

{#if ready}
  {@render children()}
  {#if refreshing}<p class="refresh"><Spinner size={11} label="Refreshing" /></p>{/if}
{:else if error}
  <div class="err" role="alert">
    <p>{error}</p>
    <button type="button" class="btn btn-sm" onclick={onretry}>Try again</button>
  </div>
{:else}
  <div class="sk" aria-hidden="true">
    {#each Array.from({ length: rows }, (_, i) => i) as n (n)}
      <span class="skeleton" style:width="{86 - (n % 3) * 14}%"></span>
    {/each}
  </div>
{/if}

<style>
  .sk {
    display: grid;
    gap: var(--s-3);
  }
  .sk .skeleton {
    height: 14px;
  }
  .err {
    display: grid;
    justify-items: start;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4);
    border-radius: var(--r-md);
    background: var(--err-soft);
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .refresh {
    color: var(--ink-3);
  }
</style>
