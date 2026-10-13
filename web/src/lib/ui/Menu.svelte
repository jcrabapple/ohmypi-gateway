<script lang="ts">
  // Action list on Adaptive: popover on desktop, action sheet on touch.
  import Adaptive from './Adaptive.svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons';

  export interface MenuItem {
    id: string;
    label: string;
    icon?: IconName;
    danger?: boolean;
    disabled?: boolean;
    /** Makes the item a radio (or a checkbox with `checkbox`): shows a check when true. */
    checked?: boolean;
    checkbox?: boolean;
    onselect: () => void;
  }

  type Props = {
    open: boolean;
    onclose: () => void;
    anchor?: HTMLElement | null;
    title: string;
    items: MenuItem[];
    mode?: 'auto' | 'sheet';
    align?: 'start' | 'end';
  };

  let { open, onclose, anchor = null, title, items, mode = 'auto', align = 'end' }: Props = $props();

  let list: HTMLDivElement | undefined = $state();

  function choose(item: MenuItem) {
    if (item.disabled) return;
    if (item.checkbox) {
      // Checkbox items are multi-select: stay open (focus stays on the item) so
      // several can be toggled in one visit.
      item.onselect();
      return;
    }
    onclose();
    // Let the surface close and focus return before the action opens something else.
    queueMicrotask(item.onselect);
  }

  function key(e: KeyboardEvent) {
    const els = [...(list?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % els.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + els.length) % els.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = els.length - 1;
    if (next < 0) return;
    e.preventDefault();
    els[next]?.focus();
  }
</script>

<Adaptive {open} {onclose} {anchor} {title} {mode} {align} width={232}>
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="menu" role="menu" aria-label={title} bind:this={list} onkeydown={key}>
    {#each items as item (item.id)}
      <button
        type="button"
        role={item.checked === undefined ? 'menuitem' : item.checkbox ? 'menuitemcheckbox' : 'menuitemradio'}
        aria-checked={item.checked}
        class="item hit"
        class:danger={item.danger}
        disabled={item.disabled}
        onclick={() => choose(item)}
      >
        {#if item.icon}<Icon name={item.icon} size={16} />{/if}
        <span class="label">{item.label}</span>
        {#if item.checked}<Icon name="check" size={16} />{/if}
      </button>
    {/each}
  </div>
</Adaptive>

<style>
  .menu {
    display: flex;
    flex-direction: column;
    padding: var(--s-1);
    margin: calc(var(--s-1) * -1);
  }
  .item {
    justify-content: flex-start;
    gap: var(--s-3);
    width: 100%;
    padding: 0 var(--s-3);
    border-radius: var(--r-md);
    color: var(--ink);
    text-align: left;
    min-height: max(var(--hit), 36px);
  }
  .item:hover:not(:disabled),
  .item:focus-visible {
    background: var(--hover);
  }
  .item :global(svg) {
    color: var(--ink-2);
  }
  .label {
    flex: 1;
  }
  .item.danger {
    color: var(--err);
  }
  .item.danger :global(svg) {
    color: inherit;
  }
  @media (max-width: 899.98px) {
    .menu {
      margin: 0;
      padding: 0;
    }
    .item {
      min-height: 48px;
      font-size: var(--fs-lg);
    }
  }
</style>
