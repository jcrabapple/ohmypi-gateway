<script lang="ts">
  // Renders `ui.confirmRequest`. Ask with `confirm()` from lib/ui, never by mounting this.
  import { ui } from '../state/ui.svelte';
  import Sheet from './Sheet.svelte';

  const req = $derived(ui.confirmRequest);
</script>

<Sheet open={req !== null} onclose={() => ui.answerConfirm(false)} title={req?.title ?? ''} size="sm">
  {#if req?.body}<p class="body">{req.body}</p>{/if}
  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={() => ui.answerConfirm(false)}>Cancel</button>
    <button
      type="button"
      class="btn"
      class:btn-primary={!req?.danger}
      class:danger={req?.danger}
      onclick={() => ui.answerConfirm(true)}
    >
      {req?.confirmLabel}
    </button>
  {/snippet}
</Sheet>

<style>
  .body {
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .danger {
    background: var(--err);
    color: var(--bg);
    box-shadow: none;
    font-weight: 600;
  }
  .danger:hover:not(:disabled) {
    background: var(--err);
    filter: brightness(1.1);
  }
</style>
