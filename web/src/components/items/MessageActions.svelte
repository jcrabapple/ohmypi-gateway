<script lang="ts">
  // Copy and inspect for one message. A hover/focus toolbar for mouse and keyboard; on touch a
  // 500 ms long press opens the same actions in a sheet. Both are off while the message streams.
  import type { Snippet } from 'svelte';
  import { copyText } from '../../lib/platform/clipboard';
  import { busy } from '../../lib/actions.svelte';
  import { active, ui } from '../../lib/state';
  import { Icon, Menu, toast, type MenuItem } from '../../lib/ui';
  import { longpress } from '../../lib/ui/actions';
  import { tap } from '../../lib/platform/haptics';

  type Props = {
    /** Text that Copy puts on the clipboard. */
    text: string;
    raw?: unknown;
    disabled?: boolean;
    align?: 'start' | 'end';
    label: string;
    /** Forks the session at this message; present only where a fork makes sense. */
    onfork?: () => void;
    children: Snippet;
  };

  let { text, raw, disabled = false, align = 'end', label, onfork, children }: Props = $props();

  let copied = $state(false);
  let sheet = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy(quiet = false) {
    if (!(await copyText(text))) {
      ui.error('Could not copy');
      return;
    }
    if (quiet) toast('Copied');
    copied = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1500);
  }

  const items = $derived<MenuItem[]>([
    // Same guard as the header menu: no fork while a turn runs or one is in flight.
    ...(onfork ? [{
      id: 'fork', label: 'Fork from here', icon: 'fork',
      disabled: busy.forking || active.running, onselect: onfork,
    } satisfies MenuItem] : []),
    { id: 'copy', label: 'Copy', icon: 'copy', disabled: !text, onselect: () => copy(true) },
    { id: 'inspect', label: 'Inspect', icon: 'terminal', disabled: raw === undefined, onselect: () => ui.inspect(raw) },
  ]);
</script>

<div
  class="frame {align}"
  use:longpress={{ onlongpress: () => { tap(); sheet = true; }, disabled }}
>
  {@render children()}
  {#if !disabled}
    <div class="tools" role="toolbar" aria-label="{label} actions">
      <button type="button" class="icon-btn" aria-label="Copy" title="Copy" disabled={!text} onclick={() => copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </button>
      <button
        type="button"
        class="icon-btn"
        aria-label="Inspect"
        title="Inspect"
        disabled={raw === undefined}
        onclick={() => ui.inspect(raw)}
      >
        <Icon name="terminal" size={15} />
      </button>
    </div>
  {/if}
</div>
<Menu open={sheet} onclose={() => (sheet = false)} title={label} {items} mode="sheet" />

<style>
  .frame {
    position: relative;
    -webkit-touch-callout: none;
  }
  .tools {
    position: absolute;
    top: calc(var(--s-1) * -1);
    display: flex;
    gap: 2px;
    padding: 2px;
    background: var(--surface);
    border-radius: var(--r-md);
    box-shadow: var(--ring);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--dur-fast) var(--ease);
    z-index: 2;
  }
  .end .tools {
    right: 0;
  }
  .start .tools {
    left: 0;
  }
  .tools .icon-btn {
    min-width: 28px;
    min-height: 28px;
  }
  .frame:hover .tools,
  .frame:focus-within .tools {
    opacity: 1;
    pointer-events: auto;
  }
  @media (pointer: coarse) {
    .tools {
      display: none;
    }
  }
</style>
