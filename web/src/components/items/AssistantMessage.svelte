<script lang="ts">
  import { copyText } from '../../lib/platform/clipboard';
  import { codeTextFor, renderMarkdown } from '../../lib/render/markdown';
  import type { AssistantItem } from '../../lib/transcript/types';
  import { Icon } from '../../lib/ui';
  import MessageActions from './MessageActions.svelte';

  let { item }: { item: AssistantItem } = $props();

  const html = $derived(renderMarkdown(item.text));
  const stopped = $derived(item.stopReason === 'aborted' && !item.streaming);
  const visible = $derived(item.streaming || item.text.trim() !== '' || Boolean(item.error) || stopped);

  async function onclick(e: MouseEvent) {
    const btn = (e.target as Element).closest('[data-code-copy]');
    if (!btn) return;
    if (await copyText(codeTextFor(btn))) {
      btn.textContent = 'Copied';
      setTimeout(() => {
        if (btn.isConnected) btn.textContent = 'Copy';
      }, 1500);
    }
  }
</script>

{#if visible}
  <MessageActions text={item.text} raw={item.raw} disabled={item.streaming} label="Assistant message">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="doc prose" class:streaming={item.streaming} {onclick}>
      {@html html}
    </div>
    {#if stopped}<p class="note">Stopped</p>{/if}
    {#if item.error}
      <p class="note err" role="status"><Icon name="alert" size={13} /> {item.error}</p>
    {/if}
  </MessageActions>
{/if}

<style>
  .doc {
    min-height: 1.5em;
  }
  .note {
    margin-top: var(--s-2);
    display: flex;
    align-items: center;
    gap: var(--s-1);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .note.err {
    color: var(--err);
  }
</style>
