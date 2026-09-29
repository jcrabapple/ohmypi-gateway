<script lang="ts">
  // Raw JSON of one message or tool call, pretty-printed and copyable.
  import type { OverlayProps } from '../lib/overlays';
  import { copyText } from '../lib/platform/clipboard';
  import { ui } from '../lib/state';
  import { Icon, Sheet, toast } from '../lib/ui';

  let { onclose }: OverlayProps = $props();

  /** Circular or exotic values must not break the sheet. */
  function pretty(value: unknown): string {
    if (value === undefined) return '';
    try {
      const seen = new WeakSet<object>();
      return JSON.stringify(
        value,
        (_k, v: unknown) => {
          if (typeof v === 'bigint') return v.toString();
          if (v && typeof v === 'object') {
            if (seen.has(v)) return '[circular]';
            seen.add(v);
          }
          return v;
        },
        2,
      );
    } catch {
      return String(value);
    }
  }

  const text = $derived(pretty(ui.inspecting));
  const lines = $derived(text ? text.split('\n').length : 0);

  async function copy() {
    toast((await copyText(text)) ? 'JSON copied' : 'Could not copy', { kind: 'info' });
  }
</script>

<Sheet open {onclose} title="Raw JSON" size="lg">
  {#if text}
    <div class="bar">
      <span class="count">{lines} {lines === 1 ? 'line' : 'lines'}</span>
      <button type="button" class="btn btn-sm" onclick={copy}><Icon name="copy" size={14} /> Copy</button>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable by keyboard) -->
    <pre class="json mono" tabindex="0" aria-label="Raw JSON">{text}</pre>
  {:else}
    <p class="none">There is no source to show for this item.</p>
  {/if}
</Sheet>

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    margin-bottom: var(--s-2);
  }
  .count {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .json {
    margin: 0;
    padding: var(--s-3) var(--s-4);
    max-height: 60vh;
    overflow: auto;
    border-radius: var(--r-md);
    background: var(--inset);
    font-size: var(--fs-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .none {
    color: var(--ink-3);
  }
</style>
