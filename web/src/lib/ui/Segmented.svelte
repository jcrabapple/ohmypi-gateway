<script lang="ts" generics="T extends string">
  // A short row of mutually exclusive choices. Arrow keys move and choose, like a native radio group.
  type Props = {
    label: string;
    value: T;
    options: readonly { id: T; label: string }[];
    onchange: (value: T) => void;
  };

  let { label, value, options, onchange }: Props = $props();

  let group: HTMLDivElement | undefined = $state();

  function key(e: KeyboardEvent) {
    const i = options.findIndex((o) => o.id === value);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onchange(options[next]!.id);
    group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus (roving tabindex lives on the radios) -->
<div class="seg" role="radiogroup" aria-label={label} bind:this={group} onkeydown={key}>
  {#each options as o (o.id)}
    <button
      type="button"
      role="radio"
      aria-checked={o.id === value}
      tabindex={o.id === value ? 0 : -1}
      class:on={o.id === value}
      onclick={() => onchange(o.id)}
    >
      {o.label}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    border-radius: var(--r-md);
    background: var(--inset);
    box-shadow: var(--ring);
  }
  button {
    min-height: max(28px, var(--hit));
    padding: 0 var(--s-4);
    border-radius: calc(var(--r-md) - 2px);
    color: var(--ink-2);
    font-weight: 500;
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  button:hover:not(.on) {
    background: var(--hover);
    color: var(--ink);
  }
  button.on {
    background: var(--accent);
    color: var(--accent-ink);
  }
</style>
