<script lang="ts">
  import type { UserItem } from '../../lib/transcript/types';
  import { Icon } from '../../lib/ui';
  import MessageActions from './MessageActions.svelte';

  let { item }: { item: UserItem } = $props();

  const NOTE: Record<string, string> = { steer: 'Steering', queued: 'Queued', 'other-client': 'From another device' };
  const note = $derived(item.note ? NOTE[item.note] : '');
</script>

<div class="row">
  <MessageActions text={item.text} raw={item.raw} label="Your message" align="start">
    <div class="bubble" class:pending={item.pending} class:failed={item.failed}>
      {#if item.text}<p>{item.text}</p>{/if}
      {#if item.images > 0}
        <span class="imgs"><Icon name="image" size={14} /> {item.images} {item.images === 1 ? 'image' : 'images'}</span>
      {/if}
    </div>
  </MessageActions>
  {#if item.failed}
    <p class="note err" role="status"><Icon name="alert" size={13} /> Not sent{item.error ? `: ${item.error}` : ''}</p>
  {:else if item.pending}
    <p class="note"><span class="sr-only">Sending</span><span aria-hidden="true">Sending</span></p>
  {:else if note}
    <p class="note">{note}</p>
  {/if}
</div>

<style>
  .row {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--s-1);
    max-width: 100%;
  }
  .row :global(.frame) {
    max-width: min(85%, 640px);
  }
  .bubble {
    padding: var(--s-2) var(--s-4);
    background: var(--surface);
    border-radius: var(--r-lg) var(--r-lg) var(--r-sm) var(--r-lg);
    box-shadow: var(--ring);
    overflow-wrap: anywhere;
    transition: opacity var(--dur) var(--ease);
  }
  .bubble.pending {
    opacity: 0.6;
  }
  .bubble.failed {
    box-shadow: 0 0 0 1px var(--err);
  }
  p {
    white-space: pre-wrap;
  }
  .imgs {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    margin-top: var(--s-1);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .note {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .note.err {
    color: var(--err);
  }
</style>
